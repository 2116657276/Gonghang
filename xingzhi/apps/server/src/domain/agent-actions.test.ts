import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { config } from '../config.js';

const connection = new URL(config.databaseUrl);
assert.ok(['localhost', '127.0.0.1'].includes(connection.hostname));
assert.equal(connection.pathname, '/xingzhi_dev');
const admin = new Pool({ connectionString: connection.toString() });
const schema = `xz_test_${randomUUID().replaceAll('-', '')}`;
connection.searchParams.set('options', `-c search_path=${schema}`);
config.databaseUrl = connection.toString();
config.paymentMode = 'simulation';
const { pool, transaction, closePool } = await import('../db/client.js');
const { buildApp } = await import('../app.js');
const { createSession } = await import('../auth/session.js');
const { createPurchaseProposal } = await import('./proposals.js');
const { createConfirmedOrder } = await import('./business-actions.js');
const { executeAgentAction, requestedPauseScope } = await import('./agent-actions.js');
const { startAgentRun } = await import('./agent-runs.js');
const { cancelAgentRun } = await import('./agent-runs.js');
const { createAgentProposal } = await import('./agent-proposals.js');
const { claimAgentWakeup } = await import('./agent-recovery.js');
const { executeAgentRun } = await import('./agent-runtime.js');
const { readAgentRun } = await import('./agent-runs.js');
const { claimNextJob, processClaimedJob } = await import('./worker-runtime.js');
const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai');
const { appendEvent } = await import('./events.js');
const { watchAgentOrder } = await import('./agent-events.js');
const { readOnlyAgentTools } = await import('./agent-tools.js');

type User = { id: string; email: string; displayName: string; role: 'consumer' | 'merchant_admin' };

before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  const dir = new URL('../db/migrations/', import.meta.url);
  for (const name of (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(name, dir), 'utf8'));
  }
});

after(async () => {
  await closePool();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

async function fixture(itemCount = 1) {
  const user: User = { id: randomUUID(), email: `${randomUUID()}@test.local`, displayName: '测试消费者', role: 'consumer' };
  const other: User = { id: randomUUID(), email: `${randomUUID()}@test.local`, displayName: '其他消费者', role: 'consumer' };
  const merchant: User = { id: randomUUID(), email: `${randomUUID()}@test.local`, displayName: '测试商户', role: 'merchant_admin' };
  const planId = randomUUID();
  const items = Array.from({ length: itemCount }, () => ({ id: randomUUID(), catalogId: randomUUID(), name: '' }));
  items.forEach((item, index) => { item.name = `住宿${String.fromCharCode(65 + index)}`; });
  await transaction(async (client) => {
    await client.query('INSERT INTO users (id,email,display_name,role,password_hash) VALUES ($1,$2,$3,$4,\'disabled\'),($5,$6,$7,$8,\'disabled\'),($9,$10,$11,$12,\'disabled\')',
      [user.id, user.email, user.displayName, user.role, other.id, other.email, other.displayName, other.role, merchant.id, merchant.email, merchant.displayName, merchant.role]);
    await client.query('INSERT INTO plans (id,owner_id,purpose,purchase_limit_minor) VALUES ($1,$2,\'自动验收\',300000)', [planId, user.id]);
    for (const [index, item] of items.entries()) {
      await client.query(`INSERT INTO catalog_items (id,merchant_id,code,name,kind,description,price_minor,rule_label,simulation_mode)
        VALUES ($1,$2,$3,$4,'stay','测试目录',$5,'全额退款','SUCCESS')`, [item.catalogId, merchant.id, `${randomUUID()}_STAY_${index}`, item.name, 88000]);
      await client.query(`INSERT INTO plan_items (id,plan_id,catalog_item_id,merchant_id,name,kind,price_minor,position)
        VALUES ($1,$2,$3,$4,$5,'stay',88000,$6)`, [item.id, planId, item.catalogId, merchant.id, item.name, index + 1]);
    }
  });
  return { user, other, merchant, planId, items };
}

async function confirm(app: Awaited<ReturnType<typeof buildApp>>, user: User, proposalId: string, expectedVersion: number, itemIds: string[]) {
  const session = await createSession(user.id);
  const response = await app.inject({ method: 'POST', url: `/api/purchase-proposals/${proposalId}/confirm`,
    cookies: { xingzhi_session: session.token }, headers: { origin: config.webOrigin, 'idempotency-key': randomUUID() },
    payload: { expectedVersion, acceptedItemIds: itemIds, purchaseLimitMinor: 300000, restoreItemIds: [] } });
  assert.equal(response.statusCode, 201);
  return response.json() as { confirmationId: string };
}

async function watchedFixture(paymentStatus: 'pending' | 'paid', orderStatus: 'created' | 'cancelled' = 'created', withOperation = false) {
  const f = await fixture();
  const proposalId = randomUUID();
  const confirmationId = randomUUID();
  const authorizationId = randomUUID();
  const orderId = randomUUID();
  await pool.query("INSERT INTO proposals (id,plan_id,owner_id,type,plan_version,snapshot,status,expires_at) VALUES ($1,$2,$3,'purchase',1,'{}','confirmed',now()+interval '1 day')", [proposalId, f.planId, f.user.id]);
  await pool.query("INSERT INTO confirmations (id,plan_id,owner_id,proposal_id,type,snapshot) VALUES ($1,$2,$3,$4,'purchase','{}')", [confirmationId, f.planId, f.user.id, proposalId]);
  await pool.query("INSERT INTO authorizations (id,plan_id,owner_id,confirmation_id,type,scope,purchase_limit_minor,expires_at) VALUES ($1,$2,$3,$4,'purchase',$5,300000,now()+interval '1 day')", [authorizationId, f.planId, f.user.id, confirmationId, { itemIds: [f.items[0]!.id] }]);
  const run = await startAgentRun(f.user, f.planId, randomUUID(), '观察订单');
  await pool.query("UPDATE agent_runs SET state='WAITING_EXTERNAL' WHERE id=$1", [run.runId]);
  await pool.query(`INSERT INTO orders (id,plan_id,plan_item_id,owner_id,merchant_id,confirmation_id,purchase_authorization_id,item_name,amount_minor,environment,status,payment_status,simulation_mode,reserved_minor)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'住宿A',88000,'simulation',$8,$9,'SUCCESS',$10)`, [orderId, f.planId, f.items[0]!.id, f.user.id, f.merchant.id, confirmationId, authorizationId, orderStatus, paymentStatus, paymentStatus === 'pending' ? 88000 : 0]);
  let operationId: string | undefined;
  if (withOperation) {
    operationId = randomUUID();
    await pool.query("INSERT INTO operations (id,plan_id,owner_id,type,entity_id,purpose) VALUES ($1,$2,$3,'simulate_payment',$4,'测试复核')", [operationId, f.planId, f.user.id, orderId]);
  }
  return { ...f, runId: run.runId, orderId, operationId };
}

test('购买动作只接受当前目录报价；旧确认拒绝，新预览确认后可建单且越权用户不能执行', async () => {
  const app = await buildApp();
  try {
    await pool.query('DELETE FROM agent_wakeups');
    const f = await fixture();
    const proposal = await transaction((client) => createPurchaseProposal(client, f.user, f.planId, { itemIds: [f.items[0]!.id] }));
    const oldConfirmation = await confirm(app, f.user, proposal.proposalId, 1, [f.items[0]!.id]);
    await pool.query('UPDATE catalog_items SET price_minor=99000,rule_version=rule_version+1 WHERE id=$1', [f.items[0]!.catalogId]);
    await assert.rejects(transaction((client) => createConfirmedOrder(client, f.user, { confirmationId: oldConfirmation.confirmationId, planItemId: f.items[0]!.id })), /确认后的报价或规则已变化/);
    await assert.rejects(transaction((client) => createConfirmedOrder(client, f.other, { confirmationId: oldConfirmation.confirmationId, planItemId: f.items[0]!.id })), /未找到/);
    const fresh = await transaction((client) => createPurchaseProposal(client, f.user, f.planId, { itemIds: [f.items[0]!.id] }));
    const confirmation = await confirm(app, f.user, fresh.proposalId, 2, [f.items[0]!.id]);
    const order = await transaction((client) => createConfirmedOrder(client, f.user, { confirmationId: confirmation.confirmationId, planItemId: f.items[0]!.id }));
    assert.equal(order.status, 'accepted');
  } finally { await app.close(); }
});

test('同一运行的重复暂停只推进一次版本，局部暂停 A 不阻断已授权 B 建单', async () => {
  const f = await fixture(2);
  const run = await startAgentRun(f.user, f.planId, randomUUID(), '请暂停住宿A购买');
  const proposalId = randomUUID();
  const confirmationId = randomUUID();
  await pool.query(`INSERT INTO proposals (id,plan_id,owner_id,type,plan_version,snapshot,status,expires_at) VALUES ($1,$2,$3,'purchase',1,$4,'confirmed',now()+interval '1 day')`,
    [proposalId, f.planId, f.user.id, { items: [] }]);
  await pool.query(`INSERT INTO confirmations (id,plan_id,owner_id,proposal_id,type,snapshot) VALUES ($1,$2,$3,$4,'purchase',$5)`,
    [confirmationId, f.planId, f.user.id, proposalId, { proposal: { items: f.items.map((item) => ({ planItemId: item.id, catalogItemId: item.catalogId, priceMinor: 88000, ruleVersion: 1 })) } }]);
  await pool.query(`INSERT INTO authorizations (id,plan_id,owner_id,confirmation_id,type,scope,purchase_limit_minor,expires_at) VALUES ($1,$2,$3,$4,'purchase',$5,300000,now()+interval '1 day')`,
    [randomUUID(), f.planId, f.user.id, confirmationId, { itemIds: f.items.map((item) => item.id) }]);
  await Promise.all([
    executeAgentAction(f.user, f.planId, run.runId, 'pause-a', 'pause_purchases', {}),
    executeAgentAction(f.user, f.planId, run.runId, 'pause-a-duplicate', 'pause_purchases', {}),
  ]);
  const plan = (await pool.query('SELECT version,paused_item_ids FROM plans WHERE id=$1', [f.planId])).rows[0];
  assert.equal(plan.version, 2);
  assert.deepEqual(plan.paused_item_ids, [f.items[0]!.id]);
  const order = await executeAgentAction(f.user, f.planId, run.runId, 'create-b', 'create_order', { confirmationId, planItemId: f.items[1]!.id });
  assert.equal(order.status, 'accepted');
});

test('暂停意图只接受明确的全局或项目范围，拒绝否定、引用和条件句', () => {
  const items = [{ id: 'a', name: '住宿A', code: 'A' }, { id: 'b', name: '住宿B', code: 'B' }];
  assert.deepEqual(requestedPauseScope('请暂停购买', items), ['a', 'b']);
  assert.deepEqual(requestedPauseScope('请暂停住宿A的购买', items), ['a']);
  for (const message of ['不要暂停住宿A购买', '“暂停住宿A购买”', '如果需要就暂停住宿A购买', '暂停住宿A购买，然后继续']) {
    assert.equal(requestedPauseScope(message, items), null, message);
  }
});

test('已完成事实的购买或变更 watch 创建后立即 inactive', async () => {
  const paid = await watchedFixture('paid');
  await transaction((client) => watchAgentOrder(client, paid.runId, paid.orderId, 'purchase'));
  assert.equal((await pool.query('SELECT active FROM agent_order_watches WHERE run_id=$1 AND order_id=$2', [paid.runId, paid.orderId])).rows[0].active, false);
  const cancelled = await watchedFixture('paid', 'cancelled');
  await transaction((client) => watchAgentOrder(client, cancelled.runId, cancelled.orderId, 'change'));
  assert.equal((await pool.query('SELECT active FROM agent_order_watches WHERE run_id=$1 AND order_id=$2', [cancelled.runId, cancelled.orderId])).rows[0].active, false);
});

test('pending watch 只在事实变化后入队，paid 重复事件只入队一次并关闭 watch', async () => {
  const f = await watchedFixture('pending');
  await transaction((client) => watchAgentOrder(client, f.runId, f.orderId, 'purchase'));
  await transaction((client) => appendEvent(client, f.planId, f.user.id, 'simulation.payment_confirmed', { orderId: f.orderId }));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_wakeups WHERE parent_run_id=$1', [f.runId])).rows[0].n, 0);
  await pool.query("UPDATE orders SET payment_status='paid',reserved_minor=0 WHERE id=$1", [f.orderId]);
  await transaction((client) => appendEvent(client, f.planId, f.user.id, 'simulation.payment_confirmed', { orderId: f.orderId }));
  await transaction((client) => appendEvent(client, f.planId, f.user.id, 'simulation.payment_confirmed', { orderId: f.orderId }));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_wakeups WHERE parent_run_id=$1', [f.runId])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT active FROM agent_order_watches WHERE run_id=$1 AND order_id=$2', [f.runId, f.orderId])).rows[0].active, false);
});

test('确认恢复并发只领取一次；过期 child 重试达到第二次，旧运行拒绝写动作', async () => {
  const app = await buildApp();
  try {
    await pool.query('DELETE FROM agent_wakeups');
    const f = await fixture();
    const run = await startAgentRun(f.user, f.planId, randomUUID(), '购买住宿');
    const draft = await createAgentProposal(f.user, f.planId, run.runId, 'draft', 'propose_purchase', { itemIds: [f.items[0]!.id] });
    const confirmed = await confirm(app, f.user, draft.proposalId, 1, [f.items[0]!.id]);
    assert.ok(confirmed.confirmationId);
    const wakeup = (await pool.query<{ id: string }>('SELECT id FROM agent_wakeups WHERE parent_run_id=$1', [run.runId])).rows[0]!;
    const claimed = (await Promise.all([claimAgentWakeup(), claimAgentWakeup()])).filter(Boolean);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]!.planId, f.planId);
    const firstChild = claimed[0]!.runId;
    assert.notEqual(firstChild, run.runId);
    await pool.query("UPDATE agent_runs SET deadline=now()-interval '1 second' WHERE id=$1", [firstChild]);
    await pool.query("UPDATE agent_rate_limits SET tokens=2,updated_at=now() WHERE owner_id=$1", [f.user.id]);
    await pool.query("UPDATE agent_wakeups SET next_run_at=now()-interval '1 second' WHERE id=$1", [wakeup.id]);
    const retry = await claimAgentWakeup();
    assert.ok(retry);
    assert.equal(retry.planId, f.planId);
    assert.notEqual(retry.runId, firstChild);
    assert.equal((await pool.query('SELECT attempts FROM agent_wakeups WHERE id=$1', [wakeup.id])).rows[0].attempts, 2);
    await assert.rejects(executeAgentAction(f.user, f.planId, firstChild, 'old-write', 'create_order', {
      confirmationId: confirmed.confirmationId, planItemId: f.items[0]!.id,
    }), /AGENT_RUN_STOPPED|运行已停止/);
  } finally { await app.close(); }
});

test('取消 parent 会取消已派发 child、清理 pending 队列和 watch，但保留已有订单', async () => {
  const f = await watchedFixture('pending');
  await transaction((client) => watchAgentOrder(client, f.runId, f.orderId, 'purchase'));
  const child = await startAgentRun(f.user, f.planId, randomUUID(), '恢复子运行');
  await pool.query('UPDATE agent_runs SET parent_run_id=$2,state=\'RUNNING\' WHERE id=$1', [child.runId, f.runId]);
  await transaction((client) => appendEvent(client, f.planId, f.user.id, 'test.recovery_marker', {}));
  const eventId = (await pool.query<{ id: number }>('SELECT id FROM events WHERE plan_id=$1 ORDER BY id DESC LIMIT 1', [f.planId])).rows[0]!.id;
  await pool.query("INSERT INTO agent_wakeups (parent_run_id,event_id,event_key,state,run_id) VALUES ($1,$2,$3,'dispatched',$4)", [f.runId, eventId, `dispatch-${randomUUID()}`, child.runId]);
  await pool.query("INSERT INTO agent_wakeups (parent_run_id,event_id,event_key,state) VALUES ($1,$2,$3,'pending')", [f.runId, eventId, `pending-${randomUUID()}`]);
  await cancelAgentRun(f.user, f.runId);
  assert.equal((await pool.query('SELECT state FROM agent_runs WHERE id=$1', [child.runId])).rows[0].state, 'CANCELLED');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM agent_wakeups WHERE parent_run_id=$1 AND state IN ('pending','dispatched')", [f.runId])).rows[0].n, 0);
  assert.equal((await pool.query('SELECT active FROM agent_order_watches WHERE run_id=$1 AND order_id=$2', [f.runId, f.orderId])).rows[0].active, false);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders WHERE id=$1', [f.orderId])).rows[0].n, 1);
});

test('关联业务事实触发的只读恢复拒绝任何写动作', async () => {
  const f = await watchedFixture('pending');
  await transaction((client) => watchAgentOrder(client, f.runId, f.orderId, 'purchase'));
  await pool.query("UPDATE orders SET payment_status='paid',reserved_minor=0 WHERE id=$1", [f.orderId]);
  await transaction((client) => appendEvent(client, f.planId, f.user.id, 'simulation.payment_confirmed', { orderId: f.orderId }));
  const recovery = await claimAgentWakeup();
  assert.ok(recovery);
  await assert.rejects(executeAgentAction(f.user, f.planId, recovery.runId, 'write-on-readonly', 'create_order', {
    confirmationId: randomUUID(), planItemId: f.items[0]!.id,
  }), /EVENT_READ_ONLY|业务结果恢复/);
});

test('确认恢复建单、模拟付款和只读事实恢复全链路不重复', async () => {
  const app = await buildApp();
  try {
    await pool.query('DELETE FROM agent_wakeups');
    await pool.query("UPDATE jobs SET next_run_at=now()+interval '1 day'");
    const f = await fixture();
    const parent = await startAgentRun(f.user, f.planId, randomUUID(), '购买住宿');
    const draft = await createAgentProposal(f.user, f.planId, parent.runId, 'draft', 'propose_purchase', { itemIds: [f.items[0]!.id] });
    const confirmed = await confirm(app, f.user, draft.proposalId, 1, [f.items[0]!.id]);
    const recovery = await claimAgentWakeup();
    assert.ok(recovery);
    let firstCalls = 0;
    await executeAgentRun(recovery.runId, f.planId, f.user, recovery.input, new AbortController().signal, (model) => {
      firstCalls++;
      const stream = createAssistantMessageEventStream();
      const tool = firstCalls === 1;
      stream.push({ type: 'done', reason: tool ? 'toolUse' : 'stop', message: {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: tool ? 'toolUse' : 'stop',
        content: tool ? [{ type: 'toolCall', id: 'create-order', name: 'create_order', arguments: { confirmationId: confirmed.confirmationId, planItemId: f.items[0]!.id } }] : [{ type: 'text', text: '订单已创建，等待模拟付款结果。' }],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } });
      return stream;
    });
    const created = (await pool.query<{ id: string; operation_id: string }>('SELECT orders.id,operations.id AS operation_id FROM orders JOIN operations ON operations.entity_id=orders.id WHERE orders.plan_id=$1', [f.planId])).rows[0];
    assert.ok(created);
    const job = await claimNextJob();
    assert.ok(job);
    assert.equal(job.operation_id, created.operation_id);
    await processClaimedJob(job);
    const factWakeups = (await pool.query<{ id: string; state: string }>('SELECT w.id,w.state FROM agent_wakeups w JOIN agent_runs r ON r.id=w.parent_run_id WHERE r.plan_id=$1 ORDER BY w.id', [f.planId])).rows;
    assert.equal(factWakeups.length, 2);
    const pendingFact = (await pool.query<{ id: string }>("SELECT w.id FROM agent_wakeups w JOIN agent_runs r ON r.id=w.parent_run_id WHERE r.plan_id=$1 AND w.state='pending'", [f.planId])).rows;
    assert.equal(pendingFact.length, 1);
    await pool.query("UPDATE agent_wakeups SET next_run_at=now()-interval '1 second' WHERE id=$1", [pendingFact[0]!.id]);
    await pool.query("UPDATE agent_rate_limits SET tokens=2,updated_at=now() WHERE owner_id=$1", [f.user.id]);
    const readonlyRecovery = await claimAgentWakeup();
    assert.ok(readonlyRecovery);
    let readonlyCalls = 0;
    await executeAgentRun(readonlyRecovery.runId, f.planId, f.user, readonlyRecovery.input, new AbortController().signal, (model, context) => {
      readonlyCalls++;
      if (readonlyCalls === 1) {
        assert.deepEqual(context.tools?.map((tool) => tool.name), ['search_catalog', 'get_plan_orders', 'get_cancellation_quote', 'get_operation_status']);
      }
      const stream = createAssistantMessageEventStream();
      const tool = readonlyCalls === 1;
      stream.push({ type: 'done', reason: tool ? 'toolUse' : 'stop', message: {
        role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: tool ? 'toolUse' : 'stop',
        content: tool ? [{ type: 'toolCall', id: 'read-plan', name: 'get_plan_orders', arguments: {} }] : [{ type: 'text', text: '模拟付款已完成。' }],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } });
      return stream;
    });
    const finalRun = await readAgentRun(f.user, readonlyRecovery.runId);
    assert.equal(finalRun.state, 'COMPLETED');
    assert.equal(finalRun.tool_calls, 1);
    assert.equal((await pool.query('SELECT payment_status FROM orders WHERE id=$1', [created.id])).rows[0].payment_status, 'paid');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM orders WHERE plan_id=$1', [f.planId])).rows[0].n, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM agent_wakeups WHERE parent_run_id=$1 AND event_key LIKE 'confirmation:%'", [parent.runId])).rows[0].n, 1);
  } finally { await app.close(); }
});

// Use the real Pi tool loop with deterministic responses; no external model or payment calls.
function scriptedTools(steps: Array<{ name: string; arguments: Record<string, unknown>; error?: RegExp }>) {
  let call = 0;
  const stream: import('@earendil-works/pi-agent-core').StreamFn = (model, context) => {
    if (call > 0 && call <= steps.length) {
      const result = context.messages.at(-1);
      assert.equal(result?.role, 'toolResult');
      if (result?.role === 'toolResult') {
        const expected = steps[call - 1]!;
        assert.equal(Boolean(result.isError), Boolean(expected.error), JSON.stringify(result.content));
        if (expected.error) assert.match(JSON.stringify(result.content), expected.error);
      }
    }
    const step = steps[call++];
    const response = createAssistantMessageEventStream();
    response.push({ type: 'done', reason: step ? 'toolUse' : 'stop', message: {
      role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: step ? 'toolUse' : 'stop',
      content: step ? [{ type: 'toolCall', id: `step-${call}`, name: step.name, arguments: step.arguments }]
        : [{ type: 'text', text: '已读取本地业务结果；受理不代表渠道交易成功。' }],
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    } });
    return response;
  };
  return { stream, completed: () => assert.equal(call, steps.length + 1) };
}

test('T10 普通消息经 Pi 复核：有效授权合并重复请求，撤回与跨计划拒绝，默认读取不写任务', async () => {
  const f = await watchedFixture('pending', 'created', true);
  const foreign = await watchedFixture('pending', 'created', true);
  const confirmation = (await pool.query('SELECT confirmation_id FROM orders WHERE id=$1', [f.orderId])).rows[0];
  const authorizationId = randomUUID();
  await pool.query(`INSERT INTO authorizations (id,plan_id,owner_id,confirmation_id,type,scope,expires_at)
    VALUES ($1,$2,$3,$4,'query',$5,now()+interval '1 day')`,
    [authorizationId, f.planId, f.user.id, confirmation.confirmation_id, { orderIds: [f.orderId] }]);
  const input = '请重新核验当前订单的交易结果';
  const run = await startAgentRun(f.user, f.planId, randomUUID(), input);
  const script = scriptedTools([
    { name: 'get_plan_orders', arguments: {} },
    { name: 'get_operation_status', arguments: { id: f.operationId!, requestRecheck: true } },
    { name: 'get_operation_status', arguments: { id: f.operationId!, requestRecheck: true } },
    { name: 'get_operation_status', arguments: { id: foreign.operationId!, requestRecheck: true }, error: /未找到/ },
  ]);
  await executeAgentRun(run.runId, f.planId, f.user, input, new AbortController().signal, script.stream);
  script.completed();
  assert.equal((await readAgentRun(f.user, run.runId)).state, 'COMPLETED');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM manual_tasks WHERE operation_id=$1', [f.operationId])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM manual_tasks WHERE operation_id=$1', [foreign.operationId])).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_tool_calls WHERE run_id=$1', [run.runId])).rows[0].n, 2);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_run_operations WHERE run_id=$1', [run.runId])).rows[0].n, 1);

  await pool.query("UPDATE authorizations SET status='revoked' WHERE id=$1", [authorizationId]);
  await pool.query('UPDATE agent_rate_limits SET tokens=2,updated_at=now() WHERE owner_id=$1', [f.user.id]);
  const revokedRun = await startAgentRun(f.user, f.planId, randomUUID(), input);
  const revokedScript = scriptedTools([
    { name: 'get_operation_status', arguments: { id: f.operationId!, requestRecheck: true }, error: /查询授权已撤回或过期/ },
    { name: 'get_operation_status', arguments: { id: f.operationId! } },
  ]);
  await executeAgentRun(revokedRun.runId, f.planId, f.user, input, new AbortController().signal, revokedScript.stream);
  revokedScript.completed();
  assert.equal((await readAgentRun(f.user, revokedRun.runId)).state, 'COMPLETED');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_tool_calls WHERE run_id=$1', [revokedRun.runId])).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM manual_tasks WHERE operation_id=$1', [f.operationId])).rows[0].n, 1);
  assert.equal((await pool.query('SELECT payment_status,reserved_minor FROM orders WHERE id=$1', [f.orderId])).rows[0].reserved_minor, 88000);
});

test('Pi 变更确认至商户善后连续链：A 保留、B 分批退款、C 关单、D 停止，重复提交不重复执行', async () => {
  const app = await buildApp();
  try {
    await pool.query('DELETE FROM agent_wakeups');
    await pool.query("UPDATE jobs SET next_run_at=now()+interval '1 day'");
    const f = await fixture(4);
    const [a, b, c, d] = f.items;
    await pool.query("UPDATE catalog_items SET cancellation_rule='two_batches' WHERE id=$1", [b!.catalogId]);
    await pool.query("UPDATE catalog_items SET simulation_mode='PENDING' WHERE id=$1", [c!.catalogId]);
    const purchase = await transaction(client => createPurchaseProposal(client, f.user, f.planId, { itemIds: [a!.id, b!.id, c!.id] }));
    const confirmedPurchase = await confirm(app, f.user, purchase.proposalId, purchase.version, [a!.id, b!.id, c!.id]);
    const orderIds: string[] = [];
    for (const item of [a!, b!, c!]) {
      const order = await transaction(client => createConfirmedOrder(client, f.user, { confirmationId: confirmedPurchase.confirmationId, planItemId: item.id }));
      orderIds.push(order.orderId);
      const job = await claimNextJob();
      assert.equal(job?.operation_id, order.operationId);
      await processClaimedJob(job!);
    }
    const consumer = await createSession(f.user.id);
    const merchant = await createSession(f.merchant.id);
    const write = (url: string, payload: object, token = consumer.token, key = randomUUID()) => app.inject({
      method: 'POST', url, payload, cookies: { xingzhi_session: token },
      headers: { origin: config.webOrigin, 'idempotency-key': key },
    });
    const input = '保留住宿A，取消住宿B，关闭住宿C的未付订单，停止住宿D';
    const parent = await startAgentRun(f.user, f.planId, randomUUID(), input);
    const draftScript = scriptedTools([{ name: 'propose_change', arguments: { items: [
      { planItemId: a!.id, intent: 'keep' }, { planItemId: b!.id, intent: 'cancel' },
      { planItemId: c!.id, intent: 'close' }, { planItemId: d!.id, intent: 'stop' },
    ] } }]);
    await executeAgentRun(parent.runId, f.planId, f.user, input, new AbortController().signal, draftScript.stream);
    const parentRun = await readAgentRun(f.user, parent.runId);
    assert.equal(parentRun.state, 'WAITING_USER');
    const draft = parentRun.proposal!;
    const confirmation = await write(`/api/change-proposals/${draft.proposalId}/confirm`, {
      expectedVersion: draft.version, acceptedFeeMinor: 8000, acceptedRefundMinor: 80000,
      aftercareOrderIds: [orderIds[1], orderIds[2]], queryOrderIds: [orderIds[1], orderIds[2]],
    });
    assert.equal(confirmation.statusCode, 201, confirmation.body);
    assert.equal(confirmation.json().agentFollowupQueued, true);
    const snapshotTool = readOnlyAgentTools(f.user, f.planId, async () => {}).find(tool => tool.name === 'get_plan_orders')!;
    const toolSnapshot = await snapshotTool.execute('check-display', {});
    const data = JSON.parse((toolSnapshot.content[0] as { text: string }).text).data;
    assert.deepEqual(data.displayAmounts.budget, { limit: '¥3000.00', totalPaid: '¥1760.00', refunded: '¥0.00', netSpent: '¥1760.00', reserved: '¥880.00', remaining: '¥360.00' });
    assert.deepEqual(data.confirmedActions.find((action: { type: string }) => action.type === 'change').submitChangeInput, { id: draft.proposalId });
    const purchasedOrders = data.confirmedActions.find((action: { type: string }) => action.type === 'purchase').linkedOrders;
    assert.deepEqual(purchasedOrders.map((order: { orderId: string }) => order.orderId).sort(), [...orderIds].sort());
    assert.equal(purchasedOrders.filter((order: { paymentStatus: string }) => order.paymentStatus === 'paid').length, 2);
    const recovery = await claimAgentWakeup();
    assert.ok(recovery);
    const executeScript = scriptedTools([
      { name: 'get_plan_orders', arguments: {} },
      { name: 'submit_change', arguments: { id: draft.proposalId } },
      { name: 'submit_change', arguments: { id: draft.proposalId } },
    ]);
    await executeAgentRun(recovery.runId, f.planId, f.user, recovery.input, new AbortController().signal, executeScript.stream);
    executeScript.completed();
    assert.equal((await readAgentRun(f.user, recovery.runId)).state, 'WAITING_EXTERNAL');
    const requests = (await pool.query('SELECT id,status FROM cancellation_requests WHERE order_id=$1', [orderIds[1]])).rows;
    assert.equal(requests.length, 1);
    assert.equal(requests[0].status, 'approved');
    const refundUrl = `/api/merchant/cancellations/${requests[0].id}/refund-batches`;
    assert.equal((await write(refundUrl, {})).statusCode, 403);
    const close = await claimNextJob();
    assert.equal(close?.type, 'simulate_close');
    assert.equal(close?.entity_id, orderIds[2]);
    await processClaimedJob(close!);
    for (let batchNumber = 1; batchNumber <= 2; batchNumber++) {
      const key = randomUUID();
      const scheduled = await write(refundUrl, {}, merchant.token, key);
      assert.equal(scheduled.statusCode, 202, scheduled.body);
      assert.equal(scheduled.json().batch.batchNumber, batchNumber);
      assert.equal(scheduled.json().batch.amountMinor, 40000);
      assert.deepEqual((await write(refundUrl, {}, merchant.token, key)).json(), scheduled.json());
      const job = await claimNextJob();
      assert.equal(job?.operation_id, scheduled.json().batch.operationId);
      await processClaimedJob(job!);
      const snapshot = await app.inject({ method: 'GET', url: `/api/plans/${f.planId}`, cookies: { xingzhi_session: consumer.token } });
      assert.equal(snapshot.statusCode, 200);
      assert.equal(snapshot.json().cancellations[0].refundedMinor, batchNumber * 40000);
      assert.equal(snapshot.json().cancellations[0].batches.length, batchNumber);
      assert.ok(snapshot.json().cancellations[0].batches[batchNumber - 1].operationId);
      if (batchNumber === 1) assert.equal(snapshot.json().cancellations[0].status, 'refund_processing');
    }
    const snapshot = (await app.inject({ method: 'GET', url: `/api/plans/${f.planId}`, cookies: { xingzhi_session: consumer.token } })).json();
    assert.equal(snapshot.orders.find((order: { id: string }) => order.id === orderIds[0]).paymentStatus, 'paid');
    assert.equal(snapshot.orders.find((order: { id: string }) => order.id === orderIds[0]).refundedMinor, 0);
    assert.equal(snapshot.orders.find((order: { id: string }) => order.id === orderIds[1]).status, 'cancelled');
    assert.equal(snapshot.orders.find((order: { id: string }) => order.id === orderIds[2]).paymentStatus, 'closed');
    assert.equal(snapshot.items.find((item: { id: string }) => item.id === d!.id).status, 'stopped');
    assert.equal(snapshot.orders.length, 3);
    assert.equal(snapshot.budget.totalPaidMinor, 176000);
    assert.equal(snapshot.budget.refundedMinor, 80000);
    assert.equal(snapshot.budget.remainingMinor, 124000);
    assert.equal(snapshot.budget.paidMinor, 96000);
    assert.equal(snapshot.budget.reservedMinor, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM agent_order_watches WHERE run_id=$1 AND active', [recovery.runId])).rows[0].n, 0);
    assert.equal((await readAgentRun(f.user, recovery.runId)).state, 'COMPLETED');

    // Finish the confirmation queue item, then consume the queued business facts read-only.
    await pool.query("UPDATE agent_wakeups SET next_run_at=now()-interval '1 second' WHERE run_id=$1", [recovery.runId]);
    await claimAgentWakeup();
    let explained = 0;
    for (let attempt = 0; attempt < 12; attempt++) {
      const pending = await pool.query("SELECT 1 FROM agent_wakeups WHERE state IN ('pending','dispatched')");
      if (!pending.rowCount) break;
      await pool.query("UPDATE agent_wakeups SET next_run_at=now()-interval '1 second' WHERE state IN ('pending','dispatched')");
      await pool.query('UPDATE agent_rate_limits SET tokens=2,updated_at=now() WHERE owner_id=$1', [f.user.id]);
      const fact = await claimAgentWakeup();
      if (!fact) continue;
      const readonlyScript = scriptedTools([
        { name: 'get_plan_orders', arguments: {} },
        { name: 'get_operation_status', arguments: { id: close!.operation_id, requestRecheck: true }, error: /requestRecheck|unexpected|Unexpected|额外/ },
      ]);
      await executeAgentRun(fact.runId, f.planId, f.user, fact.input, new AbortController().signal, readonlyScript.stream);
      readonlyScript.completed();
      assert.equal((await readAgentRun(f.user, fact.runId)).state, 'COMPLETED');
      explained++;
    }
    assert.ok(explained > 0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM agent_wakeups WHERE state IN ('pending','dispatched')")).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM manual_tasks WHERE plan_id=$1', [f.planId])).rows[0].n, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM refund_batches WHERE cancellation_request_id=$1', [requests[0].id])).rows[0].n, 2);
    const refundOperationId = snapshot.cancellations[0].batches[1].operationId;
    const rechecked = await write(`/api/operations/${refundOperationId}/rechecks`, { reason: '消费者请求复核第二笔退款' });
    assert.equal(rechecked.statusCode, 202, rechecked.body);
    const refreshed = (await app.inject({ method: 'GET', url: `/api/plans/${f.planId}`, cookies: { xingzhi_session: consumer.token } })).json();
    assert.equal(refreshed.cancellations[0].manualTasks[0].id, rechecked.json().manualTaskId);
    assert.equal(refreshed.cancellations[0].manualTasks[0].state, 'open');
    assert.equal(refreshed.cancellations[0].refundedMinor, 80000);

  } finally { await app.close(); }
});

test('退款不回补购买空间，重新确认不能降低历史累计或绕过建单上限', async () => {
  const app = await buildApp();
  try {
    const f = await fixture(3);
    const first = await transaction(client => createPurchaseProposal(client, f.user, f.planId, { itemIds: [f.items[0]!.id, f.items[1]!.id] }));
    const accepted = await confirm(app, f.user, first.proposalId, first.version, [f.items[0]!.id, f.items[1]!.id]);
    for (const item of f.items.slice(0, 2)) await transaction(client => createConfirmedOrder(client, f.user, {
      confirmationId: accepted.confirmationId, planItemId: item.id,
    }));
    // Isolate the post-refund budget rule; refund execution is covered by the continuous chain above.
    await pool.query("UPDATE orders SET payment_status='paid',status='cancelled',refunded_minor=amount_minor,reserved_minor=0 WHERE plan_id=$1", [f.planId]);
    const next = await transaction(client => createPurchaseProposal(client, f.user, f.planId, { itemIds: [f.items[2]!.id] }));
    const session = await createSession(f.user.id);
    const confirmWithLimit = (purchaseLimitMinor: number) => app.inject({ method: 'POST', url: `/api/purchase-proposals/${next.proposalId}/confirm`,
      cookies: { xingzhi_session: session.token }, headers: { origin: config.webOrigin, 'idempotency-key': randomUUID() },
      payload: { expectedVersion: next.version, acceptedItemIds: [f.items[2]!.id], purchaseLimitMinor, restoreItemIds: [] } });
    const belowHistory = await confirmWithLimit(100000);
    assert.equal(belowHistory.statusCode, 422);
    assert.match(belowHistory.body, /LIMIT_BELOW_HISTORY/);
    const renewed = await confirmWithLimit(200000);
    assert.equal(renewed.statusCode, 201, renewed.body);
    await assert.rejects(transaction(client => createConfirmedOrder(client, f.user, {
      confirmationId: renewed.json().confirmationId, planItemId: f.items[2]!.id,
    })), /剩余额度不足/);
    const snapshot = (await app.inject({ method: 'GET', url: `/api/plans/${f.planId}`, cookies: { xingzhi_session: session.token } })).json();
    assert.deepEqual(snapshot.budget, { limitMinor: 200000, totalPaidMinor: 176000, refundedMinor: 176000,
      paidMinor: 0, reservedMinor: 0, remainingMinor: 24000 });
    assert.equal(snapshot.orders.length, 2);
  } finally { await app.close(); }
});
