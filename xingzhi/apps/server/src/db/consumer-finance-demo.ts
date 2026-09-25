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

function monthDate(monthStart: string, today: string, preferredDay: number) {
  const currentDay = Number(today.slice(8, 10));
  return `${monthStart.slice(0, 8)}${String(Math.max(1, Math.min(currentDay, preferredDay))).padStart(2, '0')}`;
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
  const nextMonthStartDate = new Date(`${monthStart}T00:00:00Z`);
  nextMonthStartDate.setUTCMonth(nextMonthStartDate.getUTCMonth() + 1);
  const nextMonthStart = nextMonthStartDate.toISOString().slice(0, 10);
  const nextMonthEndDate = new Date(nextMonthStartDate);
  nextMonthEndDate.setUTCMonth(nextMonthEndDate.getUTCMonth() + 1);
  nextMonthEndDate.setUTCDate(0);
  const nextMonthEnd = nextMonthEndDate.toISOString().slice(0, 10);
  const ownerId = consumer.id;

  // A revoked authorization is immutable. Serialize this small fixture allocation so a
  // later local seed can create a distinct demo authorization instead of reactivating it.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`xingzhi-a00:${ownerId}`]);
  const existingAccounts = (await client.query<{
    id: string; provider_account_ref: string; status: string;
  }>(`SELECT id,provider_account_ref,status FROM finance_accounts
      WHERE owner_id=$1 AND provider='demo' AND source='demo' AND account_type='debit'
        AND (provider_account_ref='A00-DEMO-DEBIT'
          OR provider_account_ref ~ '^A00-DEMO-DEBIT-R([2-9]|[1-9][0-9]+)$')
      FOR UPDATE`, [ownerId])).rows;
  const generationOf = (ref: string) => ref === 'A00-DEMO-DEBIT'
    ? 1
    : Number(ref.slice('A00-DEMO-DEBIT-R'.length));
  // Only reuse an untouched fixture. A linked Demo account may already contain
  // user edits, later snapshots, purchases or ledger facts; reusing it would
  // make a new local seed depend on yesterday's state and can invalidate today's
  // quotes. In that case allocate a new Demo generation without overwriting the
  // existing history.
  let reusable: (typeof existingAccounts)[number] | undefined;
  const linkedNewestFirst = existingAccounts
    .filter((account) => account.status === 'linked')
    .sort((left, right) => generationOf(right.provider_account_ref) - generationOf(left.provider_account_ref));
  for (const candidate of linkedNewestFirst) {
    const candidateGeneration = generationOf(candidate.provider_account_ref);
    const candidateIdentity = candidateGeneration === 1 ? '' : `:R${candidateGeneration}`;
    const candidateSnapshotId = stableUuid(`${demoEmail}:initial-observed-2000${candidateIdentity}`);
    const candidatePeriodId = stableUuid(`${demoEmail}:${monthStart}:period${candidateIdentity}`);
    const candidateGenerationSuffix = candidateGeneration === 1 ? '' : `-R${candidateGeneration}`;
    const candidateLedgerPattern = `A00${candidateGenerationSuffix}-LEDGER-%`;
    const pristine = (await client.query<{ ok: boolean }>(`SELECT
      EXISTS (SELECT 1 FROM finance_account_snapshots s WHERE s.id=$2 AND s.account_id=$1
        AND s.available_balance_minor=200000 AND s.fact_status='observed')
      AND (SELECT count(*) FROM finance_account_snapshots WHERE account_id=$1)=1
      AND NOT EXISTS (SELECT 1 FROM finance_ledger_entries WHERE account_id=$1
        AND (source<>'demo' OR COALESCE(source_ref,'') NOT LIKE $7))
      AND EXISTS (SELECT 1 FROM budget_periods p WHERE p.id=$3 AND p.primary_account_id=$1
        AND p.month_start=$4::date AND p.month_end=$5::date AND p.status='active'
        AND p.savings_target_minor=50000)
      AND (SELECT count(*) FROM budget_items WHERE period_id=$3)=3
      AND EXISTS (SELECT 1 FROM budget_items WHERE period_id=$3 AND title='朋友聚餐'
        AND planned_on=$6::date AND user_estimated_amount_minor=8000 AND status='planned')
      AND NOT EXISTS (SELECT 1 FROM purchase_intents WHERE period_id=$3)
      AND NOT EXISTS (SELECT 1 FROM orders WHERE budget_period_id=$3) AS ok`,
    [candidate.id, candidateSnapshotId, candidatePeriodId, monthStart, monthEndText, today,
      candidateLedgerPattern])).rows[0]?.ok;
    if (pristine) { reusable = candidate; break; }
  }
  const generation = reusable
    ? generationOf(reusable.provider_account_ref)
    : Math.max(0, ...existingAccounts.map((account) => generationOf(account.provider_account_ref))) + 1;
  const generationSuffix = generation === 1 ? '' : `-R${generation}`;
  const identitySuffix = generation === 1 ? '' : `:R${generation}`;
  const providerAccountRef = `A00-DEMO-DEBIT${generationSuffix}`;
  const accountId = reusable?.id ?? stableUuid(`${demoEmail}:debit${identitySuffix}`);
  const snapshotId = stableUuid(`${demoEmail}:initial-observed-2000${identitySuffix}`);
  const periodId = stableUuid(`${demoEmail}:${monthStart}:period${identitySuffix}`);

  await client.query(`INSERT INTO finance_accounts
    (id,owner_id,provider,account_type,provider_account_ref,masked_identifier,display_name,source,authorized_at)
    VALUES($1,$2,'demo','debit',$3,'****A00','行止 Demo 生活费账户','demo',$4)
    ON CONFLICT (id) DO NOTHING`, [accountId, ownerId, providerAccountRef, now]);
  const account = (await client.query<{
    owner_id: string; provider: string; account_type: string; provider_account_ref: string;
    status: string; source: string;
  }>(`SELECT owner_id,provider,account_type,provider_account_ref,status,source
      FROM finance_accounts WHERE id=$1 FOR UPDATE`, [accountId],
  )).rows[0];
  if (!account || account.owner_id !== ownerId || account.provider !== 'demo'
    || account.account_type !== 'debit' || account.provider_account_ref !== providerAccountRef
    || account.source !== 'demo' || account.status !== 'linked') {
    throw new Error('A00 Demo 账户缺失、身份或归属不符；不会覆盖或重新激活。');
  }

  await client.query(`INSERT INTO finance_account_snapshots
    (id,account_id,available_balance_minor,current_balance_minor,as_of,covered_through_at,
      fact_status,source,provider_snapshot_ref)
    VALUES($1,$2,200000,200000,$3,$3,'observed','demo',$4)
    ON CONFLICT (id) DO NOTHING`, [snapshotId, accountId, now, `A00-INITIAL-2000${generationSuffix}`]);
  const snapshot = (await client.query<{
    account_id: string; available_balance_minor: number | null; fact_status: string;
    covered_through_at: Date | null;
  }>('SELECT account_id,available_balance_minor,fact_status,covered_through_at FROM finance_account_snapshots WHERE id=$1', [snapshotId])).rows[0];
  if (!snapshot || snapshot.account_id !== accountId || snapshot.available_balance_minor !== 200000
    || snapshot.fact_status !== 'observed' || snapshot.covered_through_at === null) {
    throw new Error('A00 Demo 快照已被修改；不会覆盖原有资金事实。');
  }

  // These posted Demo entries happened before the observed snapshot and are therefore
  // visible in the ledger without being counted a second time in current cash.
  const ledger = [
    { code: 'salary', day: 3, direction: 'inflow', amount: 850000, category: 'income', merchant: null, note: '本月工资' },
    { code: 'rent', day: 5, direction: 'outflow', amount: 220000, category: 'housing', merchant: '安心公寓', note: '本月房租' },
    { code: 'market', day: 8, direction: 'outflow', amount: 8650, category: 'shopping', merchant: '盒马鲜生', note: '日常采购' },
    { code: 'metro', day: 10, direction: 'outflow', amount: 600, category: 'transport', merchant: '上海地铁', note: '通勤出行' },
    { code: 'coffee', day: 12, direction: 'outflow', amount: 2800, category: 'food', merchant: 'Manner Coffee', note: '咖啡' },
    { code: 'utilities', day: 15, direction: 'outflow', amount: 12640, category: 'utilities', merchant: '生活缴费', note: '水电燃气' },
    { code: 'dinner', day: 18, direction: 'outflow', amount: 16800, category: 'food', merchant: '小满手工粉', note: '朋友聚餐' },
    { code: 'refund', day: 20, direction: 'inflow', amount: 4590, category: 'refund', merchant: '电商平台', note: '退货退款到账' },
  ] as const;
  for (const entry of ledger) {
    const entryId = stableUuid(`${demoEmail}:ledger:${entry.code}${identitySuffix}`);
    const sourceRef = `A00${generationSuffix}-LEDGER-${entry.code.toUpperCase()}`;
    const occurredAt = `${monthDate(monthStart, today, entry.day)}T${entry.code === 'salary' ? '09:12:00' : '18:36:00'}+08:00`;
    await client.query(`INSERT INTO finance_ledger_entries
      (id,owner_id,account_id,source,source_ref,direction,amount_minor,occurred_at,posted_at,
        status,category,merchant_name,note,dedupe_key)
      VALUES($1,$2,$3,'demo',$4,$5,$6,$7,$7,'posted',$8,$9,$10,$4)
      ON CONFLICT (id) DO NOTHING`, [entryId, ownerId, accountId, sourceRef, entry.direction,
      entry.amount, occurredAt, entry.category, entry.merchant, entry.note]);
    const stored = (await client.query<{ account_id: string; direction: string; amount_minor: number }>(
      'SELECT account_id,direction,amount_minor FROM finance_ledger_entries WHERE id=$1', [entryId],
    )).rows[0];
    if (!stored || stored.account_id !== accountId || stored.direction !== entry.direction
      || Number(stored.amount_minor) !== entry.amount) {
      throw new Error('A00 Demo 账目已被修改；不会覆盖已有资金事实。');
    }
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
    const itemId = stableUuid(`${demoEmail}:${monthStart}:${item.code}${identitySuffix}`);
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

  // A rolling 30-day view can cross a calendar boundary. Prepare a lightweight
  // adjacent Demo period so the chart stays continuous instead of turning unknown.
  const nextPeriodId = stableUuid(`${demoEmail}:${nextMonthStart}:period${identitySuffix}`);
  await client.query(`INSERT INTO budget_periods
    (id,owner_id,primary_account_id,baseline_snapshot_id,month_start,month_end,
      savings_target_minor,status,necessities_confirmed_at)
    VALUES($1,$2,$3,$4,$5,$6,50000,'active',$7)
    ON CONFLICT (id) DO NOTHING`, [nextPeriodId, ownerId, accountId, snapshotId,
    nextMonthStart, nextMonthEnd, now]);
  const nextPeriod = (await client.query<{
    owner_id: string; primary_account_id: string; month_start: string; status: string;
  }>(`SELECT owner_id,primary_account_id,to_char(month_start,'YYYY-MM-DD') AS month_start,status
      FROM budget_periods WHERE id=$1`, [nextPeriodId])).rows[0];
  if (!nextPeriod || nextPeriod.owner_id !== ownerId || nextPeriod.primary_account_id !== accountId
    || nextPeriod.month_start !== nextMonthStart || nextPeriod.status !== 'active') {
    throw new Error('A00 Demo 下月周期已被修改；不会覆盖已有计划。');
  }
  await client.query(`INSERT INTO budget_items
    (id,owner_id,period_id,account_id,kind,title,planned_on,user_estimated_amount_minor,priority)
    VALUES($1,$2,$3,$4,'essential_expense','下月房租与必要开支',$5,90000,'required')
    ON CONFLICT (id) DO NOTHING`, [stableUuid(`${demoEmail}:${nextMonthStart}:essentials${identitySuffix}`),
    ownerId, nextPeriodId, accountId, nextMonthEnd]);

  // Make a freshly prepared local account visible immediately, while preserving
  // any account the tester has already selected explicitly.
  await client.query(`INSERT INTO consumer_preferences(owner_id,default_account_id)
    VALUES($1,$2)
    ON CONFLICT(owner_id) DO UPDATE SET
      default_account_id=COALESCE(consumer_preferences.default_account_id,EXCLUDED.default_account_id),
      updated_at=CASE WHEN consumer_preferences.default_account_id IS NULL THEN now()
        ELSE consumer_preferences.updated_at END`, [ownerId, accountId]);

  return {
    ownerId, accountId, snapshotId, periodId, monthStart, monthEnd: monthEndText,
    confirmedCashMinor: 200000, savingsTargetMinor: 50000,
    essentialExpenseMinor: 90000, adjustablePlannedMinor: 40000,
    dinnerItemId: stableUuid(`${demoEmail}:${monthStart}:dinner${identitySuffix}`), dinnerEstimatedMinor: 8000,
    source: 'demo' as const,
  };
}
