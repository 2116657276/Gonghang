import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { createIsolatedTestDatabase } from '../db/isolated-test-database.js';
const database = await createIsolatedTestDatabase();
const { pool } = database;
const { transaction } = await import('../db/client.js');
const { claimNextJob, processClaimedJob } = await import('./worker-runtime.js');
after(() => database.close());

async function m1ClosureFixture(rule: 'full_refund'|'two_batches'|'delay' = 'full_refund') {
  config.paymentMode='simulation';
  const ids={user:randomUUID(),merchant:randomUUID(),account:randomUUID(),snapshot:randomUUID(),
    period:randomUUID(),item:randomUUID(),catalog:randomUUID(),quote:randomUUID()};
  const now=new Date();
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const monthStart=`${today.slice(0,7)}-01`;
  const monthEndDate=new Date(`${monthStart}T00:00:00Z`);monthEndDate.setUTCMonth(monthEndDate.getUTCMonth()+1);monthEndDate.setUTCDate(0);
  const monthEnd=monthEndDate.toISOString().slice(0,10);
  await transaction(async client=>{
    await client.query(`INSERT INTO users(id,email,display_name,role,password_hash)
      VALUES($1,$2,'M1 收口消费者','consumer','disabled'),($3,$4,'M1 收口商户','merchant_admin','disabled')`,
    [ids.user,`${ids.user}@test.local`,ids.merchant,`${ids.merchant}@test.local`]);
    await client.query(`INSERT INTO finance_accounts
      (id,owner_id,provider,account_type,provider_account_ref,masked_identifier,display_name,source,authorized_at)
      VALUES($1,$2,'demo','debit',$4,'****M1','M1 收口账户','demo',$3)`,
    [ids.account,ids.user,now,`M1-${ids.account}`]);
    await client.query(`INSERT INTO finance_account_snapshots
      (id,account_id,available_balance_minor,current_balance_minor,as_of,covered_through_at,fact_status,source)
      VALUES($1,$2,200000,200000,$3,$3,'observed','demo')`,[ids.snapshot,ids.account,now]);
    await client.query(`INSERT INTO budget_periods
      (id,owner_id,primary_account_id,baseline_snapshot_id,month_start,month_end,
        savings_target_minor,status,necessities_confirmed_at)
      VALUES($1,$2,$3,$4,$5,$6,50000,'active',$7)`,
    [ids.period,ids.user,ids.account,ids.snapshot,monthStart,monthEnd,now]);
    await client.query(`INSERT INTO budget_items
      (id,owner_id,period_id,account_id,kind,title,category_code,planned_on,
        user_estimated_amount_minor,priority)
      VALUES($1,$2,$3,$4,'planned_spend','朋友聚餐','food',$5,8000,'adjustable')`,
    [ids.item,ids.user,ids.period,ids.account,today]);
    await client.query(`INSERT INTO catalog_items
      (id,merchant_id,code,name,kind,description,price_minor,rule_label,cancellation_rule,
        simulation_mode,close_simulation_mode,refund_simulation_mode,category_code,purchase_mode)
      VALUES($1,$2,$3,'M1 晚餐','food','收口验收商品',9900,'验收规则',$4,
        'SUCCESS','SUCCESS','SUCCESS','food','orderable')`,[ids.catalog,ids.merchant,`M1-${ids.catalog}`,rule]);
    await client.query(`INSERT INTO offer_quotes
      (id,catalog_item_id,provider,quote_source,provider_quote_ref,quote_version,price_minor,
        service_on,rule_version,rule_snapshot,valid_until)
      VALUES($1,$2,'simulation','demo',$3,1,9900,$4,1,$5,now()+interval '1 hour')`,
    [ids.quote,ids.catalog,`M1-${ids.quote}`,today,{cancellationRule:rule}]);
  });
  const user={id:ids.user,email:`${ids.user}@test.local`,displayName:'M1 收口消费者',role:'consumer' as const};
  const versions=async()=>{
    const row=(await pool.query<{financial:string;period:string}>(`SELECT a.financial_version AS financial,p.version AS period
      FROM finance_accounts a JOIN budget_periods p ON p.primary_account_id=a.id WHERE p.id=$1`,[ids.period])).rows[0]!;
    return {financial:Number(row.financial),period:Number(row.period)};
  };
  const createIntent=async()=>{
    const {assessPurchasePreview}=await import('./purchase-assessment.js');
    const {createPurchaseIntent}=await import('./purchase-intents.js');
    const basis=await versions();
    const assessment=await transaction(client=>assessPurchasePreview(client,ids.user,{
      periodId:ids.period,budgetItemId:ids.item,quoteId:ids.quote,
      expectedFinancialVersion:basis.financial,expectedPeriodVersion:basis.period,
      expectedQuoteVersion:1,mode:'preview',
    }));
    const intent=await transaction(client=>createPurchaseIntent(client,ids.user,randomUUID(),{
      periodId:ids.period,budgetItemId:ids.item,quoteId:ids.quote,assessmentId:assessment.assessmentId,
      expectedFinancialVersion:basis.financial,expectedPeriodVersion:basis.period,expectedQuoteVersion:1,
    }));
    return {basis,assessment,intent};
  };
  const createOrder=async()=>{
    const {confirmPurchaseIntent}=await import('./consumer-orders.js');
    const created=await createIntent();
    const confirmed=await transaction(client=>confirmPurchaseIntent(client,ids.user,
      created.intent.purchaseIntentId,{acceptedAmountMinor:9900,
        expectedFinancialVersion:created.basis.financial,expectedPeriodVersion:created.basis.period,
        expectedQuoteVersion:1,confirmedByUser:true}));
    return {...created,orderId:confirmed.order.orderId};
  };
  return {ids,user,today,monthEnd,versions,createIntent,createOrder};
}


for (const revoked of [false, true]) test(`R1 关单结束预算承诺且重放不增行（撤回=${revoked}）`, async () => {
  const f = await m1ClosureFixture(); const created = await f.createOrder();
  const { createAftercarePreview, confirmAftercare } = await import('./consumer-aftercare.js');
  const { forecastBudgetCashflow } = await import('./budget-cashflow.js');
  const { finishClosedOrderBudget } = await import('./closed-order-budget.js');
  if (revoked) await pool.query("UPDATE finance_accounts SET status='revoked',revoked_at=now() WHERE id=$1", [f.ids.account]);
  const accepted = await transaction(async client => {
    const preview = await createAftercarePreview(client, f.ids.user, created.orderId, { action: 'close' });
    return confirmAftercare(client, f.ids.user, created.orderId, { previewId: preview.previewId,
      acceptedFeeMinor: 0, acceptedRefundMinor: 0, confirmedByUser: true });
  });
  const job = await claimNextJob(); assert.ok(job); assert.equal(job.operation_id, accepted.operationId);
  await processClaimedJob(job);
  assert.equal((await pool.query('SELECT status FROM budget_items WHERE id=$1', [f.ids.item])).rows[0].status, 'cancelled');
  if (!revoked) {
    const forecast = await transaction(client => forecastBudgetCashflow(client, f.ids.user, f.ids.period));
    assert.equal(forecast.forecast.status, 'allowed');
    assert.equal(forecast.forecast.minimumProjectedCashMinor, 200000);
  }
  const version = await f.versions();
  const count = Number((await pool.query('SELECT count(*) FROM budget_events WHERE period_id=$1', [f.ids.period])).rows[0].count);
  assert.equal(await processClaimedJob(job), false);
  await transaction(client => finishClosedOrderBudget(client, f.ids.user, created.orderId));
  assert.deepEqual(await f.versions(), version);
  assert.equal(Number((await pool.query('SELECT count(*) FROM budget_events WHERE period_id=$1', [f.ids.period])).rows[0].count), count);
});

test('R1 调整确认持有资金锁，拒绝已变化的资金版本', async () => {
  const f = await m1ClosureFixture();
  const { createBudgetAdjustment, confirmBudgetAdjustment } = await import('./budget-adjustments.js');
  const make = async () => {
    const version = await f.versions();
    const proposal = await transaction(client => createBudgetAdjustment(client, f.ids.user, {
      periodId: f.ids.period, amountMinor: 1000, plannedOn: f.today, reason: '必要支出回归',
      expectedFinancialVersion: version.financial, expectedPeriodVersion: version.period }));
    return { proposal, input: { acceptedOptionId: proposal.options[0]!.optionId,
      expectedFinancialVersion: version.financial, expectedPeriodVersion: version.period, confirmedByUser: true as const } };
  };
  const first = await make(); let checkedLock = false;
  await transaction(async client => {
    const original = client.query.bind(client);
    const guarded = new Proxy(client, { get(target, property, receiver) {
      if (property !== 'query') return Reflect.get(target, property, receiver);
      return async (sql: string, params?: unknown[]) => {
        if (sql.includes("UPDATE budget_adjustment_proposals SET status='confirmed'")) {
          const peer = await pool.connect();
          try {
            await peer.query('BEGIN');
            await assert.rejects(peer.query('SELECT id FROM finance_accounts WHERE id=$1 FOR UPDATE NOWAIT', [f.ids.account]),
              (error: { code?: string }) => error.code === '55P03');
            checkedLock = true;
          } finally { await peer.query('ROLLBACK'); peer.release(); }
        }
        return original(sql, params);
      };
    } });
    const result = await confirmBudgetAdjustment(guarded, f.ids.user, first.proposal.adjustmentId, first.input);
    assert.equal(result.status, 'complete');
  });
  assert.equal(checkedLock, true);
  const second = await make();
  await pool.query(`INSERT INTO finance_ledger_entries
    (id,owner_id,account_id,source,direction,amount_minor,occurred_at,posted_at,status,category,dedupe_key)
    VALUES($1,$2,$3,'demo','outflow',50000,now(),now(),'posted','shopping',$4)`,
  [randomUUID(), f.ids.user, f.ids.account, randomUUID()]);
  await assert.rejects(transaction(client => confirmBudgetAdjustment(client, f.ids.user,
    second.proposal.adjustmentId, second.input)), (error: { code?: string }) => error.code === 'VERSION_CONFLICT');
  assert.equal((await pool.query('SELECT status FROM budget_adjustment_proposals WHERE id=$1',
    [second.proposal.adjustmentId])).rows[0].status, 'proposed');
});

test('R1 Sandbox 关单观察同步结束计划（仅本地渠道桩）', async () => {
  const f = await m1ClosureFixture(); config.paymentMode = 'sandbox';
  const created = await f.createOrder();
  const { createAftercarePreview, confirmAftercare } = await import('./consumer-aftercare.js');
  const { processChannelJob } = await import('./channel-worker.js');
  const accepted = await transaction(async client => {
    const preview = await createAftercarePreview(client, f.ids.user, created.orderId, { action: 'close' });
    return confirmAftercare(client, f.ids.user, created.orderId, { previewId: preview.previewId,
      acceptedFeeMinor: 0, acceptedRefundMinor: 0, confirmedByUser: true });
  });
  config.paymentMode = 'sandbox';
  try {
    const job = await claimNextJob(); assert.ok(job); assert.equal(job.operation_id, accepted.operationId);
    const noCall = async (): Promise<never> => { throw new Error('Unexpected external call'); };
    await processChannelJob(job, { queryTrade: async number => ({ code: '10000', outTradeNo: number,
      totalAmount: '99.00', tradeStatus: 'TRADE_CLOSED' }), closeTrade: noCall, refund: noCall, queryRefund: noCall });
    assert.equal((await pool.query('SELECT status FROM budget_items WHERE id=$1', [f.ids.item])).rows[0].status, 'cancelled');
    assert.equal((await pool.query('SELECT payment_status FROM orders WHERE id=$1', [created.orderId])).rows[0].payment_status, 'closed');
    assert.equal(await processChannelJob(job, { queryTrade: noCall, closeTrade: noCall, refund: noCall, queryRefund: noCall }), false);
  } finally { config.paymentMode = 'simulation'; }
});

test('R2 普通支出部分和全部覆盖后可只读比较与评估，修改限制保留', async () => {
  const f = await m1ClosureFixture();
  const { readBudgetLedgerLinks, linkBudgetLedgerEntry } = await import('./budget-ledger-links.js');
  const { previewBudgetItemImpact } = await import('./budget-cashflow.js');
  const { createBudgetAdjustment } = await import('./budget-adjustments.js');
  const { cancelBudgetItem, applyBudgetItemChange } = await import('./budget-periods.js');
  let total = 0;
  for (const amount of [2500, 5500]) {
    const entry = randomUUID(); total += amount;
    await pool.query(`INSERT INTO finance_ledger_entries
      (id,owner_id,account_id,source,direction,amount_minor,occurred_at,posted_at,status,category,dedupe_key)
      VALUES($1,$2,$3,'demo','outflow',$4,now(),now(),'posted','food',$5)`, [entry, f.ids.user, f.ids.account, amount, entry]);
    const linked = await transaction(async client => {
      const basis = await readBudgetLedgerLinks(client, f.ids.user, f.ids.period);
      return linkBudgetLedgerEntry(client, f.ids.user, f.ids.period, { entryId: entry, itemId: f.ids.item,
        coveredMinor: amount, expectedFinancialVersion: basis.financialVersion,
        expectedPeriodVersion: basis.periodVersion, confirmedByUser: true });
    });
    const before = await f.versions();
    const impact = await transaction(client => previewBudgetItemImpact(client, f.ids.user, f.ids.period, f.ids.item));
    assert.equal(impact.coveredMinor, total); assert.equal(impact.remainingMinor, 8000 - total);
    assert.equal(impact.withItem.minimumProjectedCashMinor, 192000);
    assert.equal(impact.withoutItem.minimumProjectedCashMinor, 200000 - total);
    assert.deepEqual(await f.versions(), before);
    const adjustment = await transaction(client => createBudgetAdjustment(client, f.ids.user, {
      periodId: f.ids.period, amountMinor: 1000, plannedOn: f.today, reason: '关联后必要支出',
      expectedFinancialVersion: linked.financialVersion, expectedPeriodVersion: linked.periodVersion }));
    assert.equal(adjustment.options.length, 1); assert.equal(adjustment.options[0]!.assessment.status, 'allowed');
    await assert.rejects(transaction(client => cancelBudgetItem(client, f.ids.user, {
      periodId: f.ids.period, itemId: f.ids.item, expectedPeriodVersion: linked.periodVersion,
      expectedFinancialVersion: linked.financialVersion, reason: '不应取消已关联计划' })),
    (error: { code?: string }) => error.code === 'ITEM_NOT_ORDERABLE');
    await assert.rejects(transaction(client => applyBudgetItemChange(client, f.ids.user, {
      periodId: f.ids.period, itemId: f.ids.item, expectedPeriodVersion: linked.periodVersion,
      expectedFinancialVersion: linked.financialVersion, kind: 'planned_spend', title: '不可改写',
      categoryCode: 'food', plannedOn: f.today, userEstimatedAmountMinor: 9000,
      priority: 'adjustable', changeReason: '不应改写已关联计划' })),
    (error: { code?: string }) => error.code === 'ITEM_NOT_ORDERABLE');
  }
});

test('R2 自动退款批次沿原订单商户归属复核，其他商户拒绝', async () => {
  const f = await m1ClosureFixture(); const created = await f.createOrder();
  const { prepareConsumerPaymentHandoff } = await import('./consumer-orders.js');
  const { createAftercarePreview, confirmAftercare } = await import('./consumer-aftercare.js');
  const { listMerchantConsumerRefunds } = await import('./merchant-consumer.js');
  const { requestOperationRecheck } = await import('./operation-rechecks.js');
  await transaction(client => prepareConsumerPaymentHandoff(client, f.ids.user, created.orderId));
  const payment = await claimNextJob(); assert.ok(payment); await processClaimedJob(payment);
  const accepted = await transaction(async client => {
    const preview = await createAftercarePreview(client, f.ids.user, created.orderId, { action: 'cancel' });
    return confirmAftercare(client, f.ids.user, created.orderId, { previewId: preview.previewId,
      acceptedFeeMinor: preview.feeMinor, acceptedRefundMinor: preview.expectedRefundMinor, confirmedByUser: true });
  });
  const batch = (await pool.query('SELECT cancellation_request_id,merchant_id FROM refund_batches WHERE order_id=$1', [created.orderId])).rows[0];
  assert.equal(batch.merchant_id, null);
  assert.equal((await transaction(client => listMerchantConsumerRefunds(client, f.ids.merchant, batch.cancellation_request_id))).length, 1);
  const merchant = { id: f.ids.merchant, email: '', displayName: '', role: 'merchant_admin' as const };
  const result = await transaction(client => requestOperationRecheck(client, merchant, accepted.operationId!, { reason: '原退款批次复核' }));
  assert.equal(result.status, 'accepted');
  await assert.rejects(transaction(client => requestOperationRecheck(client, { ...merchant, id: randomUUID() },
    accepted.operationId!, { reason: '其他商户不得复核' })), (error: { statusCode?: number }) => error.statusCode === 404);
  assert.equal(Number((await pool.query('SELECT count(*) FROM refund_batches WHERE order_id=$1', [created.orderId])).rows[0].count), 1);
});
