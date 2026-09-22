import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { budgetReviewEvidence, budgetReviewSummary, type BudgetReviewEvidence } from '@xingzhi/contracts';
import { notFound } from './errors.js';

function compactRef(value: string) {
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function idempotencyRef(value: string | null | undefined) {
  return value ? `idem:${createHash('sha256').update(value).digest('hex').slice(0, 12)}` : null;
}

function safeUuid(value: unknown) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value : null;
}

export async function requireBudgetReviewScope(client: PoolClient, reviewerId: string, periodId: string) {
  const scope = await client.query(`SELECT 1 FROM budget_review_scopes
    WHERE reviewer_id=$1 AND period_id=$2`, [reviewerId, periodId]);
  if (!scope.rowCount) notFound('未找到可审核的预算周期。');
}

export async function listBudgetReviews(client: PoolClient, reviewerId: string) {
  const rows = (await client.query(`SELECT p.id AS "periodId",to_char(p.month_start,'YYYY-MM-DD') AS "monthStart",
      to_char(p.month_end,'YYYY-MM-DD') AS "monthEnd",p.status,p.version::integer AS "periodVersion",
      p.savings_target_minor::integer AS "savingsTargetMinor",a.source AS "accountSource",
      a.status AS "accountStatus",p.updated_at AS "updatedAt"
    FROM budget_review_scopes s JOIN budget_periods p ON p.id=s.period_id
    JOIN finance_accounts a ON a.id=p.primary_account_id
    WHERE s.reviewer_id=$1 ORDER BY p.month_start DESC,p.id`, [reviewerId])).rows;
  return rows.map(row => budgetReviewSummary.parse(row));
}

export async function readBudgetReviewEvidence(client: PoolClient, reviewerId: string, periodId: string) {
  await requireBudgetReviewScope(client, reviewerId, periodId);
  const periodRow = (await client.query(`SELECT p.id AS "periodId",to_char(p.month_start,'YYYY-MM-DD') AS "monthStart",
      to_char(p.month_end,'YYYY-MM-DD') AS "monthEnd",p.status,p.version::integer AS "periodVersion",
      p.savings_target_minor::integer AS "savingsTargetMinor",a.source AS "accountSource",
      a.status AS "accountStatus",p.updated_at AS "updatedAt"
    FROM budget_periods p JOIN finance_accounts a ON a.id=p.primary_account_id WHERE p.id=$1`, [periodId])).rows[0];
  const period = budgetReviewSummary.parse(periodRow);
  const orderRows = (await client.query(`SELECT o.id AS "orderId",i.id AS "purchaseIntentId",i.quote_id AS "quoteId",
      CASE WHEN m.order_id IS NULL THEN 'unresolved' ELSE 'captured' END AS "merchantAssignment",
      o.amount_minor::integer AS "amountMinor",o.refunded_minor::integer AS "refundedMinor",o.currency,
      o.environment,o.provider,o.status,o.payment_status AS "paymentStatus",i.confirmed_at AS "confirmedAt",
      i.financial_version::integer AS "financialVersion",i.period_version::integer AS "periodVersion",
      i.quote_version::integer AS "quoteVersion",o.created_at AS "createdAt",o.updated_at AS "updatedAt",
      i.idempotency_key AS "idempotencyKey"
    FROM orders o JOIN purchase_intents i ON i.id=o.purchase_intent_id
    LEFT JOIN consumer_order_merchants m ON m.order_id=o.id
    WHERE o.budget_period_id=$1 ORDER BY o.created_at,o.id`, [periodId])).rows;
  const orders = orderRows.map(({ idempotencyKey: _hidden, ...row }) => budgetReviewEvidence.shape.orders.element.parse(row));
  const keyByOrder = new Map(orderRows.map(row => [row.orderId as string, idempotencyRef(row.idempotencyKey as string)]));
  const moneyEvents = (await client.query(`SELECT e.id AS "eventId",e.order_id AS "orderId",e.event_type AS "eventType",
      e.amount_minor::integer AS "amountMinor",e.verification_state AS "verificationState",e.source,
      e.applied_ledger_entry_id AS "ledgerEntryId",e.occurred_at AS "observedAt"
    FROM finance_money_events e JOIN orders o ON o.id=e.order_id
    WHERE o.budget_period_id=$1 ORDER BY e.occurred_at,e.id`, [periodId])).rows;
  const operationRows = (await client.query(`SELECT op.id AS "operationId",op.entity_id AS "entityId",op.type,op.state,
      op.attempt_count::integer AS "attemptCount",CASE
        WHEN op.type IN ('simulate_refund_batch','sandbox_refund','sandbox_refund_recheck') THEN rb.business_number
        WHEN op.type IN ('simulate_payment','sandbox_payment_handoff','sandbox_payment_recheck','simulate_close','sandbox_close')
          THEN pa.business_number
        ELSE NULL
      END AS "businessNumber",
      COALESCE(direct_order.id,cancellation_order.order_id,rb.order_id) AS "orderId",
      op.created_at AS "createdAt",op.updated_at AS "updatedAt"
    FROM operations op
    LEFT JOIN orders direct_order ON direct_order.id=op.entity_id
    LEFT JOIN cancellation_requests cancellation_order ON cancellation_order.id=op.entity_id
    LEFT JOIN refund_batches rb ON rb.id=op.entity_id
    LEFT JOIN payment_attempts pa ON pa.order_id=COALESCE(direct_order.id,cancellation_order.order_id,rb.order_id)
    WHERE op.budget_period_id=$1 ORDER BY op.created_at,op.id`, [periodId])).rows;
  const operations = operationRows.map(row => ({ operationId: row.operationId, entityId: row.entityId,
    type: row.type, state: row.state, attemptCount: row.attemptCount,
    businessNumberRef: row.businessNumber ? compactRef(String(row.businessNumber)) : null,
    idempotencyRecordRef: keyByOrder.get(String(row.orderId)) ?? null,
    createdAt: row.createdAt, updatedAt: row.updatedAt }));
  const eventRows = (await client.query(`SELECT e.id::text AS "referenceId",e.type,e.data,e.created_at AS "observedAt",
      u.role AS "actorRole",u.id AS "actorId" FROM budget_events e
    LEFT JOIN users u ON u.id=e.actor_id WHERE e.period_id=$1 ORDER BY e.id`, [periodId])).rows;
  const timeline = eventRows.map(row => {
    const data = row.data && typeof row.data === 'object' ? row.data as Record<string, unknown> : {};
    const amount = data.amountMinor;
    return { referenceId: row.referenceId, type: row.type, observedAt: row.observedAt,
      actorRole: row.actorRole ?? (row.actorId ? 'unknown' : 'system'),
      actorRef: row.actorId ? compactRef(String(row.actorId)) : null,
      orderId: safeUuid(data.orderId), operationId: safeUuid(data.operationId),
      state: typeof data.state === 'string' ? data.state : null,
      amountMinor: typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0 ? amount : null,
      source: typeof data.source === 'string' ? data.source : null };
  });
  const missingEvidence: string[] = [];
  if (orders.some(order => order.merchantAssignment === 'unresolved')) {
    missingEvidence.push('部分历史新订单没有可核验的建单时商户归属。');
  }
  if (orders.some(order => order.paymentStatus === 'unknown')) {
    missingEvidence.push('部分付款结果仍为未知，不能视为已入账。');
  }
  const evidence = { version: 1 as const, generatedAt: new Date(), period, orders,
    moneyEvents, operations, timeline, missingEvidence };
  return budgetReviewEvidence.parse(evidence);
}

function htmlEscape(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export async function createBudgetEvidenceExport(client: PoolClient, reviewerId: string,
  periodId: string, format: 'json' | 'html') {
  const evidence = await readBudgetReviewEvidence(client, reviewerId, periodId);
  const json = JSON.stringify(evidence, null, 2);
  const content = format === 'json' ? json
    : `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>行止预算审核证据</title>`
      + `<body><h1>行止预算审核证据</h1><p>周期 ${htmlEscape(periodId)}</p><pre>${htmlEscape(json)}</pre></body></html>`;
  const exportId = randomUUID();
  await client.query(`INSERT INTO budget_evidence_exports(id,period_id,requester_id,format,content,expires_at)
    VALUES($1,$2,$3,$4,$5,now()+interval '24 hours')`, [exportId, periodId, reviewerId, format, content]);
  const row = (await client.query(`SELECT id AS "exportId",period_id AS "periodId",format,
      created_at AS "createdAt",expires_at AS "expiresAt" FROM budget_evidence_exports WHERE id=$1`, [exportId])).rows[0];
  return { ...row, downloadUrl: `/api/reviewer/evidence-exports/${exportId}` };
}

export async function readBudgetEvidenceExport(client: PoolClient, reviewerId: string, exportId: string) {
  const row = (await client.query<{ periodId: string; format: 'json' | 'html'; content: string }>(`
    SELECT e.period_id AS "periodId",e.format,e.content FROM budget_evidence_exports e
    JOIN budget_review_scopes s ON s.period_id=e.period_id AND s.reviewer_id=$2
    WHERE e.id=$1 AND e.requester_id=$2 AND e.expires_at>now()`, [exportId, reviewerId])).rows[0];
  if (!row) notFound('未找到可下载的审核证据。');
  return row;
}

export type { BudgetReviewEvidence };
