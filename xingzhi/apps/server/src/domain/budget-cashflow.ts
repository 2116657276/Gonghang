import type { PoolClient } from 'pg';
import type { PlanningDraftItem } from '@xingzhi/contracts';
import { AppError } from './errors.js';
import { loadFinanceAccountFacts } from './finance-facts.js';
import {
  calculateDailyCashflow, unknownDailyCashflow, type CashflowEvent,
} from './cashflow-engine.js';

type PeriodRow = {
  id: string; accountId: string; monthStart: string; monthEnd: string;
  status: 'draft' | 'active' | 'closed'; savingsTargetMinor: string; version: string;
};
export type PlannedRow = {
  id: string; plannedOn: string; kind: 'expected_income' | 'essential_expense' | 'planned_spend';
  status: 'planned' | 'committed'; estimatedMinor: string; priority?: 'required' | 'adjustable';
};
export type PlanningOptionChange = {
  budgetItemId: string; action: 'cancel' | 'revise';
  plannedOn?: string; estimatedAmountMinor?: number;
};
export type CommittedOrderRow = {
  id: string; budgetItemId: string; amountMinor: number;
  paymentStatus: 'pending' | 'paid' | 'unknown' | 'closed' | 'failed';
  debitedInBank: boolean;
};
export type RepaymentRow = {
  id: string; dueOn: string; remainingDueMinor: number | null; dataIssue: string | null;
};

function safeMinor(value: number | string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new AppError(409, 'FINANCE_BASIS_UNKNOWN', '资金金额超出可安全计算范围。');
  }
  return parsed;
}

function shanghaiToday(now: Date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

function inclusiveDates(startOn: string, endOn: string) {
  const days: string[] = [];
  const day = new Date(`${startOn}T00:00:00Z`);
  const end = new Date(`${endOn}T00:00:00Z`);
  while (day <= end) {
    days.push(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return days;
}

export function buildCashflowEvents(input: {
  startOn: string; endOn: string;
  items: PlannedRow[]; orders: CommittedOrderRow[]; repayments: RepaymentRow[];
  proposedItems?: PlanningDraftItem[];
  replacement?: { budgetItemId: string; quotedAmountMinor: number; quoteId: string };
  extraEvents?: CashflowEvent[];
}) {
  const events: CashflowEvent[] = [];
  const reasonCodes: string[] = [];
  const activeOrders = input.orders.filter((order) => order.debitedInBank
    || !['closed', 'failed'].includes(order.paymentStatus));
  const orderItemIds = new Set(activeOrders.map((order) => order.budgetItemId));
  const orderCounts = new Map<string, number>();
  for (const order of activeOrders) {
    orderCounts.set(order.budgetItemId, (orderCounts.get(order.budgetItemId) ?? 0) + 1);
    if (order.paymentStatus === 'unknown') reasonCodes.push('PAYMENT_RESULT_UNKNOWN');
    if (order.debitedInBank) continue; // The posted account debit is already in opening cash.
    events.push({ on: input.startOn, deltaMinor: -safeMinor(order.amountMinor),
      kind: 'committed_order', referenceId: order.id });
  }
  if ([...orderCounts.values()].some((count) => count > 1)) {
    reasonCodes.push('DUPLICATE_ORDER_COMMITMENT');
  }
  let conditionalIncomeMinor = 0;
  for (const item of input.items) {
    const amount = safeMinor(item.estimatedMinor);
    if (item.kind === 'expected_income') {
      if (item.status === 'planned' && item.plannedOn <= input.endOn) {
        conditionalIncomeMinor = safeMinor(conditionalIncomeMinor + amount);
      }
      continue; // Expected income never licenses an expense.
    }
    if (orderItemIds.has(item.id)) continue; // Estimate is replaced by the order fact.
    if (input.replacement?.budgetItemId === item.id) continue;
    if (item.status === 'committed') {
      reasonCodes.push('COMMITTED_ITEM_WITHOUT_ORDER');
    }
    if (item.plannedOn > input.endOn) continue;
    events.push({
      on: item.plannedOn < input.startOn ? input.startOn : item.plannedOn,
      deltaMinor: -amount, kind: 'planned_expense', referenceId: item.id,
    });
  }
  if (input.replacement) {
    events.push({ on: input.startOn, deltaMinor: -safeMinor(input.replacement.quotedAmountMinor),
      kind: 'committed_order', referenceId: `quote:${input.replacement.quoteId}` });
  }
  for (const event of input.extraEvents ?? []) {
    if (event.on < input.startOn || event.on > input.endOn) {
      reasonCodes.push('ADJUSTMENT_DATE_OUTSIDE_PERIOD');
    } else events.push(event);
  }
  for (const repayment of input.repayments) {
    if (repayment.dataIssue !== null) reasonCodes.push(repayment.dataIssue);
    if (repayment.remainingDueMinor === null || repayment.dueOn > input.endOn) continue;
    events.push({
      on: repayment.dueOn < input.startOn ? input.startOn : repayment.dueOn,
      deltaMinor: -safeMinor(repayment.remainingDueMinor), kind: 'repayment', referenceId: repayment.id,
    });
  }
  for (const [index, item] of (input.proposedItems ?? []).entries()) {
    if (item.plannedOn === null || item.userEstimatedAmountMinor === null || item.priority === null) {
      reasonCodes.push(`DRAFT_ITEM_${index}_INCOMPLETE`);
      continue;
    }
    if (item.plannedOn < input.startOn || item.plannedOn > input.endOn) {
      reasonCodes.push(`DRAFT_ITEM_${index}_OUTSIDE_PERIOD`);
      continue;
    }
    events.push({ on: item.plannedOn, deltaMinor: -safeMinor(item.userEstimatedAmountMinor),
      kind: 'planned_expense', referenceId: `draft:${index}` });
  }
  return { events, conditionalIncomeMinor, reasonCodes: [...new Set(reasonCodes)] };
}

async function readPeriod(client: PoolClient, ownerId: string, periodId: string) {
  const period = (await client.query<PeriodRow>(`SELECT id,primary_account_id AS "accountId",
    to_char(month_start,'YYYY-MM-DD') AS "monthStart",
    to_char(month_end,'YYYY-MM-DD') AS "monthEnd",status,
    savings_target_minor AS "savingsTargetMinor",version
    FROM budget_periods WHERE id=$1 AND owner_id=$2`, [periodId, ownerId])).rows[0];
  if (!period) throw new AppError(404, 'RESOURCE_FORBIDDEN', '未找到本人预算周期。');
  return period;
}

async function readPlannedItems(client: PoolClient, ownerId: string, accountId: string, endOn: string) {
  return (await client.query<PlannedRow>(`SELECT i.id,
    to_char(i.planned_on,'YYYY-MM-DD') AS "plannedOn",i.kind,i.status,
    i.user_estimated_amount_minor AS "estimatedMinor",i.priority
    FROM budget_items i JOIN budget_periods p ON p.id=i.period_id AND p.owner_id=i.owner_id
    WHERE i.owner_id=$1 AND i.account_id=$2 AND p.status='active'
      AND i.status IN ('planned','committed') AND i.planned_on <= $3::date
    ORDER BY i.planned_on,i.id`, [ownerId, accountId, endOn])).rows;
}

async function readCommittedOrders(client: PoolClient, ownerId: string, accountId: string) {
  return (await client.query<CommittedOrderRow>(`SELECT o.id,
    intent.budget_item_id AS "budgetItemId",o.amount_minor AS "amountMinor",
    o.payment_status AS "paymentStatus",
    EXISTS(SELECT 1 FROM finance_money_events money
      JOIN finance_ledger_entries entry ON entry.id=money.applied_ledger_entry_id
        AND entry.owner_id=money.owner_id AND entry.order_id=money.order_id
      WHERE money.order_id=o.id AND money.owner_id=o.owner_id
        AND money.event_type='payment_posted' AND money.verification_state='verified'
        AND entry.account_id=$2 AND entry.status='posted' AND entry.direction='outflow')
      AS "debitedInBank"
    FROM orders o JOIN budget_periods p ON p.id=o.budget_period_id AND p.owner_id=o.owner_id
    JOIN purchase_intents intent ON intent.id=o.purchase_intent_id AND intent.owner_id=o.owner_id
    WHERE o.owner_id=$1 AND p.primary_account_id=$2
    ORDER BY o.created_at,o.id`, [ownerId, accountId])).rows;
}

export async function forecastBudgetCashflow(client: PoolClient, ownerId: string, periodId: string, options: {
  expectedFinancialVersion?: number; expectedPeriodVersion?: number;
  proposedItems?: PlanningDraftItem[]; rolling30?: boolean; now?: Date;
  replacement?: { budgetItemId: string; quotedAmountMinor: number; quoteId: string };
  extraEvents?: CashflowEvent[];
  optionChanges?: PlanningOptionChange[];
} = {}) {
  const now = options.now ?? new Date();
  const today = shanghaiToday(now);
  const period = await readPeriod(client, ownerId, periodId);
  const account = await loadFinanceAccountFacts(client, ownerId, period.accountId, now);
  if (account.account.status === 'revoked') {
    throw new AppError(409, 'FINANCE_SCOPE_REVOKED', '账户授权已撤回，不能生成新资金评估。');
  }
  const financialVersion = account.account.financialVersion;
  const periodVersion = safeMinor(period.version);
  if ((options.expectedFinancialVersion !== undefined
      && options.expectedFinancialVersion !== financialVersion)
    || (options.expectedPeriodVersion !== undefined
      && options.expectedPeriodVersion !== periodVersion)) {
    throw new AppError(409, 'VERSION_CONFLICT', '资金或预算依据已经变化，请刷新后重新评估。',
      { financialVersion, periodVersion });
  }
  const startOn = today > period.monthStart ? today : period.monthStart;
  const endOn = options.rolling30
    ? new Date(new Date(`${startOn}T00:00:00Z`).getTime() + 29 * 86400000).toISOString().slice(0, 10)
    : period.monthEnd;
  const meta = { accountId: period.accountId, periodId, financialVersion, periodVersion,
    basisSnapshotId: account.cashBasis.snapshotId, asOf: account.cashBasis.asOf,
    conditionalIncomeMinor: account.displayOnly.expectedIncomeMinor,
    pendingRefundMinor: account.displayOnly.pendingRefundMinor,
    refundEvidenceNotCash: account.displayOnly.refundEvidenceNotCash };
  if (period.status !== 'active' || today < period.monthStart || today > period.monthEnd) {
    return { ...meta, forecast: unknownDailyCashflow(startOn, endOn, ['PERIOD_NOT_ACTIVE_OR_CURRENT']) };
  }
  if (account.cashBasis.dataStatus !== 'observed' || account.obligations.dataStatus !== 'observed') {
    const obligationIssues = account.obligations.items.flatMap((row) =>
      'dataIssue' in row && row.dataIssue ? [row.dataIssue] : []);
    return { ...meta, forecast: unknownDailyCashflow(startOn, endOn,
      [...account.cashBasis.reasonCodes, ...obligationIssues, 'FINANCE_BASIS_UNKNOWN']) };
  }
  const necessities = await client.query(`SELECT 1 FROM budget_periods
    WHERE id=$1 AND owner_id=$2 AND necessities_confirmed_at IS NOT NULL
    UNION ALL SELECT 1 FROM budget_items
    WHERE period_id=$1 AND owner_id=$2 AND status<>'cancelled'
      AND (kind='essential_expense' OR priority='required') LIMIT 1`,
  [periodId, ownerId]);
  if (!necessities.rowCount) {
    return { ...meta, forecast: unknownDailyCashflow(startOn, endOn,
      ['BUDGET_NECESSITIES_UNCONFIRMED']) };
  }
  const items = await readPlannedItems(client, ownerId, period.accountId, endOn);
  const overridden = new Map<string, PlannedRow>();
  if (options.optionChanges?.length) {
    const ids = options.optionChanges.map((change) => change.budgetItemId);
    if (new Set(ids).size !== ids.length) {
      throw new AppError(400, 'VALIDATION_ERROR', '同一项目不能在一个调整选项中重复修改。');
    }
    const candidates = (await client.query<PlannedRow>(`SELECT id,
      to_char(planned_on,'YYYY-MM-DD') AS "plannedOn",kind,status,
      user_estimated_amount_minor AS "estimatedMinor",priority
      FROM budget_items WHERE owner_id=$1 AND period_id=$2 AND account_id=$3
        AND id=ANY($4::uuid[])`, [ownerId, periodId, period.accountId, ids])).rows;
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    for (const change of options.optionChanges) {
      const item = byId.get(change.budgetItemId);
      if (!item || item.kind !== 'planned_spend' || item.status !== 'planned'
        || item.priority !== 'adjustable') {
        throw new AppError(409, 'ITEM_NOT_ORDERABLE', '只能调整本人尚未承诺的可调消费。');
      }
      const openIntent = await client.query(`SELECT 1 FROM purchase_intents
        WHERE owner_id=$1 AND budget_item_id=$2 AND status IN ('proposed','confirmed','ordered') LIMIT 1`,
      [ownerId, item.id]);
      if (openIntent.rowCount) {
        throw new AppError(409, 'ITEM_NOT_ORDERABLE', '已有购买意图的项目不能在预览中当作可释放预算。');
      }
      if (change.action === 'cancel') {
        if (change.plannedOn !== undefined || change.estimatedAmountMinor !== undefined) {
          throw new AppError(400, 'VALIDATION_ERROR', '取消选项不能同时改写项目日期或金额。');
        }
        continue;
      }
      if (change.action !== 'revise') {
        throw new AppError(400, 'VALIDATION_ERROR', '未知的项目调整方式。');
      }
      const plannedOn = change.plannedOn ?? item.plannedOn;
      const amount = change.estimatedAmountMinor ?? safeMinor(item.estimatedMinor);
      if (plannedOn < period.monthStart || plannedOn > period.monthEnd
        || !Number.isSafeInteger(amount) || amount <= 0) {
        throw new AppError(400, 'VALIDATION_ERROR', '调整后的日期或估价不属于当前周期。');
      }
      overridden.set(item.id, { ...item, plannedOn, estimatedMinor: String(amount) });
    }
  }
  const cancelledIds = new Set(options.optionChanges?.filter((change) => change.action === 'cancel')
    .map((change) => change.budgetItemId) ?? []);
  const effectiveItems = items.filter((item) => !cancelledIds.has(item.id))
    .map((item) => overridden.get(item.id) ?? item);
  const orders = await readCommittedOrders(client, ownerId, period.accountId);
  const repayments: RepaymentRow[] = account.obligations.items.flatMap((row) =>
    'remainingDueMinor' in row ? [{
      id: row.id, dueOn: row.dueOn, remainingDueMinor: row.remainingDueMinor,
      dataIssue: row.dataIssue,
    }] : []);
  const built = buildCashflowEvents({ startOn, endOn, items: effectiveItems, orders, repayments,
    proposedItems: options.proposedItems, replacement: options.replacement,
    extraEvents: options.extraEvents });
  const missingMonths: string[] = [];
  const savingsTargetsByDate: Record<string, number> = {};
  if (options.rolling30) {
    const periods = (await client.query<PeriodRow>(`SELECT id,primary_account_id AS "accountId",
      to_char(month_start,'YYYY-MM-DD') AS "monthStart",
      to_char(month_end,'YYYY-MM-DD') AS "monthEnd",status,
      savings_target_minor AS "savingsTargetMinor",version
      FROM budget_periods WHERE owner_id=$1 AND primary_account_id=$2
        AND month_start <= $4::date AND month_end >= $3::date`,
    [ownerId, period.accountId, startOn, endOn])).rows;
    for (const date of inclusiveDates(startOn, endOn)) {
      const covering = periods.find((row) => row.monthStart <= date && row.monthEnd >= date);
      if (!covering || covering.status !== 'active') missingMonths.push(date);
      else savingsTargetsByDate[date] = safeMinor(covering.savingsTargetMinor);
    }
  }
  const unresolved = built.reasonCodes.length > 0;
  const forecast = unresolved
    ? unknownDailyCashflow(startOn, endOn, built.reasonCodes)
    : calculateDailyCashflow({
      openingCashMinor: account.cashBasis.confirmedCashMinor!,
      savingsTargetMinor: safeMinor(period.savingsTargetMinor), startOn, endOn,
      events: built.events, unknownDates: missingMonths,
      savingsTargetsByDate: options.rolling30 ? savingsTargetsByDate : undefined,
    });
  return { ...meta, conditionalIncomeMinor: built.conditionalIncomeMinor,
    forecast: missingMonths.length && forecast.status === 'unknown'
      ? { ...forecast, reasonCodes: [...new Set([...forecast.reasonCodes, 'ADJACENT_PERIOD_UNKNOWN'])] }
      : forecast };
}
