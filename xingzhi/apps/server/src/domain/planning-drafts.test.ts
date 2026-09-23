import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import type { PoolClient } from 'pg';
import { config } from '../config.js';
import { pool, closePool } from '../db/client.js';
import { seedConsumerCatalog } from '../db/consumer-catalog.js';
import { consumerPlanningAgentTools, consumerPlanningToolNames } from './consumer-planning-tools.js';
import { constrainAgentDraftToMessage } from './consumer-agent-runtime.js';
import type { PlanningDraftPort } from './planning-draft-port.js';
import { registerPlanningDraftApi } from '../routes/planning-drafts.js';

test('B02 planning drafts keep demand, budget and Agent execution boundaries separate', async () => {
  const client = await pool.connect();
  const app = Fastify();
  const unavailableApp = Fastify();
  try {
    await client.query('BEGIN');
    const consumers = (await client.query<{ id: string }>(
      "SELECT id FROM users WHERE role='consumer' ORDER BY created_at LIMIT 2",
    )).rows;
    assert.equal(consumers.length, 2);
    const ownerId = consumers[0]!.id;
    const otherId = consumers[1]!.id;
    const day = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const monthStart = `${day.slice(0, 7)}-01`;
    const monthEnd = new Date(`${day.slice(0, 7)}-01T00:00:00Z`);
    monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
    monthEnd.setUTCDate(0);
    const monthEndText = monthEnd.toISOString().slice(0, 10);
    await seedConsumerCatalog(client, day);
    const dinner = (await client.query<{ id: string }>(
      "SELECT id FROM catalog_items WHERE code='CONSUMER-DINNER-99'",
    )).rows[0];
    assert.ok(dinner);

    const accountId = randomUUID();
    const snapshotId = randomUUID();
    const periodId = randomUUID();
    await client.query(`INSERT INTO finance_accounts
      (id,owner_id,provider,account_type,provider_account_ref,masked_identifier,display_name,source,authorized_at)
      VALUES($1,$2,'demo','debit',$3,'****B02','B02 测试账户','demo',now())`,
    [accountId, ownerId, `b02-${accountId}`]);
    await client.query(`INSERT INTO finance_account_snapshots
      (id,account_id,available_balance_minor,current_balance_minor,as_of,covered_through_at,fact_status,source,provider_snapshot_ref)
      VALUES($1,$2,200000,200000,now(),now(),'observed','demo',$3)`,
    [snapshotId, accountId, `b02-${snapshotId}`]);
    await client.query(`INSERT INTO budget_periods
      (id,owner_id,primary_account_id,baseline_snapshot_id,month_start,month_end,savings_target_minor,status)
      VALUES($1,$2,$3,$4,$5,$6,50000,'active')`,
    [periodId, ownerId, accountId, snapshotId, monthStart, monthEndText]);

    let assessments = 0;
    const port: PlanningDraftPort = {
      async assessPlanningDraft(receivedClient, receivedOwner, receivedPeriod, financialVersion, periodVersion, items) {
        assert.equal(receivedClient, client);
        assert.equal(receivedOwner, ownerId);
        assert.equal(receivedPeriod, periodId);
        assert.equal(financialVersion, 1);
        assert.equal(periodVersion, 1);
        assert.equal(items[0]?.title, '朋友聚餐');
        assessments += 1;
        return { status: 'allowed', shortfallMinor: 0, affectedDates: [], reasonCodes: ['WITHIN_BUDGET'] };
      },
    };
    app.addHook('preHandler', async (request) => {
      const role = request.headers['x-test-role'];
      if (!role) return;
      request.authUser = {
        id: request.headers['x-test-user'] === 'other' ? otherId : ownerId,
        email: '', displayName: '', role: role as 'consumer' | 'reviewer',
      };
      if (request.headers['x-test-transport'] === 'bearer') request.sessionTransport = 'bearer';
    });
    const runInCurrentTransaction = async <T>(run: (transactionClient: PoolClient) => Promise<T>) => run(client);
    await app.register(registerPlanningDraftApi, {
      planningDraftPort: port,
      transaction: runInCurrentTransaction,
      db: client,
    });
    const headers = { origin: config.webOrigin, 'idempotency-key': 'b02-demand-0001', 'x-test-role': 'consumer' };
    const demand = {
      periodId: null,
      expectedFinancialVersion: null,
      expectedPeriodVersion: null,
      items: [{
        title: '朋友聚餐', plannedOn: null, userEstimatedAmountMinor: null,
        priority: null, requirements: ['晚饭必须保留'], catalogItemId: null,
        suggestion: {
          title: '双人晚餐', plannedOn: day, estimatedAmountMinor: 9900,
          priority: 'adjustable', catalogItemId: dinner.id, reason: '登记商品可作为待选方案',
        },
      }],
    };
    assert.equal((await app.inject({ method: 'POST', url: '/api/ai/planning-drafts', payload: demand })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/ai/planning-drafts', headers: { ...headers, 'x-test-role': 'reviewer' }, payload: demand })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/ai/planning-drafts', headers, payload: { ...demand, expectedPeriodVersion: 1 } })).statusCode, 400);
    const ordersBefore = Number((await client.query<{ count: string }>('SELECT count(*) FROM orders')).rows[0]!.count);
    const forbiddenOutput = await app.inject({
      method: 'POST', url: '/api/ai/planning-drafts',
      headers: { ...headers, 'idempotency-key': 'b02-forbidden-1' },
      payload: { ...demand, items: [{ ...demand.items[0], orderId: randomUUID(), savingsTargetMinor: 0 }] },
    });
    assert.equal(forbiddenOutput.statusCode, 400);
    const created = await app.inject({ method: 'POST', url: '/api/ai/planning-drafts', headers, payload: demand });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().data.periodId, null);
    assert.equal(created.json().data.assessment, null);
    assert.deepEqual(created.json().data.missingFields, [
      'items.0.plannedOn', 'items.0.userEstimatedAmountMinor', 'items.0.priority',
    ]);
    assert.equal(assessments, 0);
    const repeated = await app.inject({ method: 'POST', url: '/api/ai/planning-drafts', headers, payload: demand });
    assert.deepEqual(repeated.json(), created.json());
    assert.equal((await client.query('SELECT 1 FROM planning_drafts WHERE id=$1 AND period_id IS NULL', [created.json().data.draftId])).rowCount, 1);
    const read = await app.inject({ method: 'GET', url: `/api/ai/planning-drafts/${created.json().data.draftId}`, headers: { 'x-test-role': 'consumer' } });
    assert.deepEqual(read.json(), created.json());
    const hidden = await app.inject({ method: 'GET', url: `/api/ai/planning-drafts/${created.json().data.draftId}`, headers: { 'x-test-role': 'consumer', 'x-test-user': 'other' } });
    assert.equal(hidden.statusCode, 404);

    const accepted = await app.inject({
      method: 'POST', url: `/api/ai/planning-drafts/${created.json().data.draftId}/acceptance`,
      headers: { ...headers, 'idempotency-key': 'b02-accept-0001' },
      payload: { expectedStatus: 'draft', confirmedByUser: true },
    });
    assert.equal(accepted.statusCode, 200);
    assert.equal(accepted.json().data.status, 'accepted');
    const acceptRepeated = await app.inject({
      method: 'POST', url: `/api/ai/planning-drafts/${created.json().data.draftId}/acceptance`,
      headers: { ...headers, 'idempotency-key': 'b02-accept-0001' },
      payload: { expectedStatus: 'draft', confirmedByUser: true },
    });
    assert.deepEqual(acceptRepeated.json(), accepted.json());
    const invalidDiscard = await app.inject({
      method: 'POST', url: `/api/ai/planning-drafts/${created.json().data.draftId}/discard`,
      headers: { ...headers, 'idempotency-key': 'b02-discard-conflict' },
      payload: { expectedStatus: 'draft', confirmedByUser: true },
    });
    assert.equal(invalidDiscard.statusCode, 409);

    const bearerCreated = await app.inject({
      method: 'POST', url: '/api/ai/planning-drafts',
      headers: { 'idempotency-key': 'b02-bearer-create', 'x-test-role': 'consumer', 'x-test-transport': 'bearer' },
      payload: demand,
    });
    assert.equal(bearerCreated.statusCode, 201);
    const bearerDiscarded = await app.inject({
      method: 'POST', url: `/api/ai/planning-drafts/${bearerCreated.json().data.draftId}/discard`,
      headers: { 'idempotency-key': 'b02-bearer-discard', 'x-test-role': 'consumer', 'x-test-transport': 'bearer' },
      payload: { expectedStatus: 'draft', confirmedByUser: true },
    });
    assert.equal(bearerDiscarded.statusCode, 200);
    assert.equal(bearerDiscarded.json().data.status, 'discarded');

    const budget = {
      periodId, expectedFinancialVersion: 1, expectedPeriodVersion: 1,
      items: [{
        title: '朋友聚餐', plannedOn: day, userEstimatedAmountMinor: 8000,
        priority: 'adjustable', requirements: ['晚饭必须保留'], catalogItemId: dinner.id,
        suggestion: null,
      }],
    };
    const budgetCreated = await app.inject({
      method: 'POST', url: '/api/ai/planning-drafts',
      headers: { ...headers, 'idempotency-key': 'b02-budget-0001' }, payload: budget,
    });
    assert.equal(budgetCreated.statusCode, 201);
    assert.equal(budgetCreated.json().data.assessment.status, 'allowed');
    assert.equal(budgetCreated.json().data.basisFinancialVersion, 1);
    assert.equal(assessments, 1);
    assert.equal(Number((await client.query<{ count: string }>('SELECT count(*) FROM orders')).rows[0]!.count), ordersBefore);

    const tools = consumerPlanningAgentTools({
      read_budget_basis: async () => ({}),
      read_month_ledger_summary: async () => ({}),
      search_offers: async () => ({}),
      save_planning_draft: async () => ({}),
    });
    assert.deepEqual(tools.map((tool) => tool.name), [...consumerPlanningToolNames]);
    assert.ok(!tools.some((tool) => ['create_order', 'request_payment', 'pause_purchases', 'submit_change'].includes(tool.name)));
    const modelItem = { title: '朋友聚餐', plannedOn: day,
      userEstimatedAmountMinor: 10000, priority: 'required' as const,
      requirements: [], catalogItemId: dinner.id, suggestion: null };
    const notStated = constrainAgentDraftToMessage([modelItem], '我想和朋友聚餐，预算大概再讨论')[0]!;
    assert.equal(notStated.plannedOn, null);
    assert.equal(notStated.userEstimatedAmountMinor, null);
    assert.equal(notStated.priority, null);
    assert.equal(notStated.catalogItemId, null);
    assert.equal(notStated.suggestion?.estimatedAmountMinor, 10000);
    assert.equal(notStated.suggestion?.catalogItemId, dinner.id);
    const stated = constrainAgentDraftToMessage([{ ...modelItem, catalogItemId: null }],
      `我在 ${day} 有一笔必要支出 ¥100，必须保留`)[0]!;
    assert.equal(stated.plannedOn, day);
    assert.equal(stated.userEstimatedAmountMinor, 10000);
    assert.equal(stated.priority, 'required');
    assert.equal(constrainAgentDraftToMessage([{ ...modelItem, catalogItemId: null }],
      `我在 ${day} 有一笔必要支出 ¥1000，必须保留`)[0]!.userEstimatedAmountMinor, null);
    assert.equal(constrainAgentDraftToMessage([modelItem, { ...modelItem, title: '地铁' }],
      `我在 ${day} 有两项支出共 ¥100，必须保留`)[0]!.userEstimatedAmountMinor, null);

    unavailableApp.addHook('preHandler', async (request) => {
      request.authUser = { id: ownerId, email: '', displayName: '', role: 'consumer' };
    });
    await unavailableApp.register(registerPlanningDraftApi, { transaction: runInCurrentTransaction, db: client });
    const unavailable = await unavailableApp.inject({
      method: 'POST', url: '/api/ai/planning-drafts',
      headers: { origin: config.webOrigin, 'idempotency-key': 'b02-unavailable' }, payload: budget,
    });
    assert.equal(unavailable.statusCode, 409);
    assert.equal(unavailable.json().error.code, 'FINANCE_BASIS_UNKNOWN');
  } finally {
    await unavailableApp.close();
    await app.close();
    await client.query('ROLLBACK');
    client.release();
    await closePool();
  }
});
