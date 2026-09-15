import type { PoolClient } from 'pg';
import { AppError } from './errors.js';
import { forecastBudgetCashflow } from './budget-cashflow.js';
import { readPurchaseItem, readPurchaseQuote, safePurchaseMinor } from './purchase-assessment.js';

export type PurchaseCommitInput = {
  ownerId: string; periodId: string; budgetItemId: string; quoteId: string;
  assessmentId: string; purchaseIntentId: string;
  expectedFinancialVersion: number; expectedPeriodVersion: number;
  expectedQuoteVersion: number; acceptedAmountMinor: number;
  confirmedByUser: true;
};

export type ValidatedPurchaseCommit = {
  ownerId: string; accountId: string; periodId: string; budgetItemId: string;
  quoteId: string; purchaseIntentId: string; acceptedAmountMinor: number;
  quoteVersion: number;
};

type PurchaseOrderWriter = (client: PoolClient, validated: ValidatedPurchaseCommit) => Promise<string>;

/**
 * B04 calls this inside its OWN BEGIN/COMMIT. The callback must only write the
 * confirmed intent and one pending order on this PoolClient; it must not send
 * an external payment before the containing transaction commits.
 */
export async function commitPurchaseAssessment(client: PoolClient, input: PurchaseCommitInput,
  confirmAndCreateOrder: PurchaseOrderWriter, now = new Date()) {
  if (input.confirmedByUser !== true || !Number.isSafeInteger(input.acceptedAmountMinor)
    || input.acceptedAmountMinor <= 0) {
    throw new AppError(409, 'CONFIRMATION_SCOPE_MISMATCH', '缺少本人确认的有效金额。');
  }
  const periodRef = (await client.query<{ accountId: string }>(`SELECT primary_account_id AS "accountId"
    FROM budget_periods WHERE id=$1 AND owner_id=$2`, [input.periodId, input.ownerId])).rows[0];
  if (!periodRef) throw new AppError(404, 'RESOURCE_FORBIDDEN', '未找到本人预算周期。');

  // The lock order is shared with B: account -> periods -> item -> quote/intent -> orders.
  const account = (await client.query<{ id: string; status: string; accountType: string;
    source: string; financialVersion: string }>(`SELECT id,status,account_type AS "accountType",
    source,financial_version AS "financialVersion"
    FROM finance_accounts WHERE id=$1 AND owner_id=$2 FOR UPDATE`,
  [periodRef.accountId, input.ownerId])).rows[0];
  if (!account || account.status !== 'linked' || account.accountType !== 'debit') {
    throw new AppError(409, 'FINANCE_SCOPE_REVOKED', '账户授权或借记资金范围已失效。');
  }
  const periods = (await client.query<{ id: string; version: string; status: string }>(`SELECT id,version,status
    FROM budget_periods WHERE owner_id=$1 AND primary_account_id=$2
      AND status='active' ORDER BY month_start,id FOR UPDATE`,
  [input.ownerId, account.id])).rows;
  const period = periods.find((row) => row.id === input.periodId);
  if (!period) throw new AppError(409, 'VERSION_CONFLICT', '目标预算已不在可执行状态。');
  if (safePurchaseMinor(account.financialVersion) !== input.expectedFinancialVersion
    || safePurchaseMinor(period.version) !== input.expectedPeriodVersion) {
    throw new AppError(409, 'VERSION_CONFLICT', '资金或预算版本变化，请重新预览并确认。');
  }
  const item = await readPurchaseItem(client, input.ownerId, input.periodId,
    input.budgetItemId, true, input.purchaseIntentId);
  if (item.accountId !== account.id) {
    throw new AppError(409, 'CONFIRMATION_SCOPE_MISMATCH', '购买项目和借记账户不匹配。');
  }
  const quote = await readPurchaseQuote(client, input.quoteId, item, now, true);
  const quotedAmountMinor = safePurchaseMinor(quote.priceMinor);
  if (safePurchaseMinor(quote.quoteVersion) !== input.expectedQuoteVersion
    || quotedAmountMinor !== input.acceptedAmountMinor) {
    throw new AppError(409, 'QUOTE_STALE', '确认金额或报价版本已失效。');
  }
  const intent = (await client.query<{ id: string; status: string; expiresAt: Date;
    assessmentId: string; quoteId: string; budgetItemId: string; financialVersion: string;
    periodVersion: string; quoteVersion: string }>(`SELECT id,status,expires_at AS "expiresAt",
    assessment_id AS "assessmentId",quote_id AS "quoteId",
    budget_item_id AS "budgetItemId",financial_version AS "financialVersion",
    period_version AS "periodVersion",quote_version AS "quoteVersion"
    FROM purchase_intents WHERE id=$1 AND owner_id=$2 AND period_id=$3 FOR UPDATE`,
  [input.purchaseIntentId, input.ownerId, input.periodId])).rows[0];
  if (!intent || intent.status !== 'proposed' || intent.expiresAt <= now
    || intent.assessmentId !== input.assessmentId || intent.quoteId !== input.quoteId
    || intent.budgetItemId !== input.budgetItemId
    || safePurchaseMinor(intent.financialVersion) !== input.expectedFinancialVersion
    || safePurchaseMinor(intent.periodVersion) !== input.expectedPeriodVersion
    || safePurchaseMinor(intent.quoteVersion) !== input.expectedQuoteVersion) {
    throw new AppError(409, 'CONFIRMATION_SCOPE_MISMATCH', '购买意图不是当前本人确认的范围。');
  }
  const beforeOrders = (await client.query<{ id: string }>(`SELECT o.id FROM orders o JOIN budget_periods p ON p.id=o.budget_period_id
    WHERE o.owner_id=$1 AND p.primary_account_id=$2 ORDER BY o.created_at,o.id FOR UPDATE OF o`,
  [input.ownerId, account.id])).rows;
  const assessment = (await client.query<{ status: string; expiresAt: Date; accountId: string;
    basisSnapshotId: string; quotedAmountMinor: string; financialVersion: string;
    periodVersion: string; quoteVersion: string }>(`SELECT status,expires_at AS "expiresAt",
    account_id AS "accountId",basis_snapshot_id AS "basisSnapshotId",
    quoted_amount_minor AS "quotedAmountMinor",financial_version AS "financialVersion",
    period_version AS "periodVersion",quote_version AS "quoteVersion"
    FROM funding_assessments WHERE id=$1 AND owner_id=$2 AND period_id=$3
      AND budget_item_id=$4 AND quote_id=$5`, [input.assessmentId, input.ownerId,
    input.periodId, input.budgetItemId, input.quoteId])).rows[0];
  if (!assessment || assessment.status !== 'allowed' || assessment.expiresAt <= now
    || assessment.accountId !== account.id || safePurchaseMinor(assessment.quotedAmountMinor) !== quotedAmountMinor
    || safePurchaseMinor(assessment.financialVersion) !== input.expectedFinancialVersion
    || safePurchaseMinor(assessment.periodVersion) !== input.expectedPeriodVersion
    || safePurchaseMinor(assessment.quoteVersion) !== input.expectedQuoteVersion) {
    throw new AppError(409, 'VERSION_CONFLICT', '购买评估证据不再允许下单，请重新评估。');
  }
  const final = await forecastBudgetCashflow(client, input.ownerId, input.periodId, {
    expectedFinancialVersion: input.expectedFinancialVersion,
    expectedPeriodVersion: input.expectedPeriodVersion, now,
    replacement: { budgetItemId: item.id, quotedAmountMinor, quoteId: quote.id },
  });
  if (final.accountId !== account.id || final.basisSnapshotId !== assessment.basisSnapshotId
    || final.forecast.status !== 'allowed') {
    throw new AppError(409, final.forecast.status === 'blocked' ? 'INSUFFICIENT_FUNDS'
      : final.forecast.status === 'needs_adjustment' ? 'SAVINGS_TARGET_AT_RISK'
        : 'FINANCE_BASIS_UNKNOWN', '最新资金核算不允许该笔购买。',
    { status: final.forecast.status, reasonCodes: final.forecast.reasonCodes });
  }
  const validated: ValidatedPurchaseCommit = {
    ownerId: input.ownerId, accountId: account.id, periodId: input.periodId,
    budgetItemId: item.id, quoteId: quote.id, purchaseIntentId: intent.id,
    acceptedAmountMinor: quotedAmountMinor, quoteVersion: safePurchaseMinor(quote.quoteVersion),
  };
  const orderId = await confirmAndCreateOrder(client, validated);
  const afterOrders = (await client.query<{ id: string }>(`SELECT o.id FROM orders o
    JOIN budget_periods p ON p.id=o.budget_period_id
    WHERE o.owner_id=$1 AND p.primary_account_id=$2 ORDER BY o.created_at,o.id`,
  [input.ownerId, account.id])).rows;
  const previousIds = new Set(beforeOrders.map((row) => row.id));
  const newIds = afterOrders.map((row) => row.id).filter((id) => !previousIds.has(id));
  const postVersions = (await client.query<{ financialVersion: string; periodVersion: string }>(`SELECT
    a.financial_version AS "financialVersion",p.version AS "periodVersion"
    FROM finance_accounts a JOIN budget_periods p ON p.primary_account_id=a.id
    WHERE a.id=$1 AND p.id=$2 AND p.owner_id=$3`,
  [account.id, input.periodId, input.ownerId])).rows[0]!;
  if (newIds.length !== 1 || newIds[0] !== orderId
    || afterOrders.length !== beforeOrders.length + 1
    || safePurchaseMinor(postVersions.financialVersion) !== input.expectedFinancialVersion + 1
    || safePurchaseMinor(postVersions.periodVersion) !== input.expectedPeriodVersion) {
    throw new AppError(409, 'CONFIRMATION_SCOPE_MISMATCH',
      '确认回调只能写一笔同账户订单，不能更改其他资金依据。');
  }
  const created = (await client.query<{ id: string; amountMinor: number; paymentStatus: string;
    status: string; intentStatus: string; budgetPeriodId: string }>(`SELECT o.id,
    o.amount_minor AS "amountMinor",o.payment_status AS "paymentStatus",o.status,
    i.status AS "intentStatus",o.budget_period_id AS "budgetPeriodId"
    FROM orders o JOIN purchase_intents i ON i.id=o.purchase_intent_id
    WHERE o.id=$1 AND o.owner_id=$2 AND o.purchase_intent_id=$3`,
  [orderId, input.ownerId, intent.id])).rows[0];
  if (!created || created.budgetPeriodId !== input.periodId
    || created.amountMinor !== quotedAmountMinor || created.paymentStatus !== 'pending'
    || created.status !== 'created' || created.intentStatus !== 'ordered') {
    throw new AppError(409, 'CONFIRMATION_SCOPE_MISMATCH', '订单写入未保持已确认的金额和范围。');
  }
  await client.query(`UPDATE budget_items SET status='committed' WHERE id=$1 AND owner_id=$2
    AND period_id=$3 AND status='planned'`, [item.id, input.ownerId, input.periodId]);
  await client.query(`INSERT INTO budget_events (owner_id,period_id,actor_id,type,data)
    VALUES($1,$2,$1,'purchase_committed',$3::jsonb)`, [input.ownerId, input.periodId,
    JSON.stringify({ accountId: account.id, budgetItemId: item.id, quoteId: quote.id,
      assessmentId: input.assessmentId, purchaseIntentId: intent.id, orderId,
      replacedEstimateMinor: safePurchaseMinor(item.estimateMinor), quotedAmountMinor }),
  ]);
  return { ...validated, orderId };
}
