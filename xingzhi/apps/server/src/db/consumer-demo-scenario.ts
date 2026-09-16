import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { hashPassword } from '../auth/password.js';
import { seedConsumerCatalog } from './consumer-catalog.js';

function stableUuid(label: string) {
  const hex = createHash('sha256').update(`xingzhi-m1:${label}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function shanghaiToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric',
    month: '2-digit', day: '2-digit' }).format(now);
}

export async function seedConsumerDemoScenario(client: PoolClient, input: {
  scenarioKey: string; serviceOn: string; password: string; now?: Date;
}) {
  if (!/^[a-z0-9][a-z0-9_-]{2,79}$/.test(input.scenarioKey)) {
    throw new Error('场景标识只能包含小写字母、数字、下划线和连字符。');
  }
  const now = input.now ?? new Date();
  if (input.serviceOn !== shanghaiToday(now)) throw new Error('隔离 Demo 服务日期必须是当前上海日期。');
  const existing = (await client.query<{
    ownerId: string; accountId: string; periodId: string; serviceOn: string; createdAt: Date;
  }>(`SELECT owner_id AS "ownerId",account_id AS "accountId",period_id AS "periodId",
      to_char(service_on,'YYYY-MM-DD') AS "serviceOn",created_at AS "createdAt"
    FROM consumer_demo_scenarios WHERE scenario_key=$1 FOR UPDATE`, [input.scenarioKey])).rows[0];
  if (existing) return { scenarioKey: input.scenarioKey, ...existing,
    createdAt: existing.createdAt.toISOString(), reused: true };

  const email = `m1-${input.scenarioKey}@xingzhi.local`;
  const ownerId = stableUuid(`${input.scenarioKey}:owner`);
  const accountId = stableUuid(`${input.scenarioKey}:debit`);
  const liabilityAccountId = stableUuid(`${input.scenarioKey}:credit`);
  const snapshotId = stableUuid(`${input.scenarioKey}:snapshot`);
  const periodId = stableUuid(`${input.scenarioKey}:period`);
  const monthStart = `${input.serviceOn.slice(0, 7)}-01`;
  const end = new Date(`${monthStart}T00:00:00Z`); end.setUTCMonth(end.getUTCMonth() + 1); end.setUTCDate(0);
  const monthEnd = end.toISOString().slice(0, 10);
  await client.query(`INSERT INTO users(id,email,display_name,role,password_hash)
    VALUES($1,$2,$3,'consumer',$4)`, [ownerId, email, `M1隔离场景 ${input.scenarioKey}`,
    await hashPassword(input.password)]);
  // Directory lists sort by created_at,id; the same-statement now() would tie
  // both accounts and make the random UUID order decide. Keep the primary
  // debit account deterministically first by staggering created_at by 1ms.
  await client.query(`INSERT INTO finance_accounts
      (id,owner_id,provider,account_type,provider_account_ref,masked_identifier,display_name,source,authorized_at,created_at)
    VALUES($1,$2,'demo','debit',$3,'****M1','M1 隔离生活费账户','demo',$4,$4),
      ($5,$2,'demo','credit',$6,'****CR','M1 隔离信用账户','demo',$4,$7)`,
  [accountId, ownerId, `M1-${input.scenarioKey}-DEBIT`, now, liabilityAccountId,
    `M1-${input.scenarioKey}-CREDIT`, new Date(now.getTime() + 1)]);
  await client.query(`INSERT INTO finance_account_snapshots
      (id,account_id,available_balance_minor,current_balance_minor,as_of,covered_through_at,
        fact_status,source,provider_snapshot_ref)
    VALUES($1,$2,200000,200000,$3,$3,'observed','demo',$4)`,
  [snapshotId, accountId, now, `M1-${input.scenarioKey}-2000`]);
  const billId = stableUuid(`${input.scenarioKey}:bill`);
  await client.query(`INSERT INTO finance_obligations
      (id,owner_id,liability_account_id,repayment_account_id,obligation_type,label,due_on,
        amount_due_minor,outstanding_minor,status,source,source_ref)
    VALUES($1,$2,$3,$4,'credit_bill','本月信用账单',$5,10000,10000,'upcoming','demo',$6)`,
  [billId, ownerId, liabilityAccountId, accountId, monthEnd, `M1-${input.scenarioKey}-BILL`]);
  await client.query(`INSERT INTO finance_obligations
      (id,owner_id,liability_account_id,repayment_account_id,obligation_type,label,due_on,
        amount_due_minor,outstanding_minor,status,included_in_obligation_id,source,source_ref,
        sequence_no,sequence_total)
    VALUES($1,$2,$3,$4,'installment','账单内分期',$5,10000,10000,'upcoming',$6,'demo',$7,1,3)`,
  [stableUuid(`${input.scenarioKey}:installment`), ownerId, liabilityAccountId, accountId,
    monthEnd, billId, `M1-${input.scenarioKey}-INSTALLMENT`]);
  await client.query(`INSERT INTO budget_periods
      (id,owner_id,primary_account_id,baseline_snapshot_id,month_start,month_end,
        savings_target_minor,status,necessities_confirmed_at)
    VALUES($1,$2,$3,$4,$5,$6,50000,'active',$7)`,
  [periodId, ownerId, accountId, snapshotId, monthStart, monthEnd, now]);
  const items = [
    ['rent', '房租与本月必要开支', 'essential_expense', 80000, 'required', monthEnd, null],
    ['dinner', '朋友聚餐', 'planned_spend', 8000, 'adjustable', input.serviceOn, 'food'],
    ['flexible', '其他可调生活开支', 'planned_spend', 32000, 'adjustable', monthEnd, null],
  ] as const;
  for (const [code, title, kind, amount, priority, plannedOn, category] of items) {
    await client.query(`INSERT INTO budget_items
        (id,owner_id,period_id,account_id,kind,title,category_code,planned_on,
          user_estimated_amount_minor,priority)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [stableUuid(`${input.scenarioKey}:${code}`),
    ownerId, periodId, accountId, kind, title, category, plannedOn, amount, priority]);
  }
  await seedConsumerCatalog(client, input.serviceOn);
  await client.query(`INSERT INTO consumer_demo_scenarios
    (scenario_key,owner_id,account_id,period_id,service_on) VALUES($1,$2,$3,$4,$5)`,
  [input.scenarioKey, ownerId, accountId, periodId, input.serviceOn]);
  return { scenarioKey: input.scenarioKey, ownerId, accountId, periodId, serviceOn: input.serviceOn,
    snapshotAsOf: now.toISOString(), quoteValidThrough: `${input.serviceOn}T23:59:59+08:00`,
    email, confirmedCashMinor: 200000, savingsTargetMinor: 50000,
    essentialAndRepaymentMinor: 90000, adjustablePlannedMinor: 40000,
    createdAt: now.toISOString(), reused: false };
}
