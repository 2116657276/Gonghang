import { budgetPeriodReview, type BudgetPeriodReview } from '@xingzhi/contracts';
import { AppError } from './errors.js';
import { loadFinanceAccountFacts, type FinanceDb } from './finance-facts.js';

type PeriodRow = { id: string; accountId: string; status: 'draft' | 'active' | 'closed';
  monthStart: string; monthEnd: string; currentTargetMinor: string; source: 'demo' | 'bank_api' };
type ChangeRow = { previousTargetMinor: string; newTargetMinor: string };
type LedgerRow = { direction: 'inflow' | 'outflow'; amountMinor: number;
  category: string | null; orderId: string | null };
type MoneyRow = { orderId: string; eventType: string; amountMinor: string;
  verificationState: string };
type BatchRow = { orderId: string; amountMinor: number; status: string };
type OrderRow = { id: string; paymentStatus: string };

function safeAmount(value: number | string) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new AppError(409, 'FINANCE_BASIS_UNKNOWN', '复盘金额超出可安全计算范围。');
  }
  return amount;
}

function safeSum(values: Array<number | string>) {
  return values.reduce<number>((sum, value) => safeAmount(sum + safeAmount(value)), 0);
}

/** Historic facts are read even for revoked accounts and closed periods. */
export async function reviewBudgetPeriod(db: FinanceDb, ownerId: string, periodId: string,
  now = new Date()): Promise<BudgetPeriodReview> {
  const period = (await db.query<PeriodRow>(`SELECT p.id,
    p.primary_account_id AS "accountId",p.status,
    to_char(p.month_start,'YYYY-MM-DD') AS "monthStart",
    to_char(p.month_end,'YYYY-MM-DD') AS "monthEnd",
    p.savings_target_minor AS "currentTargetMinor",a.source
    FROM budget_periods p JOIN finance_accounts a ON a.id=p.primary_account_id
    WHERE p.id=$1 AND p.owner_id=$2 AND a.owner_id=$2`,
  [periodId, ownerId])).rows[0];
  if (!period) throw new AppError(404, 'RESOURCE_FORBIDDEN', '未找到本人预算周期。');
  const changes = (await db.query<ChangeRow>(`SELECT previous_target_minor AS "previousTargetMinor",
    new_target_minor AS "newTargetMinor"
    FROM budget_target_changes WHERE owner_id=$1 AND period_id=$2 AND created_at<=$3
    ORDER BY created_at,id`, [ownerId, periodId, now])).rows;
  const ledger = (await db.query<LedgerRow>(`SELECT direction,
    amount_minor AS "amountMinor",category,order_id AS "orderId"
    FROM finance_ledger_entries WHERE owner_id=$1 AND account_id=$2 AND source=$3
      AND status='posted' AND posted_at<=$6 AND occurred_at<=$6
      AND (occurred_at AT TIME ZONE 'Asia/Shanghai')::date BETWEEN $4::date AND $5::date
    ORDER BY occurred_at,id`, [ownerId, period.accountId, period.source,
    period.monthStart, period.monthEnd, now])).rows;
  const orders = (await db.query<OrderRow>(`SELECT id,payment_status AS "paymentStatus"
    FROM orders WHERE owner_id=$1 AND budget_period_id=$2 AND created_at<=$3
    ORDER BY created_at,id`, [ownerId, periodId, now])).rows;
  const money = (await db.query<MoneyRow>(`SELECT e.order_id AS "orderId",
    e.event_type AS "eventType",e.amount_minor AS "amountMinor",
    e.verification_state AS "verificationState"
    FROM finance_money_events e JOIN orders o ON o.id=e.order_id AND o.owner_id=e.owner_id
    WHERE e.owner_id=$1 AND o.budget_period_id=$2 AND e.occurred_at<=$3
    ORDER BY e.occurred_at,e.id`, [ownerId, periodId, now])).rows;
  const batches = (await db.query<BatchRow>(`SELECT b.order_id AS "orderId",
    b.amount_minor AS "amountMinor",b.status
    FROM refund_batches b JOIN orders o ON o.id=b.order_id
    WHERE o.owner_id=$1 AND o.budget_period_id=$2 AND b.created_at<=$3
    ORDER BY b.created_at,b.id`, [ownerId, periodId, now])).rows;
  const totals = new Map<string, { requested: number; verified: number; received: number; succeeded: number }>();
  const forOrder = (orderId: string) => {
    const current = totals.get(orderId) ?? { requested: 0, verified: 0, received: 0, succeeded: 0 };
    totals.set(orderId, current);
    return current;
  };
  let confirmedPayments = 0;
  const issues = new Set<string>();
  if (changes.some((change, index) => index > 0
    && change.previousTargetMinor !== changes[index - 1]!.newTargetMinor)
    || (changes.length > 0 && changes.at(-1)!.newTargetMinor !== period.currentTargetMinor)) {
    issues.add('TARGET_AUDIT_MISMATCH');
  }
  for (const row of money) {
    const amount = safeAmount(row.amountMinor);
    const total = forOrder(row.orderId);
    if (row.eventType === 'payment_posted' && row.verificationState === 'verified') {
      confirmedPayments = safeAmount(confirmedPayments + amount);
    } else if (row.eventType === 'refund_requested') {
      total.requested = safeAmount(total.requested + amount);
    } else if (row.eventType === 'refund_verified' && row.verificationState === 'verified') {
      total.verified = safeAmount(total.verified + amount);
    } else if (row.eventType === 'refund_posted' && row.verificationState === 'verified') {
      total.received = safeAmount(total.received + amount);
    } else if (row.eventType === 'result_unknown') issues.add('PROVIDER_RESULT_UNKNOWN');
  }
  for (const row of batches) {
    if (row.status === 'succeeded') {
      const total = forOrder(row.orderId);
      total.succeeded = safeAmount(total.succeeded + safeAmount(row.amountMinor));
    } else if (['unknown', 'pending_review'].includes(row.status)) {
      issues.add('REFUND_CHANNEL_RESULT_UNKNOWN');
    }
  }
  if (orders.some((order) => ['pending', 'unknown'].includes(order.paymentStatus))) {
    issues.add('ORDER_PAYMENT_NOT_FINAL');
  }
  const refundAwaitingArrivalMinor = safeSum([...totals.values()].map((total) =>
    Math.max(0, Math.max(total.requested, total.verified, total.succeeded) - total.received)));
  if (refundAwaitingArrivalMinor > 0) issues.add('REFUND_NOT_ACCOUNT_POSTED');
  const facts = await loadFinanceAccountFacts(db, ownerId, period.accountId, now);
  if (facts.cashBasis.dataStatus !== 'observed') issues.add('CURRENT_CASH_BASIS_UNKNOWN');
  const currentCashAsOf = facts.cashBasis.dataStatus === 'observed'
    ? new Date(Math.max(new Date(facts.cashBasis.asOf!).getTime(),
      ...facts.ledger.filter((entry) => entry.status === 'posted' && entry.postedAt !== null
        && new Date(entry.postedAt) <= now).map((entry) => new Date(entry.postedAt!).getTime())))
      .toISOString() : null;
  // A historical month-end amount is only asserted when an observed snapshot
  // explicitly represents the Shanghai month-end instant. A recent balance is
  // not silently backdated into last month's achieved savings.
  const closing = (await db.query<{ balanceMinor: number }>(`SELECT
    s.available_balance_minor AS "balanceMinor"
    FROM finance_account_snapshots s
    WHERE s.account_id=$1 AND s.source=$2 AND s.fact_status='observed'
      AND s.available_balance_minor IS NOT NULL
      AND s.as_of=(($3::date + INTERVAL '1 day')::timestamp AT TIME ZONE 'Asia/Shanghai')
      AND s.covered_through_at>=s.as_of AND s.as_of<=$4
    ORDER BY s.captured_at DESC,s.id DESC LIMIT 1`,
  [period.accountId, period.source, period.monthEnd, now])).rows[0];
  if (period.status === 'closed' && !closing) issues.add('CLOSING_SNAPSHOT_MISSING');
  const periodEndUnspentCashMinor = period.status === 'closed' && closing
    ? safeAmount(closing.balanceMinor) : null;
  const currentTarget = safeAmount(period.currentTargetMinor);
  const review = budgetPeriodReview.parse({
    periodId, accountId: period.accountId, accountSource: period.source,
    periodStatus: period.status, monthStart: period.monthStart, monthEnd: period.monthEnd,
    timezone: 'Asia/Shanghai',
    originalSavingsTargetMinor: changes.length ? safeAmount(changes[0]!.previousTargetMinor) : currentTarget,
    currentSavingsTargetMinor: currentTarget, targetChangeCount: changes.length,
    confirmedPeriodOutflowMinor: safeSum(ledger.filter((row) => row.direction === 'outflow')
      .map((row) => row.amountMinor)),
    confirmedPeriodInflowMinor: safeSum(ledger.filter((row) => row.direction === 'inflow')
      .map((row) => row.amountMinor)),
    classifiedUnexpectedExpenseMinor: safeSum(ledger.filter((row) => row.direction === 'outflow'
      && ['unexpected', 'emergency'].includes(row.category ?? '')).map((row) => row.amountMinor)),
    confirmedOrderPaymentsMinor: confirmedPayments,
    confirmedRefundReceivedMinor: safeSum([...totals.values()].map((row) => row.received)),
    refundRequestedMinor: safeSum([...totals.values()].map((row) => row.requested)),
    refundChannelVerifiedMinor: safeSum([...totals.values()].map((row) => row.verified)),
    channelRefundSucceededMinor: safeSum([...totals.values()].map((row) => row.succeeded)),
    refundAwaitingArrivalMinor,
    currentConfirmedCashMinor: facts.cashBasis.confirmedCashMinor,
    currentCashAsOf,
    periodEndUnspentCashMinor,
    periodEndTargetGapMinor: periodEndUnspentCashMinor === null ? null
      : Math.max(0, currentTarget - periodEndUnspentCashMinor),
    reviewStatus: issues.has('TARGET_AUDIT_MISMATCH') ? 'unknown'
      : period.status !== 'closed' ? 'provisional'
      : closing && issues.size === 0 ? 'complete' : 'unknown',
    unknownIssues: [...issues],
  });
  return review;
}
