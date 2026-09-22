import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  merchantCancellation, merchantManualTask, merchantOrderDetail, merchantOrderSummary,
  merchantRefundBatch, type MerchantDecisionInput, type MerchantTaskActionInput,
} from '@xingzhi/contracts';
import { cancellationRuleDetails, initialDecisionForRule, type CancellationRule } from './aftercare.js';
import { AppError, notFound } from './errors.js';
import { createOperation, createOperationJob } from './jobs.js';
import { applyVerifiedMoneyEvent } from './verified-money-event.js';
import { sandboxReadiness } from '../payment/alipay-sandbox.js';

const ownedOrder = `EXISTS (SELECT 1 FROM consumer_order_merchants assignment
  WHERE assignment.order_id=o.id AND assignment.merchant_id=$1)`;

export async function listMerchantConsumerOrders(client: PoolClient, merchantId: string, orderId?: string) {
  const rows = (await client.query(`SELECT o.id,'consumer' AS scope,NULL::uuid AS "planId",
      o.budget_period_id AS "budgetPeriodId",o.item_name AS "itemName",o.amount_minor::integer AS "amountMinor",
      o.refunded_minor::integer AS "refundedMinor",o.payment_status AS "paymentStatus",o.status,
      o.environment,u.display_name AS consumer,o.created_at AS "createdAt"
    FROM orders o JOIN users u ON u.id=o.owner_id
    WHERE o.purchase_intent_id IS NOT NULL AND ${ownedOrder} AND ($2::uuid IS NULL OR o.id=$2)
    ORDER BY o.created_at DESC,o.id`, [merchantId, orderId ?? null])).rows;
  return rows.map(row => merchantOrderSummary.parse(row));
}

export async function listMerchantConsumerCancellations(client: PoolClient, merchantId: string,
  options: { orderId?: string; cancellationId?: string } = {}) {
  const rows = (await client.query(`SELECT c.id,'consumer' AS scope,NULL::uuid AS "planId",
      o.budget_period_id AS "budgetPeriodId",c.order_id AS "orderId",o.item_name AS "itemName",
      o.amount_minor::integer AS "amountMinor",o.payment_status AS "paymentStatus",o.status AS "orderStatus",
      u.display_name AS consumer,c.accepted_fee_minor::integer AS "acceptedFeeMinor",
      c.accepted_refund_minor::integer AS "acceptedRefundMinor",c.rule_version AS "ruleVersion",
      c.rule_preset AS "rulePreset",c.status,c.decision,c.decision_reason AS "decisionReason",
      c.decided_at AS "decidedAt",c.created_at AS "createdAt",c.updated_at AS "updatedAt",
      COALESCE(SUM(b.amount_minor) FILTER(WHERE b.status='succeeded'),0)::integer AS "refundedMinor",
      COALESCE(SUM(b.amount_minor) FILTER(WHERE b.status IN ('pending','processing','unknown','pending_review')),0)::integer AS "pendingRefundMinor",
      COUNT(b.id)::integer AS "batchCount"
    FROM cancellation_requests c JOIN orders o ON o.id=c.order_id JOIN users u ON u.id=o.owner_id
    LEFT JOIN refund_batches b ON b.cancellation_request_id=c.id
    WHERE ${ownedOrder} AND ($2::uuid IS NULL OR o.id=$2) AND ($3::uuid IS NULL OR c.id=$3)
    GROUP BY c.id,o.id,u.display_name ORDER BY c.updated_at DESC,c.id`,
  [merchantId, options.orderId ?? null, options.cancellationId ?? null])).rows;
  return rows.map(row => merchantCancellation.parse(row));
}

export async function listMerchantConsumerRefunds(client: PoolClient, merchantId: string, cancellationId: string) {
  if (!(await listMerchantConsumerCancellations(client, merchantId, { cancellationId }))[0]) {
    notFound('未找到本商户的新订单取消申请。');
  }
  const rows = (await client.query(`SELECT id,operation_id AS "operationId",business_number AS "businessNumber",
      batch_number AS "batchNumber",amount_minor::integer AS "amountMinor",status,environment,provider,
      created_at AS "createdAt",updated_at AS "updatedAt"
    FROM refund_batches WHERE cancellation_request_id=$1 ORDER BY batch_number`, [cancellationId])).rows;
  return rows.map(row => merchantRefundBatch.parse(row));
}

export async function listMerchantConsumerTasks(client: PoolClient, merchantId: string) {
  const rows = (await client.query(`SELECT t.id,t.type,t.state,'consumer' AS scope,NULL::uuid AS "planId",
      t.budget_period_id AS "budgetPeriodId",t.order_id AS "orderId",
      t.cancellation_request_id AS "cancellationRequestId",t.refund_batch_id AS "refundBatchId",
      t.operation_id AS "operationId",t.reason,t.next_action AS "nextAction",t.next_review_at AS "nextReviewAt",
      t.claimed_by AS "claimedBy",t.claimed_at AS "claimedAt",t.last_note AS "lastNote",
      t.created_at AS "createdAt",t.updated_at AS "updatedAt"
    FROM manual_tasks t JOIN orders o ON o.id=t.order_id
    WHERE t.budget_period_id IS NOT NULL AND t.budget_period_id=o.budget_period_id AND ${ownedOrder}
    ORDER BY t.state,t.next_review_at,t.id`, [merchantId])).rows;
  return rows.map(row => merchantManualTask.parse(row));
}

export async function readMerchantConsumerOrder(client: PoolClient, merchantId: string, orderId: string) {
  const order = (await listMerchantConsumerOrders(client, merchantId, orderId))[0];
  if (!order) notFound('未找到本商户的新订单。');
  const confirmation = (await client.query(`SELECT i.id AS "purchaseIntentId",NULL::uuid AS "confirmationId",
      i.quote_id AS "quoteId",i.financial_version::integer AS "financialVersion",
      i.period_version::integer AS "periodVersion",i.quote_version::integer AS "quoteVersion",
      i.accepted_amount_minor::integer AS "acceptedAmountMinor",i.confirmed_at AS "confirmedAt"
    FROM orders o JOIN purchase_intents i ON i.id=o.purchase_intent_id WHERE o.id=$1`, [orderId])).rows[0];
  const payment = (await client.query(`SELECT business_number AS "businessNumber",status,provider_status AS "providerStatus",
      COALESCE(observed_at,sent_at,created_at) AS "updatedAt" FROM payment_attempts WHERE order_id=$1`, [orderId])).rows[0] ?? null;
  const cancellations = await listMerchantConsumerCancellations(client, merchantId, { orderId });
  const refunds = [];
  for (const cancellation of cancellations) {
    refunds.push(...await listMerchantConsumerRefunds(client, merchantId, cancellation.id));
  }
  const operations = (await client.query(`SELECT op.id AS "operationId",op.type,op.state,
      op.attempt_count AS "attemptCount",op.created_at AS "createdAt",op.updated_at AS "updatedAt"
    FROM operations op WHERE op.budget_period_id=$1 AND (op.entity_id=$2
      OR op.entity_id=ANY($3::uuid[]) OR op.entity_id=ANY($4::uuid[]))
    ORDER BY op.created_at,op.id`, [order.budgetPeriodId, orderId,
    cancellations.map(value => value.id), refunds.map(value => value.id)])).rows;
  const timeline = [
    { type: 'order_created', referenceId: orderId, status: order.status, observedAt: order.createdAt },
    ...cancellations.map(value => ({ type: 'cancellation_updated', referenceId: value.id,
      status: value.status, observedAt: value.updatedAt })),
    ...refunds.map(value => ({ type: 'refund_updated', referenceId: value.id,
      status: value.status, observedAt: value.updatedAt })),
    ...operations.map(value => ({ type: value.type, referenceId: value.operationId,
      status: value.state, observedAt: value.updatedAt })),
  ].sort((left, right) => new Date(left.observedAt).getTime() - new Date(right.observedAt).getTime());
  return merchantOrderDetail.parse({ order, confirmation, payment, cancellations, refunds, operations, timeline });
}

type CancellationScope = {
  id: string; orderId: string; periodId: string; ownerId: string; status: string;
  decision: string | null; rulePreset: CancellationRule; feeMinor: number; refundMinor: number;
  amountMinor: number; refundedMinor: number; paymentStatus: string;
  environment: 'simulation' | 'sandbox'; provider: 'simulation' | 'alipay';
  accountSource: 'demo' | 'bank_api';
};

async function lockCancellation(client: PoolClient, merchantId: string, cancellationId: string) {
  const row = (await client.query<CancellationScope>(`SELECT c.id,c.order_id AS "orderId",
      o.budget_period_id AS "periodId",o.owner_id AS "ownerId",c.status,c.decision,
      c.rule_preset AS "rulePreset",c.accepted_fee_minor::integer AS "feeMinor",
      c.accepted_refund_minor::integer AS "refundMinor",o.amount_minor::integer AS "amountMinor",
      o.refunded_minor::integer AS "refundedMinor",o.payment_status AS "paymentStatus",o.environment,o.provider,
      a.source AS "accountSource" FROM cancellation_requests c JOIN orders o ON o.id=c.order_id
      JOIN consumer_order_merchants m ON m.order_id=o.id
      JOIN budget_periods p ON p.id=o.budget_period_id JOIN finance_accounts a ON a.id=p.primary_account_id
    WHERE c.id=$1 AND m.merchant_id=$2 FOR UPDATE OF c,o`, [cancellationId, merchantId])).rows[0];
  if (!row) notFound('未找到本商户的新订单取消申请。');
  return row;
}

async function appendMerchantEvent(client: PoolClient, scope: Pick<CancellationScope, 'ownerId' | 'periodId'>,
  merchantId: string, type: string, data: Record<string, unknown>) {
  await client.query(`INSERT INTO budget_events(owner_id,period_id,actor_id,type,data)
    VALUES($1,$2,$3,$4,$5)`, [scope.ownerId, scope.periodId, merchantId, type, data]);
}

export async function decideMerchantConsumerCancellation(client: PoolClient, merchantId: string,
  cancellationId: string, input: MerchantDecisionInput) {
  const scope = await lockCancellation(client, merchantId, cancellationId);
  if (!['submitted', 'delayed'].includes(scope.status)) {
    if (scope.decision === input.decision) {
      return { cancellationId, status: scope.status, decision: scope.decision, reused: true };
    }
    throw new AppError(409, 'CANCELLATION_NOT_DECIDABLE', '该申请已经处理，不能改写原决定。');
  }
  if (scope.status === 'submitted' && input.decision !== initialDecisionForRule(scope.rulePreset)) {
    throw new AppError(422, 'RULE_DECISION_MISMATCH', '处理结果与消费者确认的规则不一致。');
  }
  if (input.decision === 'delay') {
    throw new AppError(409, 'CANCELLATION_ALREADY_DELAYED', '申请已在等待商户处理，请明确批准或拒绝。');
  }
  const status = input.decision === 'approve' ? 'approved' : 'rejected';
  await client.query(`UPDATE cancellation_requests SET status=$2,decision=$3,decision_reason=$4,
      decided_by=$5,decided_at=now(),updated_at=now() WHERE id=$1`,
  [cancellationId, status, input.decision, input.reason, merchantId]);
  await client.query('UPDATE orders SET status=$2,updated_at=now() WHERE id=$1',
    [scope.orderId, input.decision === 'approve' ? 'cancellation_processing' : 'cancellation_rejected']);
  const existing = (await client.query<{ id: string }>(`SELECT id FROM operations
    WHERE budget_period_id=$1 AND entity_id=$2 AND type='merchant_cancellation_review'
    ORDER BY created_at LIMIT 1 FOR UPDATE`, [scope.periodId, cancellationId])).rows[0];
  const operationId = existing?.id ?? await createOperation(client, { budgetPeriodId: scope.periodId,
    ownerId: scope.ownerId, type: 'merchant_cancellation_review', entityId: cancellationId,
    purpose: `merchant_cancellation:${cancellationId}` });
  await client.query(`UPDATE operations SET state='succeeded',result=$2,updated_at=now() WHERE id=$1`,
    [operationId, { decision: input.decision, decidedBy: merchantId }]);
  await client.query(`UPDATE manual_tasks SET state='resolved',resolved_at=now(),updated_at=now()
    WHERE cancellation_request_id=$1 AND type='cancellation_follow_up' AND state<>'resolved'`, [cancellationId]);
  await appendMerchantEvent(client, scope, merchantId, 'cancellation.decided', {
    orderId: scope.orderId, cancellationId, operationId, decision: input.decision,
  });
  return { cancellationId, status, decision: input.decision, operationId, reused: false };
}

export async function scheduleMerchantConsumerRefund(client: PoolClient, merchantId: string, cancellationId: string) {
  const scope = await lockCancellation(client, merchantId, cancellationId);
  const existing = await listMerchantConsumerRefunds(client, merchantId, cancellationId);
  if (existing.length) return { cancellationId, reused: true, batches: existing };
  if (scope.status !== 'approved' || scope.paymentStatus !== 'paid') {
    throw new AppError(409, 'REFUND_NOT_APPROVED', '只有已付款且已批准的申请可以安排退款。');
  }
  const details = cancellationRuleDetails(scope.rulePreset, scope.amountMinor);
  if (details.batchCount === 0 || scope.feeMinor !== details.feeMinor
    || scope.refundMinor !== scope.amountMinor - details.feeMinor
    || scope.refundedMinor + scope.refundMinor > scope.amountMinor) {
    throw new AppError(409, 'REFUND_RULE_SNAPSHOT_CONFLICT', '原确认的退款范围已经不成立。');
  }
  if (scope.environment === 'sandbox' && (!sandboxReadiness().ready || scope.provider !== 'alipay')) {
    throw new AppError(422, 'EXTERNAL_REFUND_NOT_READY', '支付宝沙箱退款尚未就绪。');
  }
  if (scope.environment === 'simulation' && scope.provider !== 'simulation') {
    throw new AppError(422, 'PAYMENT_ENVIRONMENT_MISMATCH', '退款环境不一致。');
  }
  const amounts = details.batchCount === 2
    ? [Math.floor(scope.refundMinor / 2), scope.refundMinor - Math.floor(scope.refundMinor / 2)]
    : [scope.refundMinor];
  for (const [index, amountMinor] of amounts.entries()) {
    const batchId = randomUUID();
    const operationId = await createOperationJob(client, { budgetPeriodId: scope.periodId,
      ownerId: scope.ownerId, type: scope.environment === 'simulation' ? 'simulate_refund_batch' : 'sandbox_refund',
      entityId: batchId, purpose: `merchant_refund:${cancellationId}:${index + 1}` });
    await client.query(`INSERT INTO refund_batches(id,cancellation_request_id,order_id,merchant_id,
        operation_id,environment,provider,batch_number,business_number,amount_minor)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [batchId, cancellationId, scope.orderId,
      merchantId, operationId, scope.environment, scope.provider, index + 1,
      `XZ-RF-${batchId.replaceAll('-', '')}`, amountMinor]);
  }
  await client.query("UPDATE cancellation_requests SET status='refund_processing',updated_at=now() WHERE id=$1",
    [cancellationId]);
  await applyVerifiedMoneyEvent(client, scope.ownerId, { orderId: scope.orderId, provider: scope.provider,
    providerEventId: `REFUND_REQUESTED_${cancellationId}`, eventType: 'refund_requested',
    amountMinor: scope.refundMinor, currency: 'CNY', occurredAt: new Date().toISOString(),
    verificationState: 'unverified', source: scope.accountSource });
  await appendMerchantEvent(client, scope, merchantId, 'refund_batches.accepted', {
    orderId: scope.orderId, cancellationId, batchCount: amounts.length,
  });
  return { cancellationId, reused: false,
    batches: await listMerchantConsumerRefunds(client, merchantId, cancellationId) };
}

export async function actMerchantConsumerTask(client: PoolClient, merchantId: string,
  taskId: string, input: MerchantTaskActionInput) {
  const task = (await client.query<{ id: string; state: string; claimedBy: string | null;
    ownerId: string; periodId: string; orderId: string }>(`SELECT t.id,t.state,t.claimed_by AS "claimedBy",
      o.owner_id AS "ownerId",o.budget_period_id AS "periodId",o.id AS "orderId"
    FROM manual_tasks t JOIN orders o ON o.id=t.order_id
    JOIN consumer_order_merchants assignment ON assignment.order_id=o.id
    WHERE t.id=$1 AND assignment.merchant_id=$2 AND t.budget_period_id=o.budget_period_id FOR UPDATE OF t`,
  [taskId, merchantId])).rows[0];
  if (!task) notFound('未找到本商户的新订单任务。');
  if (task.state === 'resolved') throw new AppError(409, 'MANUAL_TASK_RESOLVED', '任务已经关闭。');
  if (task.claimedBy && task.claimedBy !== merchantId) {
    throw new AppError(409, 'MANUAL_TASK_CLAIMED', '任务已被其他处理人领取。');
  }
  if (input.action === 'claim') {
    await client.query(`UPDATE manual_tasks SET state='claimed',claimed_by=$2,
      claimed_at=COALESCE(claimed_at,now()),updated_at=now() WHERE id=$1`, [taskId, merchantId]);
  } else {
    if (task.state !== 'claimed') throw new AppError(409, 'MANUAL_TASK_NOT_CLAIMED', '请先领取任务。');
    await client.query(`UPDATE manual_tasks SET last_note=$2,next_review_at=now()+interval '1 day',
      updated_at=now() WHERE id=$1`, [taskId, input.note]);
  }
  await appendMerchantEvent(client, task, merchantId, `manual_task.${input.action}`, {
    taskId, orderId: task.orderId,
  });
  return { taskId, state: 'claimed' as const };
}
