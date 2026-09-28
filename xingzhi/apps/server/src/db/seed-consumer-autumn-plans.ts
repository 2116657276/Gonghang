import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { forecastBudgetCashflow } from '../domain/budget-cashflow.js';
import { closePool, transaction } from './client.js';

// Local Demo plans only. Expected salary is never inserted as posted cash.
const ownerId = 'a0a46a8c-72aa-4e19-93ab-01984b079676';
const accountId = '63c048c6-a72f-5cbb-a949-163daa9fc29d';
const septemberPeriodId = '411a1be6-ff79-5a73-a691-a538737ff5f9';
const prefix = 'XZ-DEMO-2026-AUTUMN-';
type PlannedItem = { day: string; title: string; kind: 'expected_income' | 'essential_expense' | 'planned_spend';
  category: string; amount: number; priority: 'required' | 'adjustable' };
const months: Array<{ month: string; end: string; target: number; items: PlannedItem[] }> = [
  { month: '2026-10-01', end: '2026-10-31', target: 50000, items: [
    { day: '2026-10-03', title: '通勤交通预算', kind: 'essential_expense', category: 'transport', amount: 12000, priority: 'required' },
    { day: '2026-10-05', title: '合租房租', kind: 'essential_expense', category: 'housing', amount: 210000, priority: 'required' },
    { day: '2026-10-09', title: '手机话费', kind: 'essential_expense', category: 'utilities', amount: 5900, priority: 'required' },
    { day: '2026-10-10', title: '十月工资（预计到账）', kind: 'expected_income', category: 'income', amount: 620000, priority: 'required' },
    { day: '2026-10-15', title: '本月日常采购预算', kind: 'essential_expense', category: 'shopping', amount: 26000, priority: 'required' },
    { day: '2026-10-18', title: '水电燃气预留', kind: 'essential_expense', category: 'utilities', amount: 12000, priority: 'required' },
    { day: '2026-10-24', title: '朋友生日聚餐', kind: 'planned_spend', category: 'food', amount: 18000, priority: 'adjustable' },
  ] },
  { month: '2026-11-01', end: '2026-11-30', target: 50000, items: [
    { day: '2026-11-03', title: '通勤交通预算', kind: 'essential_expense', category: 'transport', amount: 12000, priority: 'required' },
    { day: '2026-11-05', title: '合租房租', kind: 'essential_expense', category: 'housing', amount: 210000, priority: 'required' },
    { day: '2026-11-09', title: '手机话费', kind: 'essential_expense', category: 'utilities', amount: 5900, priority: 'required' },
    { day: '2026-11-10', title: '十一月工资（预计到账）', kind: 'expected_income', category: 'income', amount: 620000, priority: 'required' },
    { day: '2026-11-14', title: '本月日常采购预算', kind: 'essential_expense', category: 'shopping', amount: 28000, priority: 'required' },
    { day: '2026-11-18', title: '水电燃气预留', kind: 'essential_expense', category: 'utilities', amount: 13000, priority: 'required' },
    { day: '2026-11-21', title: '门诊小手术及复查预留', kind: 'essential_expense', category: 'health', amount: 120000, priority: 'required' },
    { day: '2026-11-26', title: '换季衣物', kind: 'planned_spend', category: 'shopping', amount: 38000, priority: 'adjustable' },
  ] },
  { month: '2026-12-01', end: '2026-12-31', target: 50000, items: [
    { day: '2026-12-03', title: '通勤交通预算', kind: 'essential_expense', category: 'transport', amount: 12000, priority: 'required' },
    { day: '2026-12-05', title: '合租房租', kind: 'essential_expense', category: 'housing', amount: 210000, priority: 'required' },
    { day: '2026-12-09', title: '手机话费', kind: 'essential_expense', category: 'utilities', amount: 5900, priority: 'required' },
    { day: '2026-12-10', title: '十二月工资（预计到账）', kind: 'expected_income', category: 'income', amount: 620000, priority: 'required' },
    { day: '2026-12-15', title: '本月日常采购预算', kind: 'essential_expense', category: 'shopping', amount: 30000, priority: 'required' },
    { day: '2026-12-18', title: '水电燃气预留', kind: 'essential_expense', category: 'utilities', amount: 14000, priority: 'required' },
    { day: '2026-12-24', title: '年末短途旅行', kind: 'planned_spend', category: 'entertainment', amount: 98000, priority: 'adjustable' },
    { day: '2026-12-31', title: '跨年聚餐', kind: 'planned_spend', category: 'food', amount: 22000, priority: 'adjustable' },
  ] },
];

function stableId(label: string) {
  const hex = createHash('sha256').update(`${prefix}${label}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }

async function seed(client: PoolClient) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${prefix}${accountId}`]);
  const identity = (await client.query<{ email: string; role: string }>(
    'SELECT email,role FROM users WHERE id=$1', [ownerId])).rows[0];
  assert(identity?.email === 'consumer-a@xingzhi.local' && identity.role === 'consumer', '目标用户身份已变化。');
  const account = (await client.query<{ owner_id: string; provider_account_ref: string;
    source: string; status: string; account_type: string }>(
    'SELECT * FROM finance_accounts WHERE id=$1 FOR UPDATE', [accountId])).rows[0];
  assert(account?.owner_id === ownerId && account.provider_account_ref === 'A00-DEMO-DEBIT'
    && account.source === 'demo' && account.status === 'linked' && account.account_type === 'debit',
  '小程序主账户已变化。');
  const preferred = (await client.query<{ default_account_id: string | null }>(
    'SELECT default_account_id FROM consumer_preferences WHERE owner_id=$1', [ownerId])).rows[0];
  assert(preferred?.default_account_id === accountId, '默认规划账户不是目标 Demo 账户。');
  const september = (await client.query<{ status: string; primary_account_id: string }>(
    'SELECT status,primary_account_id FROM budget_periods WHERE id=$1 AND owner_id=$2',
    [septemberPeriodId, ownerId])).rows[0];
  assert(september?.status === 'active' && september.primary_account_id === accountId,
    '九月演示周期已变化。');
  const snapshot = (await client.query<{ id: string; source: string; fact_status: string;
    provider_snapshot_ref: string | null }>(`SELECT id,source,fact_status,provider_snapshot_ref
    FROM finance_account_snapshots WHERE account_id=$1 ORDER BY as_of DESC,captured_at DESC LIMIT 1`,
  [accountId])).rows[0];
  assert(snapshot?.source === 'demo' && snapshot.fact_status === 'observed'
    && snapshot.provider_snapshot_ref?.startsWith('XZ-202609-A00-DAILY-SNAPSHOT'),
  '账户最新余额依据不是预期的九月 Demo 快照。');
  const existing = (await client.query<{ id: string; month_start: string; status: string;
    baseline_snapshot_id: string | null; savings_target_minor: string }>(`SELECT id,
    to_char(month_start,'YYYY-MM-DD') AS month_start,status,baseline_snapshot_id,
    savings_target_minor FROM budget_periods WHERE owner_id=$1 AND primary_account_id=$2
    AND month_start BETWEEN '2026-10-01' AND '2026-12-01' ORDER BY month_start FOR UPDATE`,
  [ownerId, accountId])).rows;
  if (existing.length) {
    assert(existing.length === months.length, '十月至十二月已存在其他计划，停止写入。');
    for (const month of months) {
      const periodId = stableId(`period-${month.month}`);
      const row = existing.find(value => value.month_start === month.month);
      assert(row?.id === periodId && row.status === 'active'
        && row.baseline_snapshot_id === snapshot.id
        && Number(row.savings_target_minor) === month.target, `${month.month} 已被其他数据修改。`);
      const items = (await client.query<{ id: string; title: string; kind: string; category_code: string;
        planned_on: string; user_estimated_amount_minor: string; priority: string; status: string }>(`SELECT id,title,kind,
        category_code,to_char(planned_on,'YYYY-MM-DD') AS planned_on,user_estimated_amount_minor,
        priority,status FROM budget_items WHERE period_id=$1 ORDER BY id`, [periodId])).rows;
      assert(items.length === month.items.length && month.items.every(item => items.some(row =>
        row.id === stableId(`item-${month.month}-${item.title}`) && row.title === item.title
        && row.kind === item.kind && row.category_code === item.category
        && row.planned_on === item.day && Number(row.user_estimated_amount_minor) === item.amount
        && row.priority === item.priority && row.status === 'planned')),
      `${month.month} 演示项目已被修改，停止写入。`);
    }
  } else {
    for (const month of months) {
      const periodId = stableId(`period-${month.month}`);
      await client.query(`INSERT INTO budget_periods
        (id,owner_id,primary_account_id,baseline_snapshot_id,month_start,month_end,
         savings_target_minor,status)
        VALUES($1,$2,$3,$4,$5::date,$6::date,$7,'active')`,
      [periodId, ownerId, accountId, snapshot.id, month.month, month.end, month.target]);
      await client.query(`INSERT INTO budget_events(owner_id,period_id,actor_id,type,data)
        VALUES($1,$2,NULL,'demo_future_period_seeded',$3::jsonb)`,
      [ownerId, periodId, JSON.stringify({ accountId, monthStart: month.month,
        expectedIncomeIsDisplayOnly: true, notUserActivated: true })]);
      for (const item of month.items) await client.query(`INSERT INTO budget_items
        (id,owner_id,period_id,account_id,kind,title,category_code,planned_on,
         user_estimated_amount_minor,priority,status)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10,'planned')`,
      [stableId(`item-${month.month}-${item.title}`), ownerId, periodId, accountId,
        item.kind, item.title, item.category, item.day, item.amount, item.priority]);
    }
  }
  const rolling = await forecastBudgetCashflow(client, ownerId, septemberPeriodId, { rolling30: true });
  assert(rolling.forecast.daily.length === 30
    && rolling.forecast.daily.every(day => day.projectedCashMinor !== null)
    && !rolling.forecast.reasonCodes.includes('ADJACENT_PERIOD_UNKNOWN'),
  '九月起算的 30 天走势仍有未知日期；事务已回滚。');
  return { addedPeriods: existing.length ? 0 : months.length,
    addedItems: existing.length ? 0 : months.reduce((sum, month) => sum + month.items.length, 0),
    rollingStatus: rolling.forecast.status, knownDays: rolling.forecast.daily.length,
    minimumProjectedCashMinor: rolling.forecast.minimumProjectedCashMinor,
    expectedIncomeExcludedFromCash: true };
}

try { console.log(JSON.stringify(await transaction(seed))); }
finally { await closePool(); }
