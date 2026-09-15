import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

const demoEmail = 'consumer-a@xingzhi.local';

function stableUuid(label: string) {
  const hex = createHash('sha256').update(`xingzhi-a00:${label}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function shanghaiToday(now: Date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export async function seedConsumerFinanceDemo(client: PoolClient, now = new Date()) {
  const consumer = (await client.query<{ id: string }>(
    "SELECT id FROM users WHERE email=$1 AND role='consumer'", [demoEmail],
  )).rows[0];
  if (!consumer) throw new Error('请先运行旧 db:seed，准备 consumer-a 本地测试账号。');

  const today = shanghaiToday(now);
  const monthStart = `${today.slice(0, 7)}-01`;
  const monthEnd = new Date(`${monthStart}T00:00:00Z`);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
  monthEnd.setUTCDate(0);
  const monthEndText = monthEnd.toISOString().slice(0, 10);
  const ownerId = consumer.id;
  const accountId = stableUuid(`${demoEmail}:debit`);
  const snapshotId = stableUuid(`${demoEmail}:initial-observed-2000`);
  const periodId = stableUuid(`${demoEmail}:${monthStart}:period`);

  await client.query(`INSERT INTO finance_accounts
    (id,owner_id,provider,account_type,provider_account_ref,masked_identifier,display_name,source,authorized_at)
    VALUES($1,$2,'demo','debit','A00-DEMO-DEBIT','****A00','行止 Demo 生活费账户','demo',$3)
    ON CONFLICT (id) DO NOTHING`, [accountId, ownerId, now]);
  const account = (await client.query<{ owner_id: string; status: string; source: string }>(
    'SELECT owner_id,status,source FROM finance_accounts WHERE id=$1 FOR UPDATE', [accountId],
  )).rows[0];
  if (!account || account.owner_id !== ownerId || account.source !== 'demo' || account.status !== 'linked') {
    throw new Error('A00 Demo 账户缺失、归属不符或已撤回；不会重新激活。');
  }

  await client.query(`INSERT INTO finance_account_snapshots
    (id,account_id,available_balance_minor,current_balance_minor,as_of,covered_through_at,
      fact_status,source,provider_snapshot_ref)
    VALUES($1,$2,200000,200000,$3,$3,'observed','demo','A00-INITIAL-2000')
    ON CONFLICT (id) DO NOTHING`, [snapshotId, accountId, now]);
  const snapshot = (await client.query<{
    account_id: string; available_balance_minor: number | null; fact_status: string;
    covered_through_at: Date | null;
  }>('SELECT account_id,available_balance_minor,fact_status,covered_through_at FROM finance_account_snapshots WHERE id=$1', [snapshotId])).rows[0];
  if (!snapshot || snapshot.account_id !== accountId || snapshot.available_balance_minor !== 200000
    || snapshot.fact_status !== 'observed' || snapshot.covered_through_at === null) {
    throw new Error('A00 Demo 快照已被修改；不会覆盖原有资金事实。');
  }

  await client.query(`INSERT INTO budget_periods
    (id,owner_id,primary_account_id,baseline_snapshot_id,month_start,month_end,savings_target_minor,status)
    VALUES($1,$2,$3,$4,$5,$6,50000,'active')
    ON CONFLICT (id) DO NOTHING`, [periodId, ownerId, accountId, snapshotId, monthStart, monthEndText]);
  const period = (await client.query<{
    owner_id: string; primary_account_id: string; savings_target_minor: string; status: string;
  }>('SELECT owner_id,primary_account_id,savings_target_minor,status FROM budget_periods WHERE id=$1 FOR UPDATE', [periodId])).rows[0];
  if (!period || period.owner_id !== ownerId || period.primary_account_id !== accountId
    || Number(period.savings_target_minor) !== 50000 || period.status !== 'active') {
    throw new Error('A00 Demo 周期已被修改或关闭；不会覆盖用户目标。');
  }

  const items = [
    { code: 'essentials', title: '房租与本月必要开支', kind: 'essential_expense', amount: 90000, priority: 'required', day: monthEndText },
    { code: 'dinner', title: '朋友聚餐', kind: 'planned_spend', amount: 8000, priority: 'adjustable', day: today },
    { code: 'flexible', title: '其他可调生活开支', kind: 'planned_spend', amount: 32000, priority: 'adjustable', day: monthEndText },
  ] as const;
  for (const item of items) {
    const itemId = stableUuid(`${demoEmail}:${monthStart}:${item.code}`);
    await client.query(`INSERT INTO budget_items
      (id,owner_id,period_id,account_id,kind,title,category_code,planned_on,
        user_estimated_amount_minor,priority)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (id) DO NOTHING`, [
      itemId, ownerId, periodId, accountId,
      item.kind, item.title, item.code === 'dinner' ? 'food' : null, item.day,
      item.amount, item.priority,
    ]);
    const stored = (await client.query<{
      owner_id: string; period_id: string; account_id: string; kind: string;
      user_estimated_amount_minor: string; priority: string;
    }>(`SELECT owner_id,period_id,account_id,kind,user_estimated_amount_minor,priority
      FROM budget_items WHERE id=$1`, [itemId])).rows[0];
    if (!stored || stored.owner_id !== ownerId || stored.period_id !== periodId
      || stored.account_id !== accountId || stored.kind !== item.kind
      || Number(stored.user_estimated_amount_minor) !== item.amount || stored.priority !== item.priority) {
      throw new Error('A00 Demo 项目已被修改；不会覆盖用户预计金额。');
    }
  }

  return {
    ownerId, accountId, snapshotId, periodId, monthStart, monthEnd: monthEndText,
    confirmedCashMinor: 200000, savingsTargetMinor: 50000,
    essentialExpenseMinor: 90000, adjustablePlannedMinor: 40000,
    dinnerItemId: stableUuid(`${demoEmail}:${monthStart}:dinner`), dinnerEstimatedMinor: 8000,
    source: 'demo' as const,
  };
}
