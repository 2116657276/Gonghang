import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { config } from '../config.js';

const connection = new URL(config.databaseUrl);
assert.ok(['localhost', '127.0.0.1'].includes(connection.hostname), '故障测试只允许本机数据库');
assert.match(connection.pathname, /^\/xingzhi_(?:dev|test(?:_[a-z0-9_]+)?|m1_acceptance_[a-z0-9_]+)$/,
  '测试只允许使用本机行止开发库或显式命名的隔离测试库');
const admin = new Pool({ connectionString: connection.toString() });
const schema = `xz_test_${randomUUID().replaceAll('-', '')}`;
connection.searchParams.set('options', `-c search_path=${schema}`);
config.databaseUrl = connection.toString();
config.paymentMode = 'simulation';
const { pool, transaction, closePool } = await import('../db/client.js');
const { claimNextJob, processClaimedJob } = await import('./worker-runtime.js');
const { createOperationJob } = await import('./jobs.js');

before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  const dir = new URL('../db/migrations/', import.meta.url);
  for (const name of (await readdir(dir)).filter(n => n.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(name, dir), 'utf8'));
  }
});
after(async () => {
  await closePool();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

type SimulationOutcome = 'SUCCESS' | 'PENDING' | 'UNKNOWN';

async function fixture(
  type: 'simulate_payment' | 'simulate_close' | 'simulate_refund_batch' = 'simulate_payment',
  environment = 'simulation',
  outcomes: { payment?: SimulationOutcome; close?: SimulationOutcome; refund?: SimulationOutcome } = {},
) {
  const ids = { user: randomUUID(), merchant: randomUUID(), plan: randomUUID(), item: randomUUID(), proposal: randomUUID(), confirmation: randomUUID(), auth: randomUUID(), order: randomUUID(), cancellation: randomUUID(), batch: randomUUID() };
  const operation = await transaction(async client => {
    await client.query(`INSERT INTO users (id,email,display_name,role,password_hash) VALUES ($1,$2,'测试消费者','consumer','disabled'),($3,$4,'测试商户','merchant_admin','disabled')`, [ids.user, `${ids.user}@test.local`, ids.merchant, `${ids.merchant}@test.local`]);
    await client.query("INSERT INTO plans (id,owner_id,purpose) VALUES ($1,$2,'自动验收')", [ids.plan, ids.user]);
    await client.query("INSERT INTO plan_items (id,plan_id,name,kind,price_minor,position) VALUES ($1,$2,'测试订单','stay',88000,1)", [ids.item, ids.plan]);
    await client.query("INSERT INTO proposals (id,plan_id,owner_id,type,status,plan_version,snapshot,expires_at) VALUES ($1,$2,$3,'purchase','confirmed',1,'{}',now()+interval '1 day')", [ids.proposal, ids.plan, ids.user]);
    await client.query("INSERT INTO confirmations (id,plan_id,owner_id,proposal_id,type,snapshot) VALUES ($1,$2,$3,$4,'purchase','{}')", [ids.confirmation, ids.plan, ids.user, ids.proposal]);
    await client.query("INSERT INTO authorizations (id,plan_id,owner_id,confirmation_id,type,scope,expires_at) VALUES ($1,$2,$3,$4,'purchase','{}',now()+interval '1 day')", [ids.auth, ids.plan, ids.user, ids.confirmation]);
    await client.query(`INSERT INTO orders (id,plan_id,plan_item_id,owner_id,merchant_id,confirmation_id,purchase_authorization_id,item_name,amount_minor,
      environment,provider,payment_status,simulation_mode,close_simulation_mode,refund_simulation_mode,reserved_minor)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'测试订单',88000,$8,$9,$10,$11,$12,$13,88000)`, [
      ids.order,ids.plan,ids.item,ids.user,ids.merchant,ids.confirmation,ids.auth,environment,
      environment === 'simulation' ? 'simulation' : 'alipay', type === 'simulate_refund_batch' ? 'paid' : 'pending',
      outcomes.payment ?? 'SUCCESS', outcomes.close ?? 'SUCCESS', outcomes.refund ?? 'SUCCESS',
    ]);
    await client.query("INSERT INTO payment_attempts (id,order_id,business_number,status,environment,provider) VALUES ($1,$2,$3,'pending',$4,$5)", [randomUUID(), ids.order, `TEST_${ids.order.replaceAll('-','')}`,environment,environment === 'simulation' ? 'simulation' : 'alipay']);
    if (type === 'simulate_refund_batch') {
      await client.query("INSERT INTO cancellation_requests (id,order_id,proposal_id,confirmation_id,accepted_fee_minor,accepted_refund_minor,status,rule_preset) VALUES ($1,$2,$3,$4,8000,80000,'approved','two_batches')", [ids.cancellation,ids.order,ids.proposal,ids.confirmation]);
      await client.query("INSERT INTO refund_batches (id,cancellation_request_id,order_id,merchant_id,environment,provider,batch_number,business_number,amount_minor) VALUES ($1,$2,$3,$4,$5,$6,1,$7,40000)", [ids.batch,ids.cancellation,ids.order,ids.merchant,environment,environment === 'simulation' ? 'simulation' : 'alipay',`REF_${ids.batch}`]);
    }
    return createOperationJob(client, {planId:ids.plan,ownerId:ids.user,type,entityId:type === 'simulate_refund_batch' ? ids.batch : ids.order,purpose:'automated_test'});
  });
  if (type === 'simulate_refund_batch') await pool.query('UPDATE refund_batches SET operation_id=$2 WHERE id=$1',[ids.batch,operation]);
  return {...ids,operation};
}

async function resetModelLedger() {
  // Each model test uses the file-local isolated schema. Always restore the
  // shared ledger so later tests do not inherit a prior run's cost.
  await pool.query('DELETE FROM model_usage');
  await pool.query('UPDATE model_budget SET spent_micros=0,reserved_micros=0 WHERE id=1');
}

for (const type of ['simulate_payment', 'simulate_close', 'simulate_refund_batch'] as const) {
  test(`${type}: 错误环境不能修改订单、退款及占用`, async () => {
    const f = await fixture(type, 'sandbox');
    const before = (await pool.query('SELECT * FROM orders WHERE id=$1',[f.order])).rows[0];
    const job = await claimNextJob(); assert.ok(job);
    await processClaimedJob(job);
    assert.deepEqual((await pool.query('SELECT * FROM orders WHERE id=$1',[f.order])).rows[0],before);
    assert.equal((await pool.query('SELECT state FROM operations WHERE id=$1',[f.operation])).rows[0].state,'failed');
    if(type === 'simulate_refund_batch') assert.equal((await pool.query('SELECT status FROM refund_batches WHERE id=$1',[f.batch])).rows[0].status,'pending');
  });
}

test('结果事务失败全部回滚；租约过期后接管；提交后重复投递不重复退款或事件', async () => {
  const f = await fixture('simulate_refund_batch');
  const old = await claimNextJob(); assert.ok(old);
  await pool.query(`CREATE FUNCTION reject_test_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected event failure'; END $$;
    CREATE TRIGGER reject_test_event BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION reject_test_event()`);
  await assert.rejects(processClaimedJob(old), /injected event failure/);
  assert.equal((await pool.query('SELECT refunded_minor FROM orders WHERE id=$1',[f.order])).rows[0].refunded_minor,0);
  assert.equal((await pool.query('SELECT status FROM refund_batches WHERE id=$1',[f.batch])).rows[0].status,'pending');
  await pool.query('DROP TRIGGER reject_test_event ON events; DROP FUNCTION reject_test_event()');
  await pool.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE operation_id=$1",[f.operation]);
  const replacement = await claimNextJob(); assert.ok(replacement);
  assert.equal(await processClaimedJob(old),false);
  assert.equal(await processClaimedJob(replacement),true);
  assert.equal(await processClaimedJob(replacement),false);
  assert.equal((await pool.query('SELECT refunded_minor FROM orders WHERE id=$1',[f.order])).rows[0].refunded_minor,40000);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM events WHERE plan_id=$1',[f.plan])).rows[0].count,1);
});

test('实际执行进程在领取后及提交后退出，重启复用原任务且只记账一次', async () => {
  const f=await fixture('simulate_refund_batch');
  const runChild=async (execute:boolean) => {
    const script=`
      const {config}=await import(${JSON.stringify(new URL('../config.js',import.meta.url).href)});
      config.databaseUrl=process.env.RECOVERY_TEST_DATABASE;config.paymentMode='simulation';
      const {claimNextJob,processClaimedJob}=await import(${JSON.stringify(new URL('./worker-runtime.js',import.meta.url).href)});
      const job=await claimNextJob();
      if(${execute}) await processClaimedJob(job);
      process.send(job);setInterval(()=>{},1000);
    `;
    const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script],{
      env:{...process.env,RECOVERY_TEST_DATABASE:connection.toString()},stdio:['ignore','ignore','inherit','ipc'],
    });
    try {
      const [job]=await once(child,'message',{signal:AbortSignal.timeout(10000)});
      return job as NonNullable<Awaited<ReturnType<typeof claimNextJob>>>;
    } finally {
      const exited=once(child,'exit');child.kill('SIGKILL');await exited;
    }
  };
  const old=await runChild(false);
  assert.equal(old.operation_id,f.operation);
  assert.equal((await pool.query('SELECT refunded_minor FROM orders WHERE id=$1',[f.order])).rows[0].refunded_minor,0);
  await pool.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE operation_id=$1",[f.operation]);
  const committed=await runChild(true);
  assert.equal(committed.operation_id,f.operation);
  assert.equal(await processClaimedJob(old),false);
  assert.equal(await processClaimedJob(committed),false);
  assert.equal((await pool.query('SELECT refunded_minor FROM orders WHERE id=$1',[f.order])).rows[0].refunded_minor,40000);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM events WHERE plan_id=$1',[f.plan])).rows[0].n,1);
});

test('两个执行者只领取一次；未知付款继续占用', async () => {
  const f = await fixture();
  await pool.query("UPDATE orders SET simulation_mode='UNKNOWN' WHERE id=$1",[f.order]);
  const jobs = (await Promise.all([claimNextJob(),claimNextJob()])).filter(j=>j!==undefined);
  assert.equal(jobs.length,1); await processClaimedJob(jobs[0]!);
  const order=(await pool.query('SELECT payment_status,reserved_minor FROM orders WHERE id=$1',[f.order])).rows[0];
  assert.equal(order.payment_status,'unknown'); assert.equal(order.reserved_minor,88000);
});

test('付款、关单与退款模拟结果互相独立', async () => {
  const close = await fixture('simulate_close', 'simulation', { payment: 'SUCCESS', close: 'UNKNOWN' });
  const closeJob = await claimNextJob(); assert.ok(closeJob);
  await processClaimedJob(closeJob);
  assert.equal((await pool.query('SELECT payment_status,reserved_minor FROM orders WHERE id=$1',[close.order])).rows[0].payment_status,'pending');
  assert.equal((await pool.query('SELECT state FROM operations WHERE id=$1',[close.operation])).rows[0].state,'unknown');

  const refund = await fixture('simulate_refund_batch', 'simulation', { payment: 'SUCCESS', refund: 'PENDING' });
  const refundJob = await claimNextJob(); assert.ok(refundJob);
  await processClaimedJob(refundJob);
  assert.equal((await pool.query('SELECT refunded_minor FROM orders WHERE id=$1',[refund.order])).rows[0].refunded_minor,0);
  assert.equal((await pool.query('SELECT state FROM operations WHERE id=$1',[refund.operation])).rows[0].state,'pending_review');
  assert.equal((await pool.query('SELECT status FROM refund_batches WHERE id=$1',[refund.batch])).rows[0].status,'pending_review');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM manual_tasks WHERE refund_batch_id=$1',[refund.batch])).rows[0].n,1);
});

test('B03—B06 新消费者订单按预算周期完成模拟付款、意外调整与退款到账', async () => {
  config.paymentMode='simulation';
  const ids={user:randomUUID(),merchant:randomUUID(),account:randomUUID(),snapshot:randomUUID(),
    period:randomUUID(),dinner:randomUUID(),flexible:randomUUID(),essential:randomUUID(),
    catalog:randomUUID(),quote:randomUUID()};
  const now=new Date();
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const monthStart=`${today.slice(0,7)}-01`;
  const monthEndDate=new Date(`${monthStart}T00:00:00Z`);monthEndDate.setUTCMonth(monthEndDate.getUTCMonth()+1);monthEndDate.setUTCDate(0);
  const monthEnd=monthEndDate.toISOString().slice(0,10);
  await transaction(async client=>{
    await client.query(`INSERT INTO users(id,email,display_name,role,password_hash)
      VALUES($1,$2,'B 阶段消费者','consumer','disabled'),($3,$4,'B 阶段商户','merchant_admin','disabled')`,
    [ids.user,`${ids.user}@test.local`,ids.merchant,`${ids.merchant}@test.local`]);
    await client.query(`INSERT INTO finance_accounts
      (id,owner_id,provider,account_type,provider_account_ref,masked_identifier,display_name,source,authorized_at)
      VALUES($1,$2,'demo','debit',$4,'****B07','B07 Demo 账户','demo',$3)`,
    [ids.account,ids.user,now,ids.account]);
    await client.query(`INSERT INTO finance_account_snapshots
      (id,account_id,available_balance_minor,current_balance_minor,as_of,covered_through_at,fact_status,source)
      VALUES($1,$2,200000,200000,$3,$3,'observed','demo')`,[ids.snapshot,ids.account,now]);
    await client.query(`INSERT INTO budget_periods
      (id,owner_id,primary_account_id,baseline_snapshot_id,month_start,month_end,
        savings_target_minor,status,necessities_confirmed_at)
      VALUES($1,$2,$3,$4,$5,$6,50000,'active',now())`,
    [ids.period,ids.user,ids.account,ids.snapshot,monthStart,monthEnd]);
    await client.query(`INSERT INTO budget_items
      (id,owner_id,period_id,account_id,kind,title,category_code,planned_on,
        user_estimated_amount_minor,priority) VALUES
      ($1,$4,$5,$6,'essential_expense','必要支出',NULL,$7,90000,'required'),
      ($2,$4,$5,$6,'planned_spend','朋友聚餐','food',$8,8000,'adjustable'),
      ($3,$4,$5,$6,'planned_spend','其他可调开支',NULL,$7,32000,'adjustable')`,
    [ids.essential,ids.dinner,ids.flexible,ids.user,ids.period,ids.account,monthEnd,today]);
    await client.query(`INSERT INTO catalog_items
      (id,merchant_id,code,name,kind,description,price_minor,rule_label,cancellation_rule,
        simulation_mode,close_simulation_mode,refund_simulation_mode,category_code,purchase_mode)
      VALUES($1,$2,$3,'Demo 双人晚餐','food','B07 连续验收',9900,'全额退款','full_refund',
        'SUCCESS','SUCCESS','SUCCESS','food','orderable')`,[ids.catalog,ids.merchant,`B07-${ids.catalog}`]);
    await client.query(`INSERT INTO offer_quotes
      (id,catalog_item_id,provider,quote_source,provider_quote_ref,quote_version,price_minor,
        service_on,rule_version,rule_snapshot,valid_until)
      VALUES($1,$2,'simulation','demo',$3,1,9900,$4,1,$5,now()+interval '1 hour')`,
    [ids.quote,ids.catalog,`B07-${ids.quote}`,today,{cancellationRule:'full_refund'}]);
  });
  const {assessPurchasePreview}=await import('./purchase-assessment.js');
  const {createPurchaseIntent}=await import('./purchase-intents.js');
  const {confirmPurchaseIntent,prepareConsumerPaymentHandoff}=await import('./consumer-orders.js');
  const {createBudgetAdjustment,confirmBudgetAdjustment}=await import('./budget-adjustments.js');
  const versions=async()=>{
    const row=(await pool.query<{financial:string;period:string}>(`SELECT a.financial_version AS financial,p.version AS period
      FROM finance_accounts a JOIN budget_periods p ON p.primary_account_id=a.id WHERE p.id=$1`,[ids.period])).rows[0]!;
    return {financial:Number(row.financial),period:Number(row.period)};
  };
  const initial=await versions();
  const preview=await transaction(client=>assessPurchasePreview(client,ids.user,{
    periodId:ids.period,budgetItemId:ids.dinner,quoteId:ids.quote,
    expectedFinancialVersion:initial.financial,expectedPeriodVersion:initial.period,
    expectedQuoteVersion:1,mode:'preview',
  },now));
  assert.equal(preview.status,'allowed');assert.equal(preview.incrementalImpactMinor,1900);
  const intent=await transaction(client=>createPurchaseIntent(client,ids.user,'b07-intent',{
    periodId:ids.period,budgetItemId:ids.dinner,quoteId:ids.quote,assessmentId:preview.assessmentId,
    expectedFinancialVersion:initial.financial,expectedPeriodVersion:initial.period,expectedQuoteVersion:1,
  },now));
  const confirmed=await transaction(client=>confirmPurchaseIntent(client,ids.user,intent.purchaseIntentId,{
    acceptedAmountMinor:9900,expectedFinancialVersion:initial.financial,
    expectedPeriodVersion:initial.period,expectedQuoteVersion:1,confirmedByUser:true,
  }));
  const orderId=confirmed.order.orderId;
  assert.equal(confirmed.order.paymentStatus,'pending');
  const handoff=await transaction(client=>prepareConsumerPaymentHandoff(client,ids.user,orderId));
  assert.equal(handoff.requiresUserAction,false);
  const paymentJob=await claimNextJob();assert.ok(paymentJob);assert.equal(paymentJob.budget_period_id,ids.period);
  await processClaimedJob(paymentJob);
  assert.equal((await pool.query('SELECT payment_status FROM orders WHERE id=$1',[orderId])).rows[0].payment_status,'paid');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM finance_money_events
    WHERE order_id=$1 AND event_type='payment_posted'`,[orderId])).rows[0].n,1);

  const afterPayment=await versions();
  const large=await transaction(client=>createBudgetAdjustment(client,ids.user,{
    periodId:ids.period,amountMinor:40000,plannedOn:monthEnd,reason:'临时必要维修',
    expectedFinancialVersion:afterPayment.financial,expectedPeriodVersion:afterPayment.period,
  }));
  assert.ok(large.options.some(option=>option.changes.some(change=>change.action==='cancel')
    && option.assessment.status==='allowed'));
  const small=await transaction(client=>createBudgetAdjustment(client,ids.user,{
    periodId:ids.period,amountMinor:100,plannedOn:today,reason:'临时交通补付',
    expectedFinancialVersion:afterPayment.financial,expectedPeriodVersion:afterPayment.period,
  }));
  const cancelOrder=small.options.find(option=>option.changes.some(change=>change.action==='cancel_order'));
  assert.ok(cancelOrder);assert.equal(cancelOrder.assessment.status,'allowed');
  const adjusted=await transaction(client=>confirmBudgetAdjustment(client,ids.user,small.adjustmentId,{
    acceptedOptionId:cancelOrder.optionId,expectedFinancialVersion:afterPayment.financial,
    expectedPeriodVersion:afterPayment.period,confirmedByUser:true,
  }));
  assert.equal(adjusted.status,'executing');assert.equal(adjusted.cancellationRequestIds.length,1);
  const refundJob=await claimNextJob();assert.ok(refundJob);assert.equal(refundJob.type,'simulate_refund_batch');
  await processClaimedJob(refundJob);
  const result=(await pool.query('SELECT status,refunded_minor FROM orders WHERE id=$1',[orderId])).rows[0];
  assert.deepEqual(result,{status:'cancelled',refunded_minor:9900});
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM finance_money_events
    WHERE order_id=$1 AND event_type='refund_posted'`,[orderId])).rows[0].n,1);
  assert.equal((await pool.query('SELECT status FROM budget_adjustment_proposals WHERE id=$1',[small.adjustmentId])).rows[0].status,'complete');
  assert.ok(Number((await pool.query('SELECT count(*) AS n FROM budget_events WHERE period_id=$1',[ids.period])).rows[0].n)>=8);
});

test('B02/B07 新消费者 Agent 真实运行只保存待确认草稿',async()=>{
  const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai');
  const {startConsumerAgentRun,executeConsumerAgentRun,readConsumerAgentRun,listConsumerAgentRuns}=await import('./consumer-agent-runtime.js');
  const userId=randomUUID();
  await pool.query(`INSERT INTO users(id,email,display_name,role,password_hash)
    VALUES($1,$2,'规划 Agent 消费者','consumer','disabled')`,[userId,`${userId}@test.local`]);
  await resetModelLedger();
  try {
    const user={id:userId,email:'',displayName:'',role:'consumer' as const};
    const run=await startConsumerAgentRun(user,'consumer-agent-b07',{message:'帮我记录一次朋友聚餐',periodId:null});
    let calls=0;
    await executeConsumerAgentRun(run.runId,user,'帮我记录一次朋友聚餐',null,new AbortController().signal,(model)=>{
      calls++;
      const stream=createAssistantMessageEventStream();
      const tool=calls===1;
      stream.push({type:'done',reason:tool?'toolUse':'stop',message:{role:'assistant',api:model.api,
        provider:model.provider,model:model.id,timestamp:Date.now(),stopReason:tool?'toolUse':'stop',
        content:tool?[{type:'toolCall',id:'save-draft',name:'save_planning_draft',arguments:{
          items:[{
            title:'朋友聚餐',plannedOn:null,userEstimatedAmountMinor:null,priority:null,
            requirements:['与朋友吃饭'],catalogItemId:null,suggestion:null,
          }],
        }}]:[{type:'text',text:'需求草稿已保存，日期、预算和优先级仍需你确认。'}],
        usage:{input:10,cacheRead:0,cacheWrite:0,output:5,totalTokens:15,
          cost:{input:0,cacheRead:0,cacheWrite:0,output:0,total:0}}}});
      return stream;
    });
    const result=await readConsumerAgentRun(user,run.runId);
    assert.equal(result.state,'COMPLETED');assert.equal(result.toolCalls,1);assert.equal(calls,2);
    assert.equal(result.artifacts.length,1);assert.equal(result.artifacts[0]!.type,'planning_draft');
    const listed=await listConsumerAgentRuns(user,{periodId:null});
    assert.equal(listed.items[0]!.id,run.runId);assert.equal(listed.nextCursor,null);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM planning_drafts
      WHERE owner_id=$1 AND period_id IS NULL`,[userId])).rows[0].n,1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders WHERE owner_id=$1',[userId])).rows[0].n,0);
  } finally {
    await resetModelLedger();
  }
});

const { processChannelJob } = await import('./channel-worker.js');
const { buildApp } = await import('../app.js');
const { createSession } = await import('../auth/session.js');
let app: Awaited<ReturnType<typeof buildApp>>;
before(async()=>{app=await buildApp();});
after(async()=>{await app?.close();});

async function sandboxFixture(kind: 'sandbox_close'|'sandbox_refund' = 'sandbox_refund') {
  const f=await fixture(kind==='sandbox_refund'?'simulate_refund_batch':'simulate_close','sandbox');
  await pool.query('UPDATE operations SET type=$2,authorization_id=$3 WHERE id=$1',[f.operation,kind,f.auth]);
  await pool.query("UPDATE authorizations SET type='aftercare',scope=$2 WHERE id=$1",[f.auth,{orderIds:[f.order]}]);
  return f;
}
async function readyJob(operation:string) {
  await pool.query("UPDATE jobs SET next_run_at=now(),lease_until=now()-interval '1 second' WHERE operation_id=$1",[operation]);
  const job=await claimNextJob(); assert.ok(job); assert.equal(job.operation_id,operation);return job;
}
const noNetwork = {
  async queryTrade(): Promise<Awaited<ReturnType<typeof import('../payment/alipay-sandbox.js').queryAlipayTrade>>> { throw new Error('No network'); },
  async closeTrade() { throw new Error('No network'); },
  async refund() { throw new Error('No network'); },
  async queryRefund(): Promise<Awaited<ReturnType<typeof import('../payment/alipay-sandbox.js').queryAlipayRefund>>> { throw new Error('No network'); },
};

test('渠道退款只发送一次；中断后按固定退款号查询；成功结果原子记账',async()=>{
  config.paymentMode='sandbox';
  const f=await sandboxFixture();let sends=0;let queries=0;
  const number=(await pool.query('SELECT business_number FROM payment_attempts WHERE order_id=$1',[f.order])).rows[0].business_number;
  const refundNumber=(await pool.query('SELECT business_number FROM refund_batches WHERE id=$1',[f.batch])).rows[0].business_number;
  const adapter={...noNetwork,
    async refund(order:string,refund:string,amount:number) {sends++;assert.equal(order,number);assert.equal(refund,refundNumber);assert.equal(amount,40000);throw new Error('response lost');},
    async queryRefund(order:string,refund:string) {queries++;return {code:'10000',outTradeNo:order,outRequestNo:refund,refundAmount:'400.00',refundStatus:'REFUND_SUCCESS'};},
  };
  await processChannelJob(await readyJob(f.operation),adapter);
  assert.equal((await pool.query('SELECT refunded_minor FROM orders WHERE id=$1',[f.order])).rows[0].refunded_minor,0);
  assert.equal((await pool.query('SELECT status FROM refund_batches WHERE id=$1',[f.batch])).rows[0].status,'unknown');
  await processChannelJob(await readyJob(f.operation),adapter);
  assert.equal(sends,1);assert.equal(queries,1);
  assert.equal((await pool.query('SELECT refunded_minor FROM orders WHERE id=$1',[f.order])).rows[0].refunded_minor,40000);
  assert.equal((await pool.query('SELECT state FROM jobs WHERE operation_id=$1',[f.operation])).rows[0].state,'complete');
  config.paymentMode='simulation';
});

test('关单响应丢失后只查原单，旧领取返回不能覆盖恢复结果',async()=>{
  config.paymentMode='sandbox';
  try {
    const f=await sandboxFixture('sandbox_close');let closes=0;
    const first=await readyJob(f.operation);
    await processChannelJob(first,{...noNetwork,
      async queryTrade(order:string){return {code:'10000',outTradeNo:order,totalAmount:'880.00',tradeStatus:'WAIT_BUYER_PAY'};},
      async closeTrade(){closes++;throw new Error('response lost');},
    });
    await processChannelJob(await readyJob(f.operation),{...noNetwork,
      async queryTrade(order:string){return {code:'10000',outTradeNo:order,totalAmount:'880.00',tradeStatus:'WAIT_BUYER_PAY'};},
      async closeTrade(){closes++;throw new Error('must not resend');},
    });
    assert.equal(closes,1);
    assert.equal((await pool.query('SELECT reserved_minor FROM orders WHERE id=$1',[f.order])).rows[0].reserved_minor,88000);
    let release!:()=>void;
    let entered!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});
    const barrier=new Promise<void>(resolve=>{release=resolve;});
    const old=await readyJob(f.operation);
    const late=processChannelJob(old,{...noNetwork,async queryTrade(order:string){
      entered();await barrier;
      return {code:'10000',outTradeNo:order,totalAmount:'880.00',tradeStatus:'TRADE_SUCCESS'};
    }});
    await started;
    await processChannelJob(await readyJob(f.operation),{...noNetwork,async queryTrade(order:string){
      return {code:'10000',outTradeNo:order,totalAmount:'880.00',tradeStatus:'TRADE_CLOSED'};
    }});
    release();await late;
    assert.deepEqual((await pool.query('SELECT payment_status,reserved_minor FROM orders WHERE id=$1',[f.order])).rows[0],{payment_status:'closed',reserved_minor:0});
    assert.equal((await pool.query('SELECT state FROM operations WHERE id=$1',[f.operation])).rows[0].state,'succeeded');
  } finally {config.paymentMode='simulation';}
});

test('退款显式复核成功同步解决原批次人工待办，重复复核不重复累计',async()=>{
  config.paymentMode='sandbox';
  try {
    const f=await sandboxFixture();
    await pool.query("UPDATE operations SET created_at=now()-interval '31 minutes' WHERE id=$1",[f.operation]);
    await processChannelJob(await readyJob(f.operation),noNetwork);
    assert.equal((await pool.query('SELECT state FROM manual_tasks WHERE refund_batch_id=$1',[f.batch])).rows[0].state,'open');
    const recheck=await transaction(client=>createOperationJob(client,{planId:f.plan,ownerId:f.user,type:'sandbox_refund_recheck',entityId:f.batch,purpose:'merchant_query:test'}));
    const adapter={...noNetwork,async queryRefund(order:string,refund:string){
      return {code:'10000',outTradeNo:order,outRequestNo:refund,refundAmount:'400.00',refundStatus:'REFUND_SUCCESS'};
    }};
    await processChannelJob(await readyJob(recheck),adapter);
    assert.equal((await pool.query('SELECT state FROM manual_tasks WHERE refund_batch_id=$1',[f.batch])).rows[0].state,'resolved');
    assert.equal((await pool.query('SELECT state FROM operations WHERE id=$1',[f.operation])).rows[0].state,'succeeded');
    const again=await transaction(client=>createOperationJob(client,{planId:f.plan,ownerId:f.user,type:'sandbox_refund_recheck',entityId:f.batch,purpose:'merchant_query:again'}));
    await processChannelJob(await readyJob(again),adapter);
    assert.equal((await pool.query('SELECT refunded_minor FROM orders WHERE id=$1',[f.order])).rows[0].refunded_minor,40000);
  } finally {config.paymentMode='simulation';}
});

test('关单先核对；付款竞争转人工且不退款；未知查询保留占用',async()=>{
  config.paymentMode='sandbox';
  const f=await sandboxFixture('sandbox_close');let closes=0;
  await processChannelJob(await readyJob(f.operation),{...noNetwork,
    async queryTrade(order:string) {return {code:'10000',outTradeNo:order,totalAmount:'880.00',tradeStatus:'TRADE_SUCCESS'};},
    async closeTrade() {closes++;return {code:'10000',subCode:undefined,outTradeNo:undefined};},
  });
  assert.equal(closes,0);
  assert.equal((await pool.query('SELECT payment_status FROM orders WHERE id=$1',[f.order])).rows[0].payment_status,'paid');
  assert.equal((await pool.query('SELECT provider_status FROM payment_attempts WHERE order_id=$1',[f.order])).rows[0].provider_status,'TRADE_SUCCESS');
  assert.equal((await pool.query('SELECT state FROM operations WHERE id=$1',[f.operation])).rows[0].state,'pending_review');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM manual_tasks WHERE operation_id=$1',[f.operation])).rows[0].n,1);
  config.paymentMode='simulation';
});

test('已关单后到达付款观察不会重新打开订单',async()=>{
  config.paymentMode='sandbox';const f=await sandboxFixture('sandbox_close');
  await pool.query("UPDATE orders SET payment_status='closed',status='cancelled' WHERE id=$1",[f.order]);
  await processChannelJob(await readyJob(f.operation),{...noNetwork,
    async queryTrade(order:string) {return {code:'10000',outTradeNo:order,totalAmount:'880.00',tradeNo:'late-trade',tradeStatus:'TRADE_SUCCESS'};},
  });
  const order=(await pool.query('SELECT payment_status,status FROM orders WHERE id=$1',[f.order])).rows[0];
  assert.deepEqual(order,{payment_status:'closed',status:'cancelled'});
  assert.equal((await pool.query('SELECT state FROM operations WHERE id=$1',[f.operation])).rows[0].state,'pending_review');
  config.paymentMode='simulation';
});

test('渠道已结束交易在商户入口及发送前阻止普通退款，保留人工责任',async()=>{
  config.paymentMode='sandbox';
  const saved={...config.alipaySandbox};
  try {
    const f=await sandboxFixture();
    await pool.query("UPDATE payment_attempts SET provider_status='TRADE_FINISHED' WHERE order_id=$1",[f.order]);
    const session=await createSession(f.merchant);
    // Readiness only validates presence here; no network call is made.
    Object.assign(config.alipaySandbox,{appId:'test',privateKey:'test',publicKey:'test',sellerId:'test',gateway:'https://openapi-sandbox.dl.alipaydev.com/gateway.do',returnUrl:'http://localhost:5173/payment-return'});
    const response=await app.inject({method:'POST',url:`/api/merchant/cancellations/${f.cancellation}/refund-batches`,cookies:{xingzhi_session:session.token},headers:{origin:config.webOrigin,'idempotency-key':randomUUID()},payload:{}});
    assert.equal(response.statusCode,422,response.body);
    assert.equal(response.json().error,'TRADE_FINISHED');
    let calls=0;
    await processChannelJob(await readyJob(f.operation),{...noNetwork,async refund(){calls++;throw new Error('must not send');}});
    assert.equal(calls,0);
    const task=(await pool.query('SELECT state,reason FROM manual_tasks WHERE operation_id=$1',[f.operation])).rows[0];
    assert.equal(task.state,'open');assert.match(task.reason,/交易已结束/);
    assert.equal((await pool.query('SELECT refunded_minor FROM orders WHERE id=$1',[f.order])).rows[0].refunded_minor,0);
  }finally{Object.assign(config.alipaySandbox,saved);config.paymentMode='simulation';}
});

test('已过期且未发送的善后授权不触发渠道调用',async()=>{
  config.paymentMode='sandbox';const f=await sandboxFixture('sandbox_close');
  await pool.query("UPDATE authorizations SET expires_at=now()-interval '1 second' WHERE id=$1",[f.auth]);
  let calls=0;
  await processChannelJob(await readyJob(f.operation),{...noNetwork,async queryTrade(){calls++;throw new Error('unexpected');}});
  assert.equal(calls,0);
  assert.equal((await pool.query('SELECT payment_status,reserved_minor FROM orders WHERE id=$1',[f.order])).rows[0].reserved_minor,88000);
  config.paymentMode='simulation';
});

test('API-12 在模拟模式拒绝沙箱关单，事务内不生成模拟任务',async()=>{
  const f=await fixture('simulate_close','sandbox');
  await pool.query('DELETE FROM jobs WHERE operation_id=$1',[f.operation]);
  await pool.query('DELETE FROM operations WHERE id=$1',[f.operation]);
  await pool.query("UPDATE proposals SET type='change',snapshot=$2 WHERE id=$1",[f.proposal,{items:[{planItemId:f.item,orderId:f.order,intent:'close'}]}]);
  await pool.query("UPDATE confirmations SET type='change' WHERE id=$1",[f.confirmation]);
  await pool.query("UPDATE authorizations SET type='aftercare',scope=$2 WHERE id=$1",[f.auth,{orderIds:[f.order]}]);
  const session=await createSession(f.user);
  const response=await app.inject({method:'POST',url:`/api/change-proposals/${f.proposal}/execute`,cookies:{xingzhi_session:session.token},headers:{origin:config.webOrigin,'idempotency-key':randomUUID()},payload:{}});
  assert.equal(response.statusCode,422);assert.equal(response.json().error,'EXTERNAL_CLOSE_NOT_READY');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM operations WHERE plan_id=$1',[f.plan])).rows[0].n,0);
});

test('相同幂等键并发请求仅执行一次，JSON 字段顺序不制造冲突',async()=>{
  const f=await fixture();const job=await claimNextJob();assert.ok(job);await processClaimedJob(job);
  const {runIdempotent}=await import('./idempotency.js');let executions=0;
  const run=(payload:Record<string,unknown>)=>transaction(client=>runIdempotent(client,f.user,'test','stable',payload,async()=>{executions++;return {ok:true};}));
  await Promise.all([run({a:1,b:2}),run({b:2,a:1})]);assert.equal(executions,1);
  await assert.rejects(run({a:2,b:2}),/同一幂等键/);
});

test('消费者复核合并任务；执行前撤回查询授权则不访问渠道',async()=>{
  config.paymentMode='sandbox';const f=await sandboxFixture();
  await pool.query("UPDATE jobs SET state='complete' WHERE operation_id=$1",[f.operation]);
  await pool.query("UPDATE authorizations SET type='query' WHERE id=$1",[f.auth]);
  const session=await createSession(f.user);
  const request=()=>app.inject({method:'POST',url:`/api/operations/${f.operation}/rechecks`,cookies:{xingzhi_session:session.token},headers:{origin:config.webOrigin,'idempotency-key':randomUUID()},payload:{reason:'核对原退款'}});
  const [first,second]=await Promise.all([request(),request()]);
  assert.equal(first.statusCode,202);assert.equal(first.json().recheckOperationId,second.json().recheckOperationId);
  await pool.query("UPDATE authorizations SET status='revoked' WHERE id=$1",[f.auth]);
  let calls=0;
  const id=first.json().recheckOperationId;
  await processChannelJob(await readyJob(id),{...noNetwork,async queryRefund(){calls++;throw new Error('unexpected');}});
  assert.equal(calls,0);assert.equal((await pool.query('SELECT state FROM operations WHERE id=$1',[id])).rows[0].state,'failed');
  const rejected=await request();assert.equal(rejected.statusCode,422);
  config.paymentMode='simulation';
});

test('签名通知并发去重；退款后旧付款及关闭通知不能覆盖历史账本',async()=>{
  const {generateKeyPairSync,createSign}=await import('node:crypto');
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
  const saved={...config.alipaySandbox};config.paymentMode='sandbox';
  Object.assign(config.alipaySandbox,{appId:'test_app',sellerId:'test_seller',privateKey,publicKey,gateway:'https://openapi-sandbox.dl.alipaydev.com/gateway.do',returnUrl:'http://localhost:5173'});
  try {
    const f=await fixture('simulate_close','sandbox');
    await pool.query("UPDATE jobs SET state='complete' WHERE operation_id=$1",[f.operation]);
    await pool.query("UPDATE orders SET payment_status='paid',status='cancelled',refunded_minor=88000 WHERE id=$1",[f.order]);
    const number=(await pool.query('SELECT business_number FROM payment_attempts WHERE order_id=$1',[f.order])).rows[0].business_number;
    function body(status:string,notifyId:string,outTradeNo=number) {
      const fields:Record<string,string>={app_id:'test_app',seller_id:'test_seller',out_trade_no:outTradeNo,total_amount:'880.00',trade_status:status,notify_id:notifyId};
      const content=Object.keys(fields).sort().map(k=>`${k}=${fields[k]}`).join('&');
      fields.sign=createSign('RSA-SHA256').update(content).sign(privateKey,'base64');fields.sign_type='RSA2';
      return new URLSearchParams(fields).toString();
    }
    const send=(payload:string)=>app.inject({method:'POST',url:'/api/payments/alipay/notify',headers:{'content-type':'application/x-www-form-urlencoded'},payload});
    const payload=body('TRADE_SUCCESS','same_notification');
    const responses=await Promise.all([send(payload),send(payload)]);assert.deepEqual(responses.map(r=>r.statusCode),[200,200]);
    assert.equal((await send(body('TRADE_CLOSED','closed_notification'))).statusCode,200);
    const final=(await pool.query('SELECT payment_status,status,refunded_minor FROM orders WHERE id=$1',[f.order])).rows[0];
    assert.deepEqual(final,{payment_status:'paid',status:'cancelled',refunded_minor:88000});
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM payment_notifications WHERE notification_id='same_notification'")).rows[0].n,1);
    assert.equal((await send(payload.replace('880.00','999.00'))).statusCode,400);

    const late=await fixture('simulate_close','sandbox');
    await pool.query("UPDATE jobs SET state='complete' WHERE operation_id=$1",[late.operation]);
    await pool.query("UPDATE orders SET payment_status='closed',status='cancelled' WHERE id=$1",[late.order]);
    const lateNumber=(await pool.query('SELECT business_number FROM payment_attempts WHERE order_id=$1',[late.order])).rows[0].business_number;
    const latePayload=body('TRADE_SUCCESS','late_success_notification',lateNumber);
    const lateResponses=await Promise.all([send(latePayload),send(latePayload)]);
    assert.deepEqual(lateResponses.map(response=>response.statusCode),[200,200]);
    assert.equal((await send(latePayload)).statusCode,200);
    assert.equal((await send(body('TRADE_CLOSED','late_success_notification',lateNumber))).statusCode,400);
    const invalidPayload=body('TRADE_SUCCESS','unknown_order_notification','UNKNOWN_ORDER');
    assert.equal((await send(invalidPayload)).statusCode,400);
    assert.equal((await send(invalidPayload)).statusCode,400);
    const lateOrder=(await pool.query('SELECT payment_status,status FROM orders WHERE id=$1',[late.order])).rows[0];
    assert.deepEqual(lateOrder,{payment_status:'closed',status:'cancelled'});
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM manual_tasks WHERE dedupe_key=$1",[`payment-conflict:${late.order}`])).rows[0].n,1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM payment_notifications WHERE notification_id='late_success_notification'")).rows[0].n,1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM events WHERE plan_id=$1 AND type='sandbox.payment_conflict_requires_review'",[late.plan])).rows[0].n,1);
  } finally {Object.assign(config.alipaySandbox,saved);config.paymentMode='simulation';}
});

test('累计模型预算跨调用原子预占；未知费用保留；重复结算不重复扣费',async()=>{
  const {reserveModelCost,settleModelCost}=await import('./model-budget.js');
  const a=randomUUID(),b=randomUUID();
  const results=await Promise.allSettled([transaction(c=>reserveModelCost(c,a,'plan_a',60_000_000)),transaction(c=>reserveModelCost(c,b,'plan_b',60_000_000))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const id=results[0].status==='fulfilled'?a:b;
  assert.equal(Number((await pool.query('SELECT reserved_micros FROM model_budget WHERE id=1')).rows[0].reserved_micros),60_000_000);
  await transaction(c=>settleModelCost(c,id,10_000_000,{source:'test'}));
  await transaction(c=>settleModelCost(c,id,10_000_000,{source:'test'}));
  await transaction(c=>reserveModelCost(c,randomUUID(),'unknown_usage',89_000_000));
  await assert.rejects(transaction(c=>reserveModelCost(c,randomUUID(),'over_budget',2_000_000)),/预算不足/);
  const budget=(await pool.query('SELECT spent_micros,reserved_micros FROM model_budget WHERE id=1')).rows[0];
  assert.equal(Number(budget.spent_micros),10_000_000);assert.equal(Number(budget.reserved_micros),89_000_000);
});

test('API-06R 调用前限频与幂等缓存直接返回，不访问网关',async()=>{
  const saved=config.alipaySandbox.gateway;config.alipaySandbox.gateway='https://example.invalid/gateway.do';config.paymentMode='sandbox';
  try {
    const f=await fixture('simulate_close','sandbox');await pool.query("UPDATE jobs SET state='complete' WHERE operation_id=$1",[f.operation]);
    await pool.query("UPDATE payment_attempts SET query_not_before=now()+interval '15 seconds' WHERE order_id=$1",[f.order]);
    const session=await createSession(f.user);const key=randomUUID();
    const request=()=>app.inject({method:'POST',url:`/api/orders/${f.order}/payment-rechecks`,cookies:{xingzhi_session:session.token},headers:{origin:config.webOrigin,'idempotency-key':key},payload:{}});
    const limited=await request();assert.equal(limited.statusCode,202);assert.equal(limited.json().retryAfterSeconds,15);
    await pool.query('INSERT INTO idempotency_records(actor_id,route,idempotency_key,request_payload,response_payload) VALUES($1,$2,$3,$4,$5)',[f.user,`POST /orders/${f.order}/payment-rechecks`,key,{}, {orderId:f.order,cached:true}]);
    const cached=await request();assert.equal(cached.statusCode,200);assert.equal(cached.json().cached,true);
  } finally {config.alipaySandbox.gateway=saved;config.paymentMode='simulation';}
});

test('历史无批次退款任务转人工，不覆盖已有退款金额',async()=>{
  const f=await fixture('simulate_refund_batch');
  await pool.query("UPDATE operations SET type='simulate_refund',entity_id=$2 WHERE id=$1",[f.operation,f.cancellation]);
  await pool.query('UPDATE orders SET refunded_minor=10000 WHERE id=$1',[f.order]);
  const job=await claimNextJob();assert.ok(job);await processClaimedJob(job);
  assert.equal((await pool.query('SELECT refunded_minor FROM orders WHERE id=$1',[f.order])).rows[0].refunded_minor,10000);
  assert.equal((await pool.query('SELECT state FROM operations WHERE id=$1',[f.operation])).rows[0].state,'pending_review');
});

test('审核者只能读取已分配计划的操作且结果脱敏',async()=>{
  const f=await fixture();
  const reviewer=randomUUID();
  await pool.query("INSERT INTO users (id,email,display_name,role,password_hash) VALUES ($1,$2,'测试审核者','reviewer','disabled')",[reviewer,`${reviewer}@test.local`]);
  await pool.query('INSERT INTO review_scopes (reviewer_id,plan_id) VALUES ($1,$2)',[reviewer,f.plan]);
  await pool.query("UPDATE operations SET result=$2 WHERE id=$1",[f.operation,{tradeNo:'SECRET_TRADE_123456',source:'test'}]);
  const session=await createSession(reviewer);
  const response=await app.inject({method:'GET',url:`/api/operations/${f.operation}`,cookies:{xingzhi_session:session.token}});
  assert.equal(response.statusCode,200);
  assert.equal(response.json().result.tradeNo,'SECR…3456');
});

test('Agent 运行幂等、同计划互斥、持久限流、取消和过期恢复',async()=>{
  const {startAgentRun,readAgentRun,cancelAgentRun}=await import('./agent-runs.js');
  const f=await fixture();const other=await fixture();
  const user={id:f.user,email:'test@test.local',displayName:'测试',role:'consumer' as const};
  const key=randomUUID();
  const [a,b]=await Promise.all([startAgentRun(user,f.plan,key,'查询'),startAgentRun(user,f.plan,key,'查询')]);
  assert.equal(a.runId,b.runId);
  await assert.rejects(startAgentRun(user,f.plan,key,'另一条消息'),/请求标识/);
  await assert.rejects(startAgentRun(user,f.plan,randomUUID(),'查询'),/已有运行/);
  await assert.rejects(startAgentRun(user,other.plan,randomUUID(),'查询'),/权限/);
  await assert.rejects(readAgentRun({...user,id:other.user},a.runId),/未找到/);
  await cancelAgentRun(user,a.runId);await cancelAgentRun(user,a.runId);
  assert.equal((await readAgentRun(user,a.runId)).state,'CANCELLED');
  const second=await startAgentRun(user,f.plan,randomUUID(),'查询');
  await pool.query("UPDATE agent_runs SET deadline=now()-interval '1 second' WHERE id=$1",[second.runId]);
  assert.equal((await readAgentRun(user,second.runId)).error_code,'RUN_EXPIRED');
  await assert.rejects(startAgentRun(user,f.plan,randomUUID(),'查询'),/频繁/);
  await pool.query("UPDATE agent_rate_limits SET updated_at=now()-interval '6 seconds' WHERE owner_id=$1",[user.id]);
  const recovered=await startAgentRun(user,f.plan,randomUUID(),'重新读取事实');
  await cancelAgentRun(user,recovered.runId);
});

test('Agent 只读工具绑定计划、拒绝跨计划标识且不暴露渠道秘密',async()=>{
  const {readOnlyAgentTools}=await import('./agent-tools.js');
  const f=await fixture();const other=await fixture();
  const user={id:f.user,email:'test@test.local',displayName:'测试',role:'consumer' as const};
  const tools=readOnlyAgentTools(user,f.plan,async()=>{});
  assert.deepEqual(tools.map(t=>t.name),['search_catalog','get_plan_orders','get_cancellation_quote','get_operation_status']);
  const status=tools.find(t=>t.name==='get_operation_status')!;
  await assert.rejects(status.execute('cross',{id:other.operation}),/未找到/);
  await assert.rejects(status.execute('extra',{id:f.operation,requestRecheck:true}));
  await pool.query('UPDATE operations SET result=$2 WHERE id=$1',[f.operation,{tradeNo:'SECRET_TRADE_123456',rawBody:'PRIVATE_RAW_BODY'}]);
  const result=await status.execute('own',{id:f.operation});
  assert.ok(!JSON.stringify(result).includes('SECRET_TRADE_123456'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE_RAW_BODY'));
});

test('API-24 确定性 Pi 只读循环持久化输出与人民币费用，重复请求不重跑',async()=>{
  const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai');
  const f=await fixture();let calls=0;
  // Only the isolated test schema ledger is reset; never the development ledger.
  await resetModelLedger();
  const testApp=await buildApp({agentStream:(model)=>{
    calls++;
    const events=createAssistantMessageEventStream();
    const tool=calls===1;
    events.push({type:'done',reason:tool?'toolUse':'stop',message:{role:'assistant',api:model.api,provider:model.provider,model:model.id,
      timestamp:Date.now(),stopReason:tool?'toolUse':'stop',content:tool?[{type:'toolCall',id:'read_plan',name:'get_plan_orders',arguments:{}}]:[{type:'text',text:'当前是模拟订单，尚未付款。'}],
      usage:{input:10,cacheRead:20,cacheWrite:0,output:5,totalTokens:35,cost:{input:0,cacheRead:0,cacheWrite:0,output:0,total:0}}}});
    return events;
  }});
  try {
    const session=await createSession(f.user);const cookies={xingzhi_session:session.token};const key=randomUUID();
    const request={method:'POST' as const,url:`/api/plans/${f.plan}/agent-runs`,cookies,headers:{origin:config.webOrigin,'idempotency-key':key},payload:{message:'当前付款了吗？'}};
    assert.equal((await testApp.inject({...request,headers:{...request.headers,origin:'https://invalid.example'}})).statusCode,403);
    const created=await testApp.inject(request);assert.equal(created.statusCode,202);
    const runId=created.json().runId;
    let result:Record<string,unknown>={};
    for(let i=0;i<100;i++){
      result=(await testApp.inject({method:'GET',url:`/api/agent-runs/${runId}`,cookies})).json();
      if(result.state!=='RUNNING')break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(result.state,'COMPLETED');assert.equal(result.output,'当前是模拟订单，尚未付款。');
    assert.equal(result.model_calls,2);assert.equal(result.tool_calls,1);
    assert.equal((await testApp.inject(request)).json().runId,runId);assert.equal(calls,2);
    const budget=(await pool.query('SELECT spent_micros,reserved_micros FROM model_budget')).rows[0];
    assert.equal(Number(budget.spent_micros),122);assert.equal(Number(budget.reserved_micros),0);
  } finally {await testApp.close();await resetModelLedger();}
});

test('Agent 调用中取消保留未知费用，不能回写完成或改变订单',async()=>{
  const {startAgentRun,cancelAgentRun,readAgentRun}=await import('./agent-runs.js');
  const {executeAgentRun}=await import('./agent-runtime.js');
  const f=await fixture();const user={id:f.user,email:'test@test.local',displayName:'测试',role:'consumer' as const};
  const run=await startAgentRun(user,f.plan,randomUUID(),'读取计划');const controller=new AbortController();
  let started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});
  const task=executeAgentRun(run.runId,f.plan,user,'读取计划',controller.signal,async(_model,_context,options)=>{
    started();
    return new Promise((_resolve,reject)=>{
      if(options?.signal?.aborted)reject(new Error('cancelled'));
      else options?.signal?.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});
    });
  });
  await ready;await cancelAgentRun(user,run.runId);controller.abort();await task;
  assert.equal((await readAgentRun(user,run.runId)).state,'CANCELLED');
  const usage=(await pool.query('SELECT state,reserved_micros FROM model_usage WHERE purpose=$1',[`agent_run:${run.runId}:1`])).rows[0];
  assert.notEqual(usage.state,'settled');assert.equal(Number(usage.reserved_micros),2_008_192);
  assert.equal((await pool.query('SELECT payment_status FROM orders WHERE id=$1',[f.order])).rows[0].payment_status,'pending');
});

test('Agent 缺失 usage 时停止循环，不能把回答当成成功或释放预算',async()=>{
  const {startAgentRun,readAgentRun}=await import('./agent-runs.js');
  const {executeAgentRun}=await import('./agent-runtime.js');
  const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai');
  const f=await fixture();const user={id:f.user,email:'test@test.local',displayName:'测试',role:'consumer' as const};
  const run=await startAgentRun(user,f.plan,randomUUID(),'读取计划');let calls=0;
  await executeAgentRun(run.runId,f.plan,user,'读取计划',new AbortController().signal,model=>{
    calls++;const stream=createAssistantMessageEventStream();
    stream.push({type:'done',reason:'stop',message:{role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),stopReason:'stop',
      content:[{type:'text',text:'无法核验用量的回答'}],usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}});
    return stream;
  });
  const result=await readAgentRun(user,run.runId);assert.equal(result.state,'FAILED');assert.equal(result.output,'');assert.equal(calls,1);
  assert.notEqual((await pool.query('SELECT state FROM model_usage WHERE purpose=$1',[`agent_run:${run.runId}:1`])).rows[0].state,'settled');
});

async function draftFixture(){
  const f=await fixture();const catalog=randomUUID(),newItem=randomUUID();
  await pool.query(`INSERT INTO catalog_items(id,merchant_id,code,name,kind,description,price_minor,rule_label,simulation_mode)
    VALUES($1,$2,$3,'测试住宿','stay','固定虚构资料',88000,'全额退款','SUCCESS')`,[catalog,f.merchant,catalog]);
  await pool.query('UPDATE plan_items SET catalog_item_id=$2,merchant_id=$3 WHERE id=$1',[f.item,catalog,f.merchant]);
  await pool.query("INSERT INTO plan_items(id,plan_id,catalog_item_id,merchant_id,name,kind,price_minor,position) VALUES($1,$2,$3,$4,'未下单住宿','stay',88000,2)",[newItem,f.plan,catalog,f.merchant]);
  const user={id:f.user,email:'test@test.local',displayName:'测试',role:'consumer' as const};
  return {...f,catalog,newItem,actor:user};
}

test('T04 方案原子保存与并发复用；模型不能改价、跨计划或生成授权',async()=>{
  const {startAgentRun,readAgentRun}=await import('./agent-runs.js');
  const {createAgentProposal}=await import('./agent-proposals.js');
  const f=await draftFixture(),other=await draftFixture();
  const run=await startAgentRun(f.actor,f.plan,randomUUID(),'购买住宿');
  await assert.rejects(createAgentProposal(f.actor,f.plan,run.runId,'bad-price','propose_purchase',{itemIds:[f.newItem],totalMinor:1}));
  await assert.rejects(createAgentProposal(f.actor,f.plan,run.runId,'cross','propose_purchase',{itemIds:[other.newItem]}));
  await assert.rejects(createAgentProposal(f.actor,f.plan,run.runId,'existing','propose_purchase',{itemIds:[f.item]}),/已有订单/);
  const before=await pool.query('SELECT count(*)::int AS n FROM authorizations WHERE plan_id=$1',[f.plan]);
  const [a,b]=await Promise.all([1,2].map(()=>createAgentProposal(f.actor,f.plan,run.runId,'draft','propose_purchase',{itemIds:[f.newItem]})));
  assert.equal(a.proposalId,b.proposalId);
  const persisted=await readAgentRun(f.actor,run.runId);
  assert.equal(persisted.state,'WAITING_USER');assert.equal(persisted.proposal.totalMinor,88000);assert.equal(persisted.proposal.confirmable,true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM authorizations WHERE plan_id=$1',[f.plan])).rows[0].n,before.rows[0].n);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders WHERE plan_item_id=$1',[f.newItem])).rows[0].n,0);
  await assert.rejects(createAgentProposal(f.actor,f.plan,run.runId,'another','propose_change',{items:[{planItemId:f.newItem,intent:'stop'}]}),/已有待确认/);
  const session=await createSession(f.user);const cookies={xingzhi_session:session.token};
  const restored=await app.inject({method:'GET',url:`/api/plans/${f.plan}/agent-runs/latest`,cookies});
  assert.equal(restored.json().run.proposal.proposalId,a.proposalId);
  const confirmed=await app.inject({method:'POST',url:`/api/purchase-proposals/${a.proposalId}/confirm`,cookies,
    headers:{origin:config.webOrigin,'idempotency-key':randomUUID()},payload:{expectedVersion:1,acceptedItemIds:[f.newItem],purchaseLimitMinor:200000,restoreItemIds:[]}});
  assert.equal(confirmed.statusCode,201);
  const after=await readAgentRun(f.actor,run.runId);assert.equal(after.proposal.status,'confirmed');assert.equal(after.proposal.confirmationId,confirmed.json().confirmationId);
});

test('T08 草稿不修改订单，持久化失败回滚；取消和失效版本拒绝后续写入',async()=>{
  const {startAgentRun,readAgentRun,cancelAgentRun}=await import('./agent-runs.js');
  const {createAgentProposal}=await import('./agent-proposals.js');
  const f=await draftFixture();const run=await startAgentRun(f.actor,f.plan,randomUUID(),'关闭待付款订单');
  const input={items:[{planItemId:f.item,intent:'close'}]};
  const before=(await pool.query('SELECT count(*)::int AS n FROM proposals WHERE plan_id=$1',[f.plan])).rows[0].n;
  await pool.query("ALTER TABLE agent_run_proposals ADD CONSTRAINT test_rollback CHECK(tool_call_id<>'rollback')");
  try{await assert.rejects(createAgentProposal(f.actor,f.plan,run.runId,'rollback','propose_change',input));}
  finally{await pool.query('ALTER TABLE agent_run_proposals DROP CONSTRAINT test_rollback');}
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM proposals WHERE plan_id=$1',[f.plan])).rows[0].n,before);
  assert.equal((await readAgentRun(f.actor,run.runId)).state,'RUNNING');
  const draft=await createAgentProposal(f.actor,f.plan,run.runId,'draft','propose_change',input);
  assert.equal((await pool.query('SELECT payment_status FROM orders WHERE id=$1',[f.order])).rows[0].payment_status,'pending');
  await pool.query('UPDATE plans SET version=version+1 WHERE id=$1',[f.plan]);
  assert.equal((await readAgentRun(f.actor,run.runId)).proposal.confirmable,false);
  const session=await createSession(f.user);
  const rejected=await app.inject({method:'POST',url:`/api/change-proposals/${draft.proposalId}/confirm`,cookies:{xingzhi_session:session.token},
    headers:{origin:config.webOrigin,'idempotency-key':randomUUID()},payload:{expectedVersion:1,acceptedFeeMinor:0,acceptedRefundMinor:0,aftercareOrderIds:[f.order],queryOrderIds:[f.order]}});
  assert.equal(rejected.statusCode,409);
  const cancelled=await startAgentRun(f.actor,f.plan,randomUUID(),'新的变更');await cancelAgentRun(f.actor,cancelled.runId);
  await assert.rejects(createAgentProposal(f.actor,f.plan,cancelled.runId,'late','propose_change',input),/运行已结束/);
});

test('Pi 生成方案后结束本轮；同批确认工具被阻断，不再请求模型',async()=>{
  const {startAgentRun,readAgentRun}=await import('./agent-runs.js');
  const {executeAgentRun}=await import('./agent-runtime.js');
  const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai');
  const f=await draftFixture();const run=await startAgentRun(f.actor,f.plan,randomUUID(),'为住宿生成购买方案');let calls=0;
  await executeAgentRun(run.runId,f.plan,f.actor,'为住宿生成购买方案',new AbortController().signal,model=>{
    calls++;assert.equal(calls,1);
    const stream=createAssistantMessageEventStream();
    stream.push({type:'done',reason:'toolUse',message:{role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),stopReason:'toolUse',
      content:[{type:'toolCall',id:'draft',name:'propose_purchase',arguments:{itemIds:[f.newItem]}},{type:'toolCall',id:'confirm',name:'confirm_purchase',arguments:{}}],
      usage:{input:10,output:10,cacheRead:0,cacheWrite:0,totalTokens:20,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}});
    return stream;
  });
  const result=await readAgentRun(f.actor,run.runId);assert.equal(result.state,'WAITING_USER');assert.equal(result.proposal.status,'pending');assert.equal(calls,1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM confirmations WHERE proposal_id=$1',[result.proposal.proposalId])).rows[0].n,0);
});

test('Pi HTTP 429 重试逐次记账，成功结算不释放缺失 usage 的旧预占', async () => {
  const {startAgentRun,readAgentRun}=await import('./agent-runs.js');
  const {executeAgentRun}=await import('./agent-runtime.js');
  const f=await fixture(); const user={id:f.user,email:'test@test.local',displayName:'测试',role:'consumer' as const};
  const run=await startAgentRun(user,f.plan,randomUUID(),'只读测试');
  const savedKey=process.env.DEEPSEEK_API_KEY; process.env.DEEPSEEK_API_KEY='local-fixture-no-network';
  let attempts=0;
  try {
    await executeAgentRun(run.runId,f.plan,user,'只读测试',new AbortController().signal,undefined,async (_url,init) => {
      attempts++;
      assert.equal(JSON.parse(String(init?.body)).model,'deepseek-flash');
      if(attempts===1)return new Response('limited',{status:429,headers:{'Retry-After':'0'}});
      const chunk={id:'fixture',object:'chat.completion.chunk',created:1,model:'deepseek-flash',
        choices:[{index:0,delta:{role:'assistant',content:'这是本地只读测试。'},finish_reason:'stop'}],
        usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}};
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,{headers:{'Content-Type':'text/event-stream'}});
    });
  } finally {
    if(savedKey===undefined)delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY=savedKey;
  }
  const result=await readAgentRun(user,run.runId);
  assert.equal(result.state,'COMPLETED'); assert.equal(result.model_calls,2); assert.equal(attempts,2);
  const records=(await pool.query('SELECT state,reserved_micros,settled_micros FROM model_usage WHERE purpose LIKE $1 ORDER BY purpose',[`agent_run:${run.runId}:%`])).rows;
  assert.equal(records.length,2); assert.notEqual(records[0].state,'settled');
  assert.equal(Number(records[0].reserved_micros),2_008_192);
  assert.equal(records[1].state,'settled'); assert.equal(Number(records[1].settled_micros),60);
});

async function m1ClosureFixture(rule: 'full_refund'|'two_batches' = 'full_refund') {
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

test('M1 收口 1：过期意图自动释放，主动放弃后可重购、编辑和取消，确认竞争只有一个结果',async()=>{
  const f=await m1ClosureFixture();const session=await createSession(f.ids.user);
  const cookies={xingzhi_session:session.token};const headers=()=>({origin:config.webOrigin,'idempotency-key':randomUUID()});
  const basis=await f.versions();const assessmentId=randomUUID();const expiredIntentId=randomUUID();
  await pool.query(`INSERT INTO funding_assessments
    (id,owner_id,period_id,account_id,budget_item_id,quote_id,financial_version,period_version,
      quote_version,replaced_estimate_minor,quoted_amount_minor,incremental_impact_minor,status,
      basis_snapshot_id,expires_at,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,8000,9900,1900,'allowed',$9,
      now()-interval '5 minutes',now()-interval '10 minutes')`,
  [assessmentId,f.ids.user,f.ids.period,f.ids.account,f.ids.item,f.ids.quote,basis.financial,basis.period,f.ids.snapshot]);
  await pool.query(`INSERT INTO purchase_intents
    (id,owner_id,period_id,budget_item_id,quote_id,assessment_id,financial_version,period_version,
      quote_version,expires_at,idempotency_key,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,now()-interval '5 minutes',$9,now()-interval '10 minutes')`,
  [expiredIntentId,f.ids.user,f.ids.period,f.ids.item,f.ids.quote,assessmentId,basis.financial,basis.period,randomUUID()]);
  const changed=await app.inject({method:'PATCH',url:`/api/budget-periods/${f.ids.period}/items/${f.ids.item}`,
    cookies,headers:headers(),payload:{periodId:f.ids.period,itemId:f.ids.item,
      expectedPeriodVersion:basis.period,kind:'planned_spend',title:'朋友聚餐（已调整）',
      categoryCode:'food',plannedOn:f.today,userEstimatedAmountMinor:8500,priority:'adjustable',changeReason:'调整预算金额'}});
  assert.equal(changed.statusCode,200,changed.body);
  assert.equal((await pool.query('SELECT status FROM purchase_intents WHERE id=$1',[expiredIntentId])).rows[0].status,'expired');
  const second=await f.createIntent();
  const stranger=randomUUID();await pool.query(`INSERT INTO users(id,email,display_name,role,password_hash)
    VALUES($1,$2,'其他消费者','consumer','disabled')`,[stranger,`${stranger}@test.local`]);
  const strangerSession=await createSession(stranger);
  const forbidden=await app.inject({method:'POST',url:`/api/purchase-intents/${second.intent.purchaseIntentId}/rejections`,
    cookies:{xingzhi_session:strangerSession.token},headers:headers(),payload:{expectedStatus:'proposed'}});
  assert.equal(forbidden.statusCode,404);
  const rejected=await app.inject({method:'POST',url:`/api/purchase-intents/${second.intent.purchaseIntentId}/rejections`,
    cookies,headers:headers(),payload:{expectedStatus:'proposed'}});
  assert.equal(rejected.statusCode,200,rejected.body);assert.equal(rejected.json().data.status,'rejected');
  const cancelled=await app.inject({method:'POST',url:`/api/budget-periods/${f.ids.period}/items/${f.ids.item}/cancellations`,
    cookies,headers:headers(),payload:{periodId:f.ids.period,itemId:f.ids.item,
      expectedPeriodVersion:second.basis.period,reason:'本轮不再购买'}});
  assert.equal(cancelled.statusCode,200,cancelled.body);assert.equal(cancelled.json().data.item.status,'cancelled');

  const race=await m1ClosureFixture();const raceSession=await createSession(race.ids.user);
  const proposal=await race.createIntent();const raceCookies={xingzhi_session:raceSession.token};
  const [confirm,reject]=await Promise.all([
    app.inject({method:'POST',url:`/api/purchase-intents/${proposal.intent.purchaseIntentId}/confirm`,cookies:raceCookies,
      headers:headers(),payload:{acceptedAmountMinor:9900,expectedFinancialVersion:proposal.basis.financial,
        expectedPeriodVersion:proposal.basis.period,expectedQuoteVersion:1,confirmedByUser:true}}),
    app.inject({method:'POST',url:`/api/purchase-intents/${proposal.intent.purchaseIntentId}/rejections`,cookies:raceCookies,
      headers:headers(),payload:{expectedStatus:'proposed'}}),
  ]);
  const raceStatuses=[confirm.statusCode,reject.statusCode];
  assert.equal(raceStatuses.filter(status=>status===200||status===201).length,1);
  assert.equal(raceStatuses.filter(status=>status===409).length,1);
  const final=(await pool.query('SELECT status FROM purchase_intents WHERE id=$1',[proposal.intent.purchaseIntentId])).rows[0].status;
  assert.ok(['ordered','rejected'].includes(final));
});

test('M1 收口 2：撤回账户不阻断原订单关单退款，申请、渠道完成与到账事实严格分离',async()=>{
  const close=await m1ClosureFixture();const closeOrder=await close.createOrder();
  await pool.query("UPDATE finance_accounts SET status='revoked',revoked_at=now() WHERE id=$1",[close.ids.account]);
  const closeSession=await createSession(close.ids.user);const closeCookies={xingzhi_session:closeSession.token};
  const closePreview=await app.inject({method:'POST',url:`/api/orders/${closeOrder.orderId}/aftercare-previews`,
    cookies:closeCookies,headers:{origin:config.webOrigin,'idempotency-key':randomUUID()},payload:{action:'close'}});
  assert.equal(closePreview.statusCode,201,closePreview.body);
  const closeData=closePreview.json().data;
  const closeConfirm=await app.inject({method:'POST',url:`/api/orders/${closeOrder.orderId}/aftercare-confirmations`,
    cookies:closeCookies,headers:{origin:config.webOrigin,'idempotency-key':randomUUID()},payload:{
      previewId:closeData.previewId,acceptedFeeMinor:0,acceptedRefundMinor:0,confirmedByUser:true}});
  assert.equal(closeConfirm.statusCode,202,closeConfirm.body);
  await pool.query("UPDATE jobs SET next_run_at=now()+interval '1 day' WHERE state='pending' AND operation_id<>$1",
    [closeConfirm.json().data.operationId]);
  const closeJob=await claimNextJob();assert.ok(closeJob);
  assert.equal(closeJob.operation_id,closeConfirm.json().data.operationId);await processClaimedJob(closeJob);
  assert.equal((await pool.query('SELECT payment_status FROM orders WHERE id=$1',[closeOrder.orderId])).rows[0].payment_status,'closed');

  const refund=await m1ClosureFixture();const paid=await refund.createOrder();
  await pool.query("UPDATE orders SET payment_status='paid',status='fulfilling',reserved_minor=0 WHERE id=$1",[paid.orderId]);
  await pool.query("UPDATE finance_accounts SET status='revoked',revoked_at=now() WHERE id=$1",[refund.ids.account]);
  const refundSession=await createSession(refund.ids.user);const refundCookies={xingzhi_session:refundSession.token};
  const preview=await app.inject({method:'POST',url:`/api/orders/${paid.orderId}/aftercare-previews`,cookies:refundCookies,
    headers:{origin:config.webOrigin,'idempotency-key':randomUUID()},payload:{action:'cancel'}});
  assert.equal(preview.statusCode,201,preview.body);const previewData=preview.json().data;
  const confirmed=await app.inject({method:'POST',url:`/api/orders/${paid.orderId}/aftercare-confirmations`,cookies:refundCookies,
    headers:{origin:config.webOrigin,'idempotency-key':randomUUID()},payload:{previewId:previewData.previewId,
      acceptedFeeMinor:previewData.feeMinor,acceptedRefundMinor:previewData.expectedRefundMinor,confirmedByUser:true}});
  assert.equal(confirmed.statusCode,202,confirmed.body);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM finance_money_events
    WHERE order_id=$1 AND event_type='refund_requested'`,[paid.orderId])).rows[0].n,1);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM finance_ledger_entries
    WHERE order_id=$1 AND category='refund'`,[paid.orderId])).rows[0].n,0);
  await pool.query("UPDATE jobs SET next_run_at=now()+interval '1 day' WHERE state='pending' AND operation_id<>$1",
    [confirmed.json().data.operationId]);
  const refundJob=await claimNextJob();assert.ok(refundJob);await processClaimedJob(refundJob);
  assert.equal((await pool.query('SELECT refunded_minor FROM orders WHERE id=$1',[paid.orderId])).rows[0].refunded_minor,9900);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM finance_ledger_entries
    WHERE order_id=$1 AND category='refund' AND status='posted'`,[paid.orderId])).rows[0].n,1);
});

test('M1 收口 4：展示分类纠正不改原流水、资金版本或预算评估依据',async()=>{
  const f=await m1ClosureFixture();const entry=randomUUID();
  await pool.query(`INSERT INTO finance_ledger_entries
    (id,owner_id,account_id,source,source_ref,direction,amount_minor,occurred_at,posted_at,status,category,dedupe_key)
    VALUES($1,$2,$3,'demo',$4,'outflow',9900,now(),now(),'posted','other',$4)`,
  [entry,f.ids.user,f.ids.account,`M1-${entry}`]);
  const before=await f.versions();const session=await createSession(f.ids.user);const key=randomUUID();
  const changed=await app.inject({method:'PATCH',url:`/api/finance/ledger/${entry}/category`,
    cookies:{xingzhi_session:session.token},headers:{origin:config.webOrigin,'idempotency-key':key},payload:{category:'food'}});
  assert.equal(changed.statusCode,200,changed.body);
  const replay=await app.inject({method:'PATCH',url:`/api/finance/ledger/${entry}/category`,
    cookies:{xingzhi_session:session.token},headers:{origin:config.webOrigin,'idempotency-key':key},payload:{category:'food'}});
  assert.deepEqual(replay.json(),changed.json());assert.deepEqual(await f.versions(),before);
  const raw=(await pool.query('SELECT category FROM finance_ledger_entries WHERE id=$1',[entry])).rows[0];
  assert.equal(raw.category,'other');
  const accounts=await app.inject({method:'GET',url:'/api/finance/accounts',cookies:{xingzhi_session:session.token}});
  const shown=accounts.json().data.accounts[0].ledger.find((row:{entryId:string})=>row.entryId===entry);
  assert.equal(shown.originalCategory,'other');assert.equal(shown.displayCategory,'food');
});

test('M1 收口 5：隔离场景可重复且不覆盖状态，账单内分期不重复计算，跨日期拒绝',async()=>{
  const {seedConsumerDemoScenario}=await import('../db/consumer-demo-scenario.js');
  const now=new Date();const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const key=`test-${randomUUID().replaceAll('-','')}`;
  const first=await transaction(client=>seedConsumerDemoScenario(client,{scenarioKey:key,serviceOn:today,password:'test-password',now}));
  assert.equal(first.reused,false);assert.equal(first.confirmedCashMinor,200000);
  assert.equal(first.savingsTargetMinor,50000);assert.equal(first.essentialAndRepaymentMinor,90000);
  assert.equal(first.adjustablePlannedMinor,40000);
  const facts=await import('./finance-facts.js').then(({loadFinanceAccountFacts})=>loadFinanceAccountFacts(pool,first.ownerId,first.accountId,now));
  assert.equal(facts.obligations.remainingDueMinor,10000);
  const login=await app.inject({method:'POST',url:'/api/sessions',headers:{origin:config.webOrigin},
    payload:{email:`m1-${key}@xingzhi.local`,password:'test-password'}});
  assert.equal(login.statusCode,200,login.body);assert.match(String(login.headers['set-cookie']),/xingzhi_session=/);
  const authenticated=await app.inject({method:'GET',url:'/api/finance/accounts',
    headers:{cookie:String(login.headers['set-cookie']).split(';')[0]}});
  assert.equal(authenticated.statusCode,200);assert.equal(authenticated.json().data.accounts[0].account.accountId,first.accountId);
  const miniappLogin=await app.inject({method:'POST',url:'/api/miniapp/sessions',
    payload:{email:`m1-${key}@xingzhi.local`,password:'test-password'}});
  assert.equal(miniappLogin.statusCode,200,miniappLogin.body);
  assert.equal(miniappLogin.headers['cache-control'],'no-store');
  const miniappSession=miniappLogin.json().data;
  assert.equal(miniappSession.user.id,first.ownerId);assert.match(miniappSession.token,/^[A-Za-z0-9_-]{43}$/);
  assert.ok(Date.parse(miniappSession.expiresAt)>Date.now());
  const bearerAuthenticated=await app.inject({method:'GET',url:'/api/finance/accounts',
    headers:{authorization:`Bearer ${miniappSession.token}`}});
  assert.equal(bearerAuthenticated.statusCode,200,bearerAuthenticated.body);
  const miniappLogout=await app.inject({method:'DELETE',url:'/api/session',
    headers:{authorization:`Bearer ${miniappSession.token}`}});
  assert.equal(miniappLogout.statusCode,204,miniappLogout.body);
  const revoked=await app.inject({method:'GET',url:'/api/session',
    headers:{authorization:`Bearer ${miniappSession.token}`}});
  assert.equal(revoked.statusCode,401,revoked.body);
  await pool.query('UPDATE budget_periods SET savings_target_minor=60000 WHERE id=$1',[first.periodId]);
  const second=await transaction(client=>seedConsumerDemoScenario(client,{scenarioKey:key,serviceOn:today,password:'different-password',now}));
  assert.equal(second.reused,true);assert.equal(second.periodId,first.periodId);
  assert.equal(Number((await pool.query('SELECT savings_target_minor FROM budget_periods WHERE id=$1',[first.periodId])).rows[0].savings_target_minor),60000);
  const yesterday=new Date(now.getTime()-86_400_000).toISOString().slice(0,10);
  await assert.rejects(transaction(client=>seedConsumerDemoScenario(client,{scenarioKey:key,serviceOn:yesterday,password:'x',now})),/当前上海日期/);
});

test('M1 收口 3：最终文案失败后草稿产物仍可恢复，运行列表可按无周期稳定读取',async()=>{
  const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai');
  const {startConsumerAgentRun,executeConsumerAgentRun,readConsumerAgentRun,listConsumerAgentRuns}=await import('./consumer-agent-runtime.js');
  const userId=randomUUID();await pool.query(`INSERT INTO users(id,email,display_name,role,password_hash)
    VALUES($1,$2,'M1 Agent','consumer','disabled')`,[userId,`${userId}@test.local`]);
  const user={id:userId,email:'',displayName:'',role:'consumer' as const};await resetModelLedger();
  try {
    const run=await startConsumerAgentRun(user,randomUUID(),{message:'记录聚餐需求',periodId:null});let calls=0;
    await executeConsumerAgentRun(run.runId,user,'记录聚餐需求',null,new AbortController().signal,(model)=>{
      calls++;const stream=createAssistantMessageEventStream();const tool=calls===1;
      stream.push({type:'done',reason:tool?'toolUse':'stop',message:{role:'assistant',api:model.api,
        provider:model.provider,model:model.id,timestamp:Date.now(),stopReason:tool?'toolUse':'error',
        content:tool?[{type:'toolCall',id:'draft-before-failure',name:'save_planning_draft',arguments:{items:[{
          title:'朋友聚餐',plannedOn:null,userEstimatedAmountMinor:null,priority:null,
          requirements:['与朋友吃饭'],catalogItemId:null,suggestion:null}]}}]:[],
        usage:{input:10,cacheRead:0,cacheWrite:0,output:5,totalTokens:15,
          cost:{input:0,cacheRead:0,cacheWrite:0,output:0,total:0}}}});return stream;
    });
    const restored=await readConsumerAgentRun(user,run.runId);
    assert.equal(restored.state,'FAILED');assert.equal(restored.artifacts.length,1);
    const listed=await listConsumerAgentRuns(user,{periodId:null});
    assert.equal(listed.items[0]!.id,run.runId);assert.equal(listed.nextCursor,null);
  } finally {await resetModelLedger();}
});

test('M1 收口 1 补充：惰性过期释放重新评估入口，放弃重放返回现状',async()=>{
  const f=await m1ClosureFixture();const session=await createSession(f.ids.user);
  const cookies={xingzhi_session:session.token};const headers=()=>({origin:config.webOrigin,'idempotency-key':randomUUID()});
  const basis=await f.versions();

  // 1) 直接构造过期 proposed 意图后重新发起购买评估：readPurchaseItem 的惰性清理
  //    应先把旧意图转为 expired，评估成功而不是 ITEM_NOT_ORDERABLE。
  const assessmentId=randomUUID();const expiredIntentId=randomUUID();
  await pool.query(`INSERT INTO funding_assessments
      (id,owner_id,period_id,account_id,budget_item_id,quote_id,financial_version,period_version,
        quote_version,replaced_estimate_minor,quoted_amount_minor,incremental_impact_minor,status,
        basis_snapshot_id,expires_at,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,8000,9900,1900,'allowed',$9,
      now()-interval '5 minutes',now()-interval '10 minutes')`,
  [assessmentId,f.ids.user,f.ids.period,f.ids.account,f.ids.item,f.ids.quote,
    basis.financial,basis.period,f.ids.snapshot]);
  await pool.query(`INSERT INTO purchase_intents
      (id,owner_id,period_id,budget_item_id,quote_id,assessment_id,financial_version,period_version,
        quote_version,expires_at,idempotency_key,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,now()-interval '5 minutes',$9,now()-interval '10 minutes')`,
  [expiredIntentId,f.ids.user,f.ids.period,f.ids.item,f.ids.quote,assessmentId,
    basis.financial,basis.period,randomUUID()]);
  const {assessPurchasePreview}=await import('./purchase-assessment.js');
  const reassessment=await transaction(client=>assessPurchasePreview(client,f.ids.user,{
    periodId:f.ids.period,budgetItemId:f.ids.item,quoteId:f.ids.quote,
    expectedFinancialVersion:basis.financial,expectedPeriodVersion:basis.period,
    expectedQuoteVersion:1,mode:'preview'}));
  assert.equal(reassessment.status,'allowed');
  assert.equal((await pool.query('SELECT status FROM purchase_intents WHERE id=$1',[expiredIntentId])).rows[0].status,'expired');

  // 2) 同键幂等重放：同一 Idempotency-Key 再次放弃返回原响应，不冲突。
  const {createPurchaseIntent}=await import('./purchase-intents.js');
  const rejectionKey=randomUUID();
  const intent=await transaction(client=>createPurchaseIntent(client,f.ids.user,rejectionKey,{
    periodId:f.ids.period,budgetItemId:f.ids.item,quoteId:f.ids.quote,
    assessmentId:reassessment.assessmentId,
    expectedFinancialVersion:basis.financial,expectedPeriodVersion:basis.period,
    expectedQuoteVersion:1}));
  const firstReject=await app.inject({method:'POST',
    url:`/api/purchase-intents/${intent.purchaseIntentId}/rejections`,
    cookies,headers:{origin:config.webOrigin,'idempotency-key':rejectionKey},
    payload:{expectedStatus:'proposed'}});
  assert.equal(firstReject.statusCode,200,firstReject.body);
  assert.equal(firstReject.json().data.status,'rejected');
  const replay=await app.inject({method:'POST',
    url:`/api/purchase-intents/${intent.purchaseIntentId}/rejections`,
    cookies,headers:{origin:config.webOrigin,'idempotency-key':rejectionKey},
    payload:{expectedStatus:'proposed'}});
  assert.equal(replay.statusCode,200,replay.body);
  assert.deepEqual(replay.json(),firstReject.json());

  // 3) 已终结意图上用新键再次放弃：返回现状 rejected，不改写状态。
  const secondReject=await app.inject({method:'POST',
    url:`/api/purchase-intents/${intent.purchaseIntentId}/rejections`,
    cookies,headers:headers(),payload:{expectedStatus:'proposed'}});
  assert.equal(secondReject.statusCode,200,secondReject.body);
  assert.equal(secondReject.json().data.status,'rejected');
  assert.equal((await pool.query('SELECT status FROM purchase_intents WHERE id=$1',[intent.purchaseIntentId])).rows[0].status,'rejected');
});
