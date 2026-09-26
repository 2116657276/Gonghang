import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { config } from '../config.js';
import { closePool, transaction } from './client.js';

// This fixture belongs only to the existing consumer-a account selected by the miniapp.
const ownerId = 'a0a46a8c-72aa-4e19-93ab-01984b079676';
const accountId = '63c048c6-a72f-5cbb-a949-163daa9fc29d';
const otherAccountId = 'd81e90d6-97d1-5e06-ad33-223455d4e055';
const periodId = '411a1be6-ff79-5a73-a691-a538737ff5f9';
const oldSnapshotId = 'c0e0fb60-79dd-520d-a8cd-e39b76af2b49';
const merchantId = 'b818ff80-c20b-468e-8893-8e02f1cbe2e0';
const prefix = 'XZ-202609-A00-';

function stableUuid(label: string) {
  const hex = createHash('sha256').update(`${prefix}${label}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function requireFact(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function shanghaiDate(now: Date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

const ledger = [
  { code: 'breakfast-01', at: '2026-09-01T08:12:00+08:00', direction: 'outflow', amount: 1850, category: 'food', merchant: '社区早餐店', note: '早餐' },
  { code: 'part-time-pay', at: '2026-09-03T10:18:00+08:00', direction: 'inflow', amount: 320000, category: 'income', merchant: null, note: '兼职工资到账' },
  { code: 'rent', at: '2026-09-05T09:35:00+08:00', direction: 'outflow', amount: 210000, category: 'housing', merchant: '安心公寓', note: '九月房租' },
  { code: 'fresh-food', at: '2026-09-06T18:24:00+08:00', direction: 'outflow', amount: 8640, category: 'shopping', merchant: '社区生鲜店', note: '生鲜采购' },
  { code: 'metro-08', at: '2026-09-08T08:05:00+08:00', direction: 'outflow', amount: 500, category: 'transport', merchant: '上海地铁', note: '通勤地铁' },
  { code: 'lunch-09', at: '2026-09-09T12:26:00+08:00', direction: 'outflow', amount: 3200, category: 'food', merchant: '街角简餐', note: '午餐' },
  { code: 'household-11', at: '2026-09-11T19:12:00+08:00', direction: 'outflow', amount: 6480, category: 'shopping', merchant: '社区便利店', note: '日用品' },
  { code: 'coffee', at: '2026-09-12T15:38:00+08:00', direction: 'outflow', amount: 2600, category: 'food', merchant: 'Manner Coffee', note: '咖啡' },
  { code: 'dinner-13', at: '2026-09-13T18:42:00+08:00', direction: 'outflow', amount: 7850, category: 'food', merchant: '家常小馆', note: '晚餐' },
  { code: 'utilities', at: '2026-09-15T19:06:00+08:00', direction: 'outflow', amount: 12270, category: 'utilities', merchant: '生活缴费', note: '水电费' },
  { code: 'metro-16', at: '2026-09-16T08:17:00+08:00', direction: 'outflow', amount: 600, category: 'transport', merchant: '上海地铁', note: '通勤地铁' },
  { code: 'fruit', at: '2026-09-17T18:34:00+08:00', direction: 'outflow', amount: 3890, category: 'shopping', merchant: '社区水果店', note: '水果' },
  { code: 'breakfast-18', at: '2026-09-18T08:21:00+08:00', direction: 'outflow', amount: 2160, category: 'food', merchant: '社区早餐店', note: '早餐' },
  { code: 'cinema', at: '2026-09-20T16:05:00+08:00', direction: 'outflow', amount: 5900, category: 'entertainment', merchant: '测试影院', note: '周末观影' },
  { code: 'lunch-21', at: '2026-09-21T12:31:00+08:00', direction: 'outflow', amount: 2450, category: 'food', merchant: '街角简餐', note: '午餐' },
  { code: 'laundry-22', at: '2026-09-22T18:09:00+08:00', direction: 'outflow', amount: 3500, category: 'shopping', merchant: '社区洗衣店', note: '洗衣' },
  { code: 'dinner-23', at: '2026-09-23T12:15:00+08:00', direction: 'outflow', amount: 4230, category: 'food', merchant: '家常小馆', note: '晚餐' },
  { code: 'travel-reimbursement', at: '2026-09-24T10:04:00+08:00', direction: 'inflow', amount: 12800, category: 'income', merchant: null, note: '交通报销到账' },
  { code: 'metro-24', at: '2026-09-24T19:02:00+08:00', direction: 'outflow', amount: 700, category: 'transport', merchant: '上海地铁', note: '通勤地铁' },
  { code: 'groceries-25', at: '2026-09-25T18:30:00+08:00', direction: 'outflow', amount: 9280, category: 'shopping', merchant: '社区超市', note: '日常采购，留作手动关联测试' },
] as const;

const items = [
  { code: 'household', title: '日用品补充', kind: 'essential_expense', category: 'shopping', on: '2026-09-11', amount: 6480, priority: 'required', status: 'settled', entry: 'household-11' },
  { code: 'cinema', title: '周末观影', kind: 'planned_spend', category: 'entertainment', on: '2026-09-20', amount: 5900, priority: 'adjustable', status: 'settled', entry: 'cinema' },
  { code: 'pool', title: '月末游泳', kind: 'planned_spend', category: 'health', on: '2026-09-28', amount: 5800, priority: 'adjustable', status: 'planned', entry: null },
  { code: 'transit', title: '通勤卡充值', kind: 'essential_expense', category: 'transport', on: '2026-09-29', amount: 8000, priority: 'required', status: 'planned', entry: null },
] as const;

const products = [
  { code: 'XZ-DEMO-LOCAL-TRANSIT-80', name: '城市通勤储值', kind: 'transport', category: 'transport', price: 8000, serviceOn: '2026-09-29' },
  { code: 'XZ-DEMO-POOL-58', name: '单次游泳', kind: 'activity', category: 'health', price: 5800, serviceOn: '2026-09-28' },
  { code: 'XZ-DEMO-CINEMA-59', name: '单人观影', kind: 'activity', category: 'entertainment', price: 5900, serviceOn: '2026-09-29' },
  { code: 'XZ-DEMO-HOUSEHOLD-68', name: '日用品配送', kind: 'activity', category: 'shopping', price: 6800, serviceOn: '2026-09-29' },
  { code: 'XZ-DEMO-LAUNDRY-35', name: '洗衣取送', kind: 'activity', category: 'shopping', price: 3500, serviceOn: '2026-09-29' },
] as const;

async function readCount(client: PoolClient, sql: string, params: unknown[]) {
  const row = (await client.query<{ count: string }>(sql, params)).rows[0];
  return Number(row?.count ?? -1);
}

async function seed(client: PoolClient) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${prefix}${accountId}`]);
  const identity = (await client.query<{
    id: string; email: string; role: string;
  }>('SELECT id,email,role FROM users WHERE id=$1', [ownerId])).rows[0];
  requireFact(identity?.email === 'consumer-a@xingzhi.local' && identity.role === 'consumer', '目标消费者身份已变化。');
  const merchant = (await client.query<{ id: string; role: string; display_name: string }>(
    'SELECT id,role,display_name FROM users WHERE id=$1', [merchantId],
  )).rows[0];
  requireFact(merchant?.role === 'merchant_admin' && merchant.display_name === '行止测试商户', 'Demo 商户身份已变化。');
  const accounts = (await client.query<{ id: string; provider_account_ref: string; status: string;
    source: string; provider: string; account_type: string }>(`SELECT id,provider_account_ref,status,source,provider,account_type
    FROM finance_accounts WHERE owner_id=$1 ORDER BY created_at,id FOR UPDATE`, [ownerId])).rows;
  const preferred = (await client.query<{ default_account_id: string | null }>(
    'SELECT default_account_id FROM consumer_preferences WHERE owner_id=$1', [ownerId],
  )).rows[0]?.default_account_id ?? null;
  const selected = accounts.find((a) => a.id === preferred && a.status === 'linked' && a.account_type === 'debit')
    ?? accounts.find((a) => a.status === 'linked' && a.account_type === 'debit');
  requireFact(preferred === null && selected?.id === accountId, '小程序实际选中的账户已变化；停止补数。');
  requireFact(accounts.length === 2 && accounts[0]?.id === accountId
    && accounts[0].provider_account_ref === 'A00-DEMO-DEBIT'
    && accounts[1]?.id === otherAccountId && accounts[1].provider_account_ref === 'A00-DEMO-DEBIT-R2'
    && accounts.every((a) => a.status === 'linked' && a.provider === 'demo'
      && a.source === 'demo' && a.account_type === 'debit'), '两个 Demo 账户的身份或状态已变化。');

  const oldSnapshot = (await client.query<{ id: string; account_id: string; available_balance_minor: number;
    current_balance_minor: number | null; as_of: Date; covered_through_at: Date | null;
    fact_status: string; source: string; provider_snapshot_ref: string | null }>(
    'SELECT * FROM finance_account_snapshots WHERE id=$1', [oldSnapshotId],
  )).rows[0];
  requireFact(oldSnapshot?.account_id === accountId && oldSnapshot.available_balance_minor === 200000
    && oldSnapshot.current_balance_minor === 200000 && oldSnapshot.fact_status === 'observed'
    && oldSnapshot.source === 'demo' && oldSnapshot.provider_snapshot_ref === 'A00-INITIAL-2000'
    && oldSnapshot.as_of.toISOString() === '2026-09-23T11:10:58.742Z'
    && oldSnapshot.covered_through_at?.getTime() === oldSnapshot.as_of.getTime(), '旧 Demo 快照与计划基准不一致。');
  const period = (await client.query<{ id: string; primary_account_id: string; baseline_snapshot_id: string;
    month_start: string; month_end: string; status: string; savings_target_minor: string }>(`SELECT id,primary_account_id,baseline_snapshot_id,
    to_char(month_start,'YYYY-MM-DD') AS month_start,to_char(month_end,'YYYY-MM-DD') AS month_end,
    status,savings_target_minor FROM budget_periods WHERE id=$1 FOR UPDATE`, [periodId])).rows[0];
  requireFact(period?.primary_account_id === accountId && period.baseline_snapshot_id === oldSnapshotId
    && period.month_start === '2026-09-01' && period.month_end === '2026-09-30'
    && period.status === 'active' && Number(period.savings_target_minor) === 50000, '九月计划周期已变化。');
  const oldItems = (await client.query<{ title: string; planned_on: string; amount: string; status: string }>(`SELECT title,
    to_char(planned_on,'YYYY-MM-DD') AS planned_on,user_estimated_amount_minor AS amount,status
    FROM budget_items WHERE period_id=$1 AND id=ANY($2::uuid[]) ORDER BY title`, [periodId, [
      '67f39284-3dbd-5be7-a774-09a79015e6d4', '4eee54c4-34bf-5191-a3e3-7d972b7cd6d4',
      '668adc0e-362d-4e09-b685-ed716c00c78c', '86bbee8d-18ee-5bcb-a9b8-e80c60172f5c',
    ]])).rows;
  requireFact(oldItems.length === 4 && oldItems.every((row) => row.status === 'planned')
    && oldItems.some((row) => row.title === '朋友聚餐' && row.planned_on === '2026-09-23' && Number(row.amount) === 8000)
    && oldItems.some((row) => row.title === '房租与本月必要开支' && row.planned_on === '2026-09-30' && Number(row.amount) === 90000)
    && oldItems.some((row) => row.title === '其他可调生活开支' && row.planned_on === '2026-09-30' && Number(row.amount) === 32000)
    && oldItems.some((row) => row.title === '无周期草稿验收' && row.planned_on === '2026-09-30' && Number(row.amount) === 5000), '原有四项计划已变化。');

  const newSnapshotId = stableUuid('snapshot-2026-09-26');
  const alreadyApplied = (await client.query<{ id: string }>(
    'SELECT id FROM finance_account_snapshots WHERE id=$1 AND account_id=$2', [newSnapshotId, accountId],
  )).rowCount === 1;
  if (!alreadyApplied) {
    const today = shanghaiDate(new Date());
    requireFact(today >= '2026-09-25' && today < '2026-09-28', '固定 Demo 报价的服务日已不在未来；不会创建过期报价。');
    requireFact(await readCount(client, 'SELECT count(*) FROM finance_ledger_entries WHERE account_id=$1', [accountId]) === 0
      && await readCount(client, 'SELECT count(*) FROM finance_account_snapshots WHERE account_id=$1', [accountId]) === 1
      && await readCount(client, 'SELECT count(*) FROM budget_items WHERE period_id=$1', [periodId]) === 4
      && await readCount(client, 'SELECT count(*) FROM budget_ledger_links WHERE period_id=$1', [periodId]) === 0
      && await readCount(client, 'SELECT count(*) FROM orders WHERE budget_period_id=$1', [periodId]) === 0,
    '目标账户已出现其他流水、快照、计划关联或周期订单；不会混入固定数据。');
    for (const entry of ledger) {
      const ref = `${prefix}LEDGER-${entry.code.toUpperCase()}`;
      await client.query(`INSERT INTO finance_ledger_entries
        (id,owner_id,account_id,source,source_ref,direction,amount_minor,occurred_at,posted_at,
         status,category,merchant_name,note,dedupe_key)
        VALUES($1,$2,$3,'demo',$4,$5,$6,$7,$7,'posted',$8,$9,$10,$4)`,
      [stableUuid(`ledger-${entry.code}`), ownerId, accountId, ref, entry.direction,
        entry.amount, entry.at, entry.category, entry.merchant, entry.note]);
    }
    for (const item of items) {
      const entryId = item.entry === null ? null : stableUuid(`ledger-${item.entry}`);
      await client.query(`INSERT INTO budget_items
        (id,owner_id,period_id,account_id,kind,title,category_code,planned_on,
         user_estimated_amount_minor,priority,status,settled_ledger_entry_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [stableUuid(`item-${item.code}`), ownerId, periodId, accountId, item.kind,item.title,
        item.category,item.on,item.amount,item.priority,item.status,entryId]);
      if (entryId !== null) {
        await client.query(`INSERT INTO budget_ledger_links
          (id,owner_id,period_id,account_id,item_id,entry_id,covered_minor)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [stableUuid(`link-${item.code}`), ownerId,
          periodId, accountId, stableUuid(`item-${item.code}`), entryId, item.amount]);
      }
    }
    for (const product of products) {
      await client.query(`INSERT INTO catalog_items
        (id,merchant_id,code,name,kind,description,price_minor,rule_label,
         cancellation_fee_minor,cancellation_rule,simulation_mode,close_simulation_mode,
         refund_simulation_mode,category_code,location_label,tags,purchase_mode,available_from,available_to)
        VALUES($1,$2,$3,$4,$5,'预先登记的本地 Demo 服务，不代表真实商户供给。',$6,
         '本地模拟全额退款；申请不代表到账',0,'full_refund','SUCCESS','SUCCESS',
         'SUCCESS',$7,'测试商圈',ARRAY['demo'],'orderable',$8::date,$8::date)`,
      [stableUuid(`product-${product.code}`),merchantId,product.code,product.name,
        product.kind,product.price,product.category,product.serviceOn]);
    }
    const quotedCodes = [...products.map((product) => ({ code: product.code, serviceOn: product.serviceOn })),
      { code: 'CONSUMER-DINNER-99', serviceOn: '2026-09-29' }];
    for (const quoted of quotedCodes) {
      const catalog = (await client.query<{ id: string; merchant_id: string; active: boolean;
        purchase_mode: string; price_minor: number; currency: string; rule_version: number;
        cancellation_rule: string; cancellation_fee_minor: number; rule_label: string }>(
        'SELECT * FROM catalog_items WHERE code=$1 FOR UPDATE', [quoted.code],
      )).rows[0];
      requireFact(catalog?.merchant_id === merchantId && catalog.active
        && catalog.purchase_mode === 'orderable' && catalog.currency === 'CNY',
      `商品 ${quoted.code} 不属于现有 Demo 商户或已下架。`);
      const version = (await client.query<{ next: string }>(`SELECT (COALESCE(MAX(quote_version),0)+1)::text AS next
        FROM offer_quotes WHERE catalog_item_id=$1`, [catalog.id])).rows[0]!.next;
      const validUntil = `${quoted.serviceOn}T23:59:59+08:00`;
      const ref = `${prefix}QUOTE-${quoted.code}-${quoted.serviceOn}`;
      await client.query(`INSERT INTO offer_quotes
        (id,catalog_item_id,provider,quote_source,provider_quote_ref,quote_version,
         price_minor,service_on,rule_version,rule_snapshot,valid_until)
        VALUES($1,$2,'simulation','demo',$3,$4,$5,$6::date,$7,$8::jsonb,$9)`,
      [stableUuid(`quote-${quoted.code}-${quoted.serviceOn}`),catalog.id,ref,version,
        catalog.price_minor,quoted.serviceOn,catalog.rule_version,
        JSON.stringify({ cancellationRule: catalog.cancellation_rule,
          cancellationFeeMinor: catalog.cancellation_fee_minor, label: catalog.rule_label }),validUntil]);
    }
    const snapshotAt = new Date();
    requireFact(shanghaiDate(snapshotAt) <= '2026-09-27', '报价写入时服务日已不在未来。');
    const cashRows = (await client.query<{ direction: string; amount_minor: number; posted_at: Date }>(`SELECT direction,amount_minor,posted_at
      FROM finance_ledger_entries WHERE account_id=$1 AND source='demo' AND status='posted'
      ORDER BY posted_at,id`, [accountId])).rows;
    requireFact(cashRows.length === 20 && cashRows.every((row) => row.posted_at <= snapshotAt), '流水覆盖范围不完整。');
    const signed = (row: (typeof cashRows)[number]) => (row.direction === 'inflow' ? 1 : -1) * row.amount_minor;
    const before = cashRows.filter((row) => row.posted_at <= oldSnapshot.covered_through_at!).reduce((sum,row) => sum+signed(row),0);
    const after = cashRows.filter((row) => row.posted_at > oldSnapshot.covered_through_at!).reduce((sum,row) => sum+signed(row),0);
    requireFact(before === 43880 && after === 2820 && 200000-before === 156120,
      '旧快照覆盖前后流水无法勾稽；不会追加新快照。');
    await client.query(`INSERT INTO finance_account_snapshots
      (id,account_id,available_balance_minor,current_balance_minor,as_of,covered_through_at,
       fact_status,source,provider_snapshot_ref)
      VALUES($1,$2,$3,$3,$4,$4,'observed','demo',$5)`,
    [newSnapshotId,accountId,200000+after,snapshotAt,`${prefix}SNAPSHOT-20260926`]);
  }
  // Read back immutable fixture fields on both the initial run and every repeat run.
  const recorded = (await client.query<{ id: string; source: string; source_ref: string | null;
    dedupe_key: string; direction: string;
    amount_minor: number; occurred_at: Date; posted_at: Date | null; status: string;
    category: string | null; merchant_name: string | null; note: string | null; order_id: string | null }>(
    'SELECT * FROM finance_ledger_entries WHERE account_id=$1', [accountId],
  )).rows;
  requireFact(recorded.length === ledger.length, '目标账户流水数发生变化。');
  for (const entry of ledger) {
    const row = recorded.find((value) => value.id === stableUuid(`ledger-${entry.code}`));
    requireFact(row?.source === 'demo' && row.source_ref === `${prefix}LEDGER-${entry.code.toUpperCase()}`
      && row.dedupe_key === row.source_ref
      && row.direction === entry.direction && row.amount_minor === entry.amount
      && row.occurred_at.getTime() === new Date(entry.at).getTime()
      && row.posted_at?.getTime() === row.occurred_at.getTime()
      && row.status === 'posted' && row.category === entry.category
      && row.merchant_name === entry.merchant && row.note === entry.note && row.order_id === null,
    `流水 ${entry.code} 已变化。`);
  }
  for (const item of items) {
    const row = (await client.query<{ id: string; owner_id: string; period_id: string;
      account_id: string; kind: string; title: string; category_code: string | null;
      planned_on: string; user_estimated_amount_minor: string; priority: string; status: string;
      settled_ledger_entry_id: string | null }>(`SELECT id,owner_id,period_id,account_id,kind,title,category_code,
      to_char(planned_on,'YYYY-MM-DD') AS planned_on,user_estimated_amount_minor,priority,status,
      settled_ledger_entry_id FROM budget_items WHERE id=$1`, [stableUuid(`item-${item.code}`)])).rows[0];
    const expectedEntry = item.entry === null ? null : stableUuid(`ledger-${item.entry}`);
    requireFact(row?.owner_id === ownerId && row.period_id === periodId && row.account_id === accountId
      && row.kind === item.kind && row.title === item.title && row.category_code === item.category
      && row.planned_on === item.on && Number(row.user_estimated_amount_minor) === item.amount
      && row.priority === item.priority && row.status === item.status
      && row.settled_ledger_entry_id === expectedEntry, `计划 ${item.title} 已变化。`);
    if (expectedEntry) {
      const link = (await client.query<{ item_id: string; entry_id: string; covered_minor: number;
        active: boolean }>('SELECT * FROM budget_ledger_links WHERE id=$1', [stableUuid(`link-${item.code}`)])).rows[0];
      requireFact(link?.item_id === row.id && link.entry_id === expectedEntry
        && link.covered_minor === item.amount && link.active, `计划 ${item.title} 的流水关联已变化。`);
    }
  }
  requireFact(await readCount(client, `SELECT count(*) FROM budget_ledger_links
    WHERE entry_id=$1 AND active`, [stableUuid('ledger-groceries-25')]) === 0,
  '留给手动测试的日常采购流水已有关联。');
  for (const product of products) {
    const catalog = (await client.query<{ id: string; merchant_id: string; name: string;
      kind: string; category_code: string | null; price_minor: number; active: boolean;
      purchase_mode: string; available_from: string; available_to: string }>(`SELECT id,merchant_id,name,kind,category_code,price_minor,active,purchase_mode,
      to_char(available_from,'YYYY-MM-DD') AS available_from,
      to_char(available_to,'YYYY-MM-DD') AS available_to
      FROM catalog_items WHERE code=$1`, [product.code])).rows[0];
    requireFact(catalog?.id === stableUuid(`product-${product.code}`)
      && catalog.merchant_id === merchantId && catalog.name === product.name
      && catalog.kind === product.kind && catalog.category_code === product.category
      && catalog.price_minor === product.price && catalog.active
      && catalog.purchase_mode === 'orderable' && catalog.available_from === product.serviceOn
      && catalog.available_to === product.serviceOn, `商品 ${product.code} 已变化。`);
  }
  for (const quoted of [...products.map((product) => ({ code: product.code, serviceOn: product.serviceOn,
    price: product.price })), { code: 'CONSUMER-DINNER-99', serviceOn: '2026-09-29', price: 9900 }]) {
    const quote = (await client.query<{ id: string; code: string; merchant_id: string;
      provider: string; quote_source: string; provider_quote_ref: string | null;
      quote_version: string; price_minor: string; service_on: string; rule_version: string;
      valid_until: Date; status: string }>(`SELECT q.id,c.code,c.merchant_id,q.provider,q.quote_source,
      q.provider_quote_ref,q.quote_version,q.price_minor,
      to_char(q.service_on,'YYYY-MM-DD') AS service_on,q.rule_version,q.valid_until,q.status
      FROM offer_quotes q JOIN catalog_items c ON c.id=q.catalog_item_id WHERE q.id=$1`,
    [stableUuid(`quote-${quoted.code}-${quoted.serviceOn}`)])).rows[0];
    requireFact(quote?.code === quoted.code && quote.merchant_id === merchantId
      && quote.provider === 'simulation' && quote.quote_source === 'demo'
      && quote.provider_quote_ref === `${prefix}QUOTE-${quoted.code}-${quoted.serviceOn}`
      && Number(quote.quote_version) > 0 && Number(quote.rule_version) > 0
      && Number(quote.price_minor) === quoted.price && quote.service_on === quoted.serviceOn
      && quote.valid_until.getTime() === new Date(`${quoted.serviceOn}T23:59:59+08:00`).getTime()
      && quote.status === 'valid', `报价 ${quoted.code} 已变化。`);
  }
  const snapshot = (await client.query<{ account_id: string; available_balance_minor: number;
    current_balance_minor: number | null; as_of: Date; covered_through_at: Date | null;
    fact_status: string; source: string; provider_snapshot_ref: string | null }>(
    'SELECT * FROM finance_account_snapshots WHERE id=$1', [newSnapshotId],
  )).rows[0];
  requireFact(snapshot?.account_id === accountId && snapshot.available_balance_minor === 202820
    && snapshot.current_balance_minor === 202820 && snapshot.fact_status === 'observed'
    && snapshot.source === 'demo' && snapshot.provider_snapshot_ref === `${prefix}SNAPSHOT-20260926`
    && snapshot.covered_through_at?.getTime() === snapshot.as_of.getTime()
    && snapshot.as_of > oldSnapshot.covered_through_at!, '新 Demo 快照与勾稽结果不符。');
  requireFact(await readCount(client, 'SELECT count(*) FROM orders WHERE budget_period_id=$1', [periodId]) === 0
    && await readCount(client, 'SELECT count(*) FROM finance_money_events WHERE owner_id=$1', [ownerId]) === 0,
  '本次 Demo 周期出现订单或资金事件。');
  return { ownerId, accountId, periodId, oldSnapshotId, newSnapshotId,
    ledgerCount: ledger.length, itemCount: items.length, productCount: products.length,
    alreadyApplied, confirmedCashMinor: snapshot.available_balance_minor, source: 'demo' };
}

const url = new URL(config.databaseUrl);
if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') throw new Error('仅允许本地 PostgreSQL Demo 库。');
if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)
  || url.pathname !== '/xingzhi_dev' || config.paymentMode !== 'simulation'
  || process.env.NODE_ENV === 'production') {
  throw new Error('仅允许本地 xingzhi_dev 的 Simulation Demo 环境运行。');
}
try {
  console.log(JSON.stringify(await transaction(seed), null, 2));
} finally {
  await closePool();
}
