import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  budgetBasis, budgetItemView, type BudgetItemChangeInput, type BudgetItemCancelInput,
  type BudgetItemMutationResult, type BudgetPeriodCreateInput, type BudgetPeriodActivationInput,
} from '@xingzhi/contracts';
import { AppError } from './errors.js';
import { expireStalePurchaseIntents } from './purchase-intent-lifecycle.js';
import { loadFinanceAccountFacts } from './finance-facts.js';
import { forecastBudgetCashflow } from './budget-cashflow.js';

type Period = {
  id: string; accountId: string; status: 'draft' | 'active' | 'closed';
  monthStart: string; monthEnd: string; target: string; version: string;
  necessitiesConfirmedAt: Date | null; baselineSnapshotId: string | null;
};
type Item = {
  id: string; periodId: string; kind: 'expected_income' | 'essential_expense' | 'planned_spend';
  title: string; categoryCode: string | null; plannedOn: string; estimated: string;
  priority: 'required' | 'adjustable'; status: 'planned' | 'committed' | 'settled' | 'cancelled'; version: string;
};

function amount(value: string | number) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new AppError(409, 'FINANCE_BASIS_UNKNOWN', '预算金额超出可安全计算范围。');
  }
  return result;
}
function nextMonth(monthStart: string) {
  const date = new Date(`${monthStart}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 10);
}
function monthEnd(monthStart: string) {
  const date = new Date(`${nextMonth(monthStart)}T00:00:00Z`);
  date.setUTCDate(0);
  return date.toISOString().slice(0, 10);
}
function todayShanghai() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
function view(item: Item) {
  return budgetItemView.parse({
    itemId: item.id, periodId: item.periodId, kind: item.kind, title: item.title,
    categoryCode: item.categoryCode, plannedOn: item.plannedOn,
    userEstimatedAmountMinor: amount(item.estimated), priority: item.priority,
    status: item.status, itemVersion: amount(item.version), linkedQuote: null,
  });
}
async function periodById(client: PoolClient, ownerId: string, periodId: string, lock = false) {
  const row = (await client.query<Period>(`SELECT id,primary_account_id AS "accountId",status,
      to_char(month_start,'YYYY-MM-DD') AS "monthStart",
      to_char(month_end,'YYYY-MM-DD') AS "monthEnd",
      savings_target_minor AS target,version,
      necessities_confirmed_at AS "necessitiesConfirmedAt",
      baseline_snapshot_id AS "baselineSnapshotId"
    FROM budget_periods WHERE id=$1 AND owner_id=$2 ${lock ? 'FOR UPDATE' : ''}`,
  [periodId, ownerId])).rows[0];
  if (!row) throw new AppError(404, 'RESOURCE_FORBIDDEN', '未找到本人预算周期。');
  return row;
}
async function itemById(client: PoolClient, ownerId: string, periodId: string, itemId: string, lock = false) {
  const row = (await client.query<Item>(`SELECT id,period_id AS "periodId",kind,title,
      category_code AS "categoryCode",to_char(planned_on,'YYYY-MM-DD') AS "plannedOn",
      user_estimated_amount_minor AS estimated,priority,status,version
    FROM budget_items WHERE id=$1 AND owner_id=$2 AND period_id=$3 ${lock ? 'FOR UPDATE' : ''}`,
  [itemId, ownerId, periodId])).rows[0];
  if (!row) throw new AppError(404, 'RESOURCE_FORBIDDEN', '未找到本人预算项目。');
  return row;
}
async function accountThenPeriod(client: PoolClient, ownerId: string, periodId: string) {
  const discovered = await periodById(client, ownerId, periodId);
  const account = (await client.query<{ id: string; status: string; financialVersion: string }>(
    `SELECT id,status,financial_version AS "financialVersion" FROM finance_accounts
      WHERE id=$1 AND owner_id=$2 FOR UPDATE`, [discovered.accountId, ownerId],
  )).rows[0];
  if (!account || account.status !== 'linked') {
    throw new AppError(409, 'FINANCE_SCOPE_REVOKED', '账户授权已撤回，不能修改预算。');
  }
  const period = await periodById(client, ownerId, periodId, true);
  return { account, period };
}
async function event(client: PoolClient, ownerId: string, periodId: string, type: string, data: Record<string, unknown>) {
  await client.query(`INSERT INTO budget_events(owner_id,period_id,actor_id,type,data)
    VALUES($1,$2,$1,$3,$4::jsonb)`, [ownerId, periodId, type, JSON.stringify(data)]);
}
function checkPeriodVersion(period: Period, expected: number) {
  if (amount(period.version) !== expected) {
    throw new AppError(409, 'VERSION_CONFLICT', '预算依据已变化，请刷新后重试。',
      { periodVersion: amount(period.version) });
  }
}
function open(period: Period) {
  if (period.status === 'closed') {
    throw new AppError(409, 'VERSION_CONFLICT', '已关闭的预算周期不能修改规划。');
  }
}
function correctMonth(period: Period, plannedOn: string) {
  if (plannedOn < period.monthStart || plannedOn > period.monthEnd) {
    throw new AppError(400, 'VALIDATION_ERROR', '项目日期必须属于当前自然月预算。');
  }
}
async function noOpenIntent(client: PoolClient, ownerId: string, itemId: string) {
  await expireStalePurchaseIntents(client, ownerId, itemId);
  const found = await client.query(`SELECT 1 FROM purchase_intents WHERE owner_id=$1 AND budget_item_id=$2
    AND status IN ('proposed','confirmed','ordered') LIMIT 1`, [ownerId, itemId]);
  if (found.rowCount) throw new AppError(409, 'ITEM_NOT_ORDERABLE', '已有购买意图，不能直接改写或取消该项目。');
}
async function itemsForPeriod(client: PoolClient, ownerId: string, periodId: string) {
  return (await client.query<Item>(`SELECT id,period_id AS "periodId",kind,title,
      category_code AS "categoryCode",to_char(planned_on,'YYYY-MM-DD') AS "plannedOn",
      user_estimated_amount_minor AS estimated,priority,status,version
    FROM budget_items WHERE period_id=$1 AND owner_id=$2 ORDER BY planned_on,id`,
  [periodId, ownerId])).rows;
}

export async function readBudgetPeriod(client: PoolClient, ownerId: string, periodId: string) {
  const period = await periodById(client, ownerId, periodId);
  const facts = await loadFinanceAccountFacts(client, ownerId, period.accountId);
  const rows = await itemsForPeriod(client, ownerId, periodId);
  const active = rows.filter((row) => row.status !== 'cancelled' && row.status !== 'settled');
  const total = (predicate: (row: Item) => boolean) => active.filter(predicate)
    .reduce((sum, row) => amount(sum + amount(row.estimated)), 0);
  const forecast = period.status === 'active' && facts.account.status === 'linked'
    ? (await forecastBudgetCashflow(client, ownerId, periodId)).forecast : null;
  const orderRows = (await client.query<{ amount: number; debited: boolean }>(`SELECT o.amount_minor AS amount,
    EXISTS(SELECT 1 FROM finance_money_events e JOIN finance_ledger_entries l
      ON l.id=e.applied_ledger_entry_id AND l.order_id=o.id
      WHERE e.order_id=o.id AND e.event_type='payment_posted' AND e.verification_state='verified'
        AND l.status='posted' AND l.direction='outflow') AS debited
    FROM orders o JOIN budget_periods p ON p.id=o.budget_period_id AND p.owner_id=o.owner_id
    WHERE p.primary_account_id=$1 AND o.owner_id=$2
      AND o.payment_status NOT IN ('closed','failed')`, [period.accountId, ownerId])).rows;
  const committedOrdersMinor = orderRows.filter((row) => !row.debited)
    .reduce((sum, row) => amount(sum + amount(row.amount)), 0);
  const basis = budgetBasis.parse({
    accountId: period.accountId, periodId, currency: 'CNY',
    financialVersion: facts.account.financialVersion, periodVersion: amount(period.version),
    basisSnapshotId: facts.cashBasis.snapshotId, asOf: facts.cashBasis.asOf,
    confirmedCashMinor: facts.cashBasis.confirmedCashMinor,
    savingsTargetMinor: amount(period.target),
    essentialRemainingMinor: total((row) => row.kind === 'essential_expense'),
    adjustablePlannedMinor: total((row) => row.kind === 'planned_spend'
      && row.priority === 'adjustable' && row.status === 'planned'),
    committedOrdersMinor, expectedIncomeMinor: total((row) => row.kind === 'expected_income'),
    pendingRefundMinor: facts.displayOnly.pendingRefundMinor,
    minimumProjectedCashMinor: forecast?.minimumProjectedCashMinor ?? null,
    minimumCashOn: forecast?.minimumCashOn ?? null,
    dataStatus: forecast?.status === 'unknown' || !forecast ? 'unknown'
      : facts.cashBasis.dataStatus === 'observed' ? 'observed' : 'incomplete',
  });
  return {
    period: { periodId, accountId: period.accountId, monthStart: period.monthStart,
      monthEnd: period.monthEnd, timezone: 'Asia/Shanghai' as const, status: period.status,
      savingsTargetMinor: amount(period.target), periodVersion: amount(period.version),
      necessitiesConfirmed: period.necessitiesConfirmedAt !== null || rows.some((row) =>
        row.status !== 'cancelled' && (row.kind === 'essential_expense' || row.priority === 'required')),
    },
    items: rows.map(view), basis,
    forecast: forecast ?? { status: 'unknown' as const,
      reasonCodes: [period.status === 'closed' ? 'PERIOD_CLOSED' : 'PERIOD_NOT_ACTIVE_OR_CURRENT'],
      shortfallMinor: null, affectedDates: [] },
  };
}

export async function createBudgetPeriod(client: PoolClient, ownerId: string, input: BudgetPeriodCreateInput) {
  const facts = await loadFinanceAccountFacts(client, ownerId, input.accountId);
  const locked = (await client.query<{ financialVersion: string; status: string; accountType: string }>(
    `SELECT financial_version AS "financialVersion",status,account_type AS "accountType"
      FROM finance_accounts WHERE id=$1 AND owner_id=$2 FOR UPDATE`, [input.accountId, ownerId],
  )).rows[0];
  if (!locked || locked.status !== 'linked') throw new AppError(409, 'FINANCE_SCOPE_REVOKED', '账户不可用于新预算。');
  if (locked.accountType !== 'debit') throw new AppError(400, 'VALIDATION_ERROR', '月度预算只能使用借记账户。');
  if (amount(locked.financialVersion) !== input.expectedFinancialVersion) {
    throw new AppError(409, 'VERSION_CONFLICT', '账户资金版本已变化，请刷新后重试。',
      { financialVersion: amount(locked.financialVersion) });
  }
  const existing = await client.query(`SELECT 1 FROM budget_periods WHERE owner_id=$1
    AND primary_account_id=$2 AND month_start=$3::date LIMIT 1`,
  [ownerId, input.accountId, input.monthStart]);
  if (existing.rowCount) throw new AppError(409, 'VERSION_CONFLICT', '此账户的该自然月预算已存在。');
  const periodId = randomUUID();
  await client.query(`INSERT INTO budget_periods
    (id,owner_id,primary_account_id,baseline_snapshot_id,month_start,month_end,
      savings_target_minor,status) VALUES($1,$2,$3,$4,$5,$6,$7,'draft')`,
  [periodId, ownerId, input.accountId, facts.cashBasis.snapshotId,
    input.monthStart, monthEnd(input.monthStart), input.savingsTargetMinor]);
  await event(client, ownerId, periodId, 'budget_period_created', {
    accountId: input.accountId, monthStart: input.monthStart, savingsTargetMinor: input.savingsTargetMinor,
  });
  return readBudgetPeriod(client, ownerId, periodId);
}

export async function activateBudgetPeriod(client: PoolClient, ownerId: string,
  periodId: string, input: BudgetPeriodActivationInput) {
  const { account, period } = await accountThenPeriod(client, ownerId, periodId);
  checkPeriodVersion(period, input.expectedPeriodVersion);
  if (amount(account.financialVersion) !== input.expectedFinancialVersion) {
    throw new AppError(409, 'VERSION_CONFLICT', '资金依据已变化，请刷新后重试。');
  }
  if (period.status !== 'draft') throw new AppError(409, 'VERSION_CONFLICT', '仅草稿预算可激活。');
  if (period.monthStart !== `${todayShanghai().slice(0, 7)}-01`) {
    throw new AppError(409, 'FINANCE_BASIS_UNKNOWN', '只有当前自然月可以使用当前余额激活。');
  }
  const facts = await loadFinanceAccountFacts(client, ownerId, period.accountId);
  if (facts.cashBasis.dataStatus !== 'observed' || facts.obligations.dataStatus !== 'observed'
    || facts.cashBasis.snapshotId === null) {
    throw new AppError(409, 'FINANCE_BASIS_UNKNOWN', '资金快照或还款事实不足，不能激活预算。');
  }
  await client.query(`UPDATE budget_periods SET status='active',
    baseline_snapshot_id=$1,necessities_confirmed_at=now() WHERE id=$2 AND owner_id=$3`,
  [facts.cashBasis.snapshotId, periodId, ownerId]);
  await event(client, ownerId, periodId, 'budget_period_activated', {
    basisSnapshotId: facts.cashBasis.snapshotId, necessitiesConfirmedByUser: true,
  });
  return readBudgetPeriod(client, ownerId, periodId);
}

export async function changeSavingsTarget(client: PoolClient, ownerId: string,
  periodId: string, input: { newTargetMinor: number; expectedPeriodVersion: number; reason: string; confirmedByUser: true }) {
  const { period } = await accountThenPeriod(client, ownerId, periodId);
  checkPeriodVersion(period, input.expectedPeriodVersion);
  open(period);
  if (amount(period.target) === input.newTargetMinor) return { ...await readBudgetPeriod(client, ownerId, periodId), targetChangeId: null };
  const changeId = randomUUID();
  await client.query(`INSERT INTO budget_target_changes
    (id,owner_id,period_id,confirmed_by,previous_target_minor,new_target_minor,reason,basis_period_version)
    VALUES($1,$2,$3,$2,$4,$5,$6,$7)`,
  [changeId, ownerId, periodId, period.target, input.newTargetMinor, input.reason, period.version]);
  await client.query('UPDATE budget_periods SET savings_target_minor=$1 WHERE id=$2 AND owner_id=$3',
    [input.newTargetMinor, periodId, ownerId]);
  await event(client, ownerId, periodId, 'savings_target_changed', {
    targetChangeId: changeId, previousTargetMinor: amount(period.target),
    newTargetMinor: input.newTargetMinor, reason: input.reason,
  });
  return { ...await readBudgetPeriod(client, ownerId, periodId), targetChangeId: changeId };
}

export async function applyBudgetItemChange(client: PoolClient, ownerId: string,
  input: BudgetItemChangeInput): Promise<BudgetItemMutationResult> {
  const { period } = await accountThenPeriod(client, ownerId, input.periodId);
  checkPeriodVersion(period, input.expectedPeriodVersion);
  open(period);
  correctMonth(period, input.plannedOn);
  if (input.kind === 'essential_expense' && input.priority !== 'required') {
    throw new AppError(400, 'VALIDATION_ERROR', '必要支出必须标记为 required。');
  }
  let itemId = input.itemId;
  if (itemId === null) {
    itemId = randomUUID();
    await client.query(`INSERT INTO budget_items
      (id,owner_id,period_id,account_id,kind,title,category_code,planned_on,
        user_estimated_amount_minor,priority)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [itemId, ownerId, input.periodId, period.accountId, input.kind, input.title,
      input.categoryCode, input.plannedOn, input.userEstimatedAmountMinor, input.priority]);
    await event(client, ownerId, input.periodId, 'budget_item_created', {
      itemId, changeReason: input.changeReason,
    });
  } else {
    const current = await itemById(client, ownerId, input.periodId, itemId, true);
    if (current.status !== 'planned') {
      throw new AppError(409, 'ITEM_NOT_ORDERABLE', '已承诺、已结算或已取消项目不能直接改写。');
    }
    await noOpenIntent(client, ownerId, itemId);
    await client.query(`UPDATE budget_items SET kind=$1,title=$2,category_code=$3,planned_on=$4,
      user_estimated_amount_minor=$5,priority=$6 WHERE id=$7 AND owner_id=$8 AND period_id=$9`,
    [input.kind, input.title, input.categoryCode, input.plannedOn,
      input.userEstimatedAmountMinor, input.priority, itemId, ownerId, input.periodId]);
    await event(client, ownerId, input.periodId, 'budget_item_changed', {
      itemId, previousItemVersion: amount(current.version), changeReason: input.changeReason,
    });
  }
  const updated = await itemById(client, ownerId, input.periodId, itemId);
  const result = await readBudgetPeriod(client, ownerId, input.periodId);
  return { item: view(updated), basis: result.basis };
}

export async function cancelBudgetItem(client: PoolClient, ownerId: string,
  input: BudgetItemCancelInput): Promise<BudgetItemMutationResult> {
  const { period } = await accountThenPeriod(client, ownerId, input.periodId);
  checkPeriodVersion(period, input.expectedPeriodVersion);
  open(period);
  const current = await itemById(client, ownerId, input.periodId, input.itemId, true);
  if (current.status !== 'cancelled') {
    if (current.status !== 'planned') {
      throw new AppError(409, 'ITEM_NOT_ORDERABLE', '已承诺或已结算项目需走善后，不能直接取消。');
    }
    await noOpenIntent(client, ownerId, input.itemId);
    await client.query(`UPDATE budget_items SET status='cancelled' WHERE id=$1 AND owner_id=$2 AND period_id=$3`,
      [input.itemId, ownerId, input.periodId]);
    await event(client, ownerId, input.periodId, 'budget_item_cancelled', {
      itemId: input.itemId, reason: input.reason,
    });
  }
  const result = await readBudgetPeriod(client, ownerId, input.periodId);
  return { item: view(await itemById(client, ownerId, input.periodId, input.itemId)), basis: result.basis };
}
