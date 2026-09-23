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
  mode?: 'complete' | 'account-only';
  aftercareMode?: 'automatic' | 'merchant-review';
}) {
  if (!/^[a-z0-9][a-z0-9_-]{2,79}$/.test(input.scenarioKey)) {
    throw new Error('场景标识只能包含小写字母、数字、下划线和连字符。');
  }
  const now = input.now ?? new Date();
  const mode = input.mode ?? 'complete';
  const aftercareMode = input.aftercareMode ?? 'automatic';
  if (mode === 'account-only' && aftercareMode !== 'automatic') {
    throw new Error('仅完整场景可以准备商户人工处理分支。');
  }
  if (input.serviceOn !== shanghaiToday(now)) throw new Error('隔离 Demo 服务日期必须是当前上海日期。');
  const existing = (await client.query<{
    ownerId: string; accountId: string; periodId: string | null; mode: 'complete' | 'account-only';
    serviceOn: string; aftercareMode: 'automatic' | 'merchant-review'; merchantId: string | null;
    reviewerId: string | null; catalogItemId: string | null; quoteId: string | null; createdAt: Date;
  }>(`SELECT owner_id AS "ownerId",account_id AS "accountId",period_id AS "periodId",
      mode,to_char(service_on,'YYYY-MM-DD') AS "serviceOn",aftercare_mode AS "aftercareMode",
      merchant_id AS "merchantId",reviewer_id AS "reviewerId",catalog_item_id AS "catalogItemId",
      quote_id AS "quoteId",created_at AS "createdAt"
    FROM consumer_demo_scenarios WHERE scenario_key=$1 FOR UPDATE`, [input.scenarioKey])).rows[0];
  if (existing) {
    if (existing.mode !== mode) {
      throw new Error(`场景 ${input.scenarioKey} 已按 ${existing.mode} 模式创建，不能改写为 ${mode}。`);
    }
    if (existing.aftercareMode !== aftercareMode) {
      throw new Error(`场景 ${input.scenarioKey} 已按 ${existing.aftercareMode} 售后分支创建，不能改写为 ${aftercareMode}。`);
    }
    return { scenarioKey: input.scenarioKey, ...existing,
      createdAt: existing.createdAt.toISOString(), reused: true };
  }

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
  if (mode === 'complete') {
    // These posted Demo entries are already covered by the ¥2,000 snapshot at `now`.
    // They make the bookkeeping view demonstrable without changing current cash.
    const ledger = [
      ['salary', 'inflow', 30000, 'income', null, '示例工资入账'],
      ['breakfast', 'outflow', 1800, 'food', '示例早餐', null],
      ['metro', 'outflow', 300, 'transport', '示例地铁', null],
    ] as const;
    for (const [code, direction, amount, category, merchantName, note] of ledger) {
      const sourceRef = `M1-${input.scenarioKey}-${code}`;
      await client.query(`INSERT INTO finance_ledger_entries
          (id,owner_id,account_id,source,source_ref,direction,amount_minor,occurred_at,posted_at,
            status,category,merchant_name,note,dedupe_key)
        VALUES($1,$2,$3,'demo',$4,$5,$6,$7,$7,'posted',$8,$9,$10,$4)`,
      [stableUuid(`${input.scenarioKey}:ledger:${code}`), ownerId, accountId, sourceRef,
        direction, amount, now, category, merchantName, note]);
    }
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
  }
  let merchantId: string | null = null; let reviewerId: string | null = null;
  let catalogItemId: string | null = null; let quoteId: string | null = null;
  if (mode === 'complete') {
    merchantId = (await client.query<{ id: string }>(`SELECT id FROM users
      WHERE role='merchant_admin' ORDER BY created_at,id LIMIT 1`)).rows[0]?.id ?? null;
    reviewerId = (await client.query<{ id: string }>(`SELECT id FROM users
      WHERE role='reviewer' ORDER BY created_at,id LIMIT 1`)).rows[0]?.id ?? null;
    if (!merchantId || !reviewerId) throw new Error('请先运行基础种子，准备测试商户和审核者账号。');
    if (aftercareMode === 'merchant-review') {
      catalogItemId = stableUuid(`${input.scenarioKey}:manual-catalog`);
      quoteId = stableUuid(`${input.scenarioKey}:manual-quote`);
      const code = `D1-MANUAL-${input.scenarioKey}`;
      await client.query(`INSERT INTO catalog_items
        (id,merchant_id,code,name,kind,description,price_minor,rule_label,cancellation_fee_minor,
         cancellation_rule,simulation_mode,close_simulation_mode,refund_simulation_mode,
         category_code,location_label,tags,purchase_mode)
        VALUES($1,$2,$3,'Demo 人工售后晚餐','food','用于跨角色演示的预登记测试商品。',9900,
          '取消后由本人商户审核；批准后按原确认金额退款',0,'delay','SUCCESS','SUCCESS','SUCCESS',
          'food','测试商圈',ARRAY['demo','merchant-review'],'orderable') ON CONFLICT(code) DO NOTHING`,
      [catalogItemId, merchantId, code]);
      const stored = (await client.query<{ id: string }>('SELECT id FROM catalog_items WHERE code=$1', [code])).rows[0]!;
      catalogItemId = stored.id;
      await client.query(`INSERT INTO offer_quotes
        (id,catalog_item_id,provider,quote_source,provider_quote_ref,quote_version,price_minor,
         service_on,rule_version,rule_snapshot,valid_until)
        SELECT $1,$2,'simulation','demo',$3,COALESCE(MAX(quote_version),0)+1,9900,$4::date,1,$5::jsonb,$6
        FROM offer_quotes WHERE catalog_item_id=$2
        ON CONFLICT(provider,provider_quote_ref) WHERE provider_quote_ref IS NOT NULL DO NOTHING`,
      [quoteId, catalogItemId, `${code}:${input.serviceOn}`, input.serviceOn,
        JSON.stringify({ cancellationRule: 'delay', cancellationFeeMinor: 0,
          label: '取消后由本人商户审核；批准后按原确认金额退款' }),
        new Date(`${input.serviceOn}T23:59:59+08:00`)]);
      quoteId = (await client.query<{ id: string }>(`SELECT id FROM offer_quotes
        WHERE provider='simulation' AND provider_quote_ref=$1`, [`${code}:${input.serviceOn}`])).rows[0]!.id;
    } else {
      const selected = (await client.query<{ catalogItemId: string; quoteId: string; merchantId: string }>(`
        SELECT c.id AS "catalogItemId",q.id AS "quoteId",c.merchant_id AS "merchantId"
        FROM catalog_items c JOIN offer_quotes q ON q.catalog_item_id=c.id
        WHERE c.code='CONSUMER-DINNER-99' AND q.service_on=$1::date`, [input.serviceOn])).rows[0];
      if (!selected) throw new Error('未能准备完整场景的自动退款商品。');
      ({ catalogItemId, quoteId, merchantId } = selected);
    }
    await client.query(`INSERT INTO budget_review_scopes(reviewer_id,period_id)
      VALUES($1,$2) ON CONFLICT DO NOTHING`, [reviewerId, periodId]);
  }
  await client.query(`INSERT INTO consumer_demo_scenarios
    (scenario_key,owner_id,account_id,period_id,service_on,mode,aftercare_mode,
      merchant_id,reviewer_id,catalog_item_id,quote_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [input.scenarioKey, ownerId, accountId, mode === 'complete' ? periodId : null, input.serviceOn, mode,
    aftercareMode, merchantId, reviewerId, catalogItemId, quoteId]);
  return { scenarioKey: input.scenarioKey, ownerId, accountId,
    periodId: mode === 'complete' ? periodId : null, mode, serviceOn: input.serviceOn,
    snapshotAsOf: now.toISOString(),
    quoteValidThrough: mode === 'complete' ? `${input.serviceOn}T23:59:59+08:00` : null,
    email, aftercareMode, merchantId, reviewerId, catalogItemId, quoteId,
    confirmedCashMinor: 200000, savingsTargetMinor: mode === 'complete' ? 50000 : null,
    essentialAndRepaymentMinor: mode === 'complete' ? 90000 : null,
    adjustablePlannedMinor: mode === 'complete' ? 40000 : null,
    createdAt: now.toISOString(), reused: false };
}
