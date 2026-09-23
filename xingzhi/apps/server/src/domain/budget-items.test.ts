import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import type { PoolClient } from 'pg';
import type { BudgetItemMutationResult } from '@xingzhi/contracts';
import { config } from '../config.js';
import { pool, closePool } from '../db/client.js';
import { seedConsumerCatalog } from '../db/consumer-catalog.js';
import type { BudgetItemPort } from './budget-port.js';
import { registerBudgetItemApi } from '../routes/budget-items.js';

test('B01 consumer item routes preserve transaction, ownership and idempotency boundaries', async () => {
  const client = await pool.connect();
  const app = Fastify();
  const unavailableApp = Fastify();
  try {
    await client.query('BEGIN');
    const consumer = (await client.query<{ id: string }>(
      "SELECT id FROM users WHERE role='consumer' ORDER BY created_at LIMIT 1",
    )).rows[0];
    assert.ok(consumer);
    const day = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    await seedConsumerCatalog(client, day);
    const periodId = randomUUID();
    const itemId = randomUUID();
    const accountId = randomUUID();
    const snapshotId = randomUUID();
    let changes = 0;
    let cancellations = 0;
    const result = (status: 'planned' | 'cancelled', itemVersion: number): BudgetItemMutationResult => ({
      item: {
        itemId, periodId, kind: 'planned_spend', title: '朋友聚餐', categoryCode: 'food',
        plannedOn: day, userEstimatedAmountMinor: 8000, priority: 'adjustable', status,
        itemVersion, linkedQuote: null,
      },
      basis: {
        accountId, periodId, currency: 'CNY', financialVersion: 3,
        periodVersion: itemVersion + 1, basisSnapshotId: snapshotId,
        asOf: new Date().toISOString(), confirmedCashMinor: 200000,
        savingsTargetMinor: 50000, essentialRemainingMinor: 90000,
        adjustablePlannedMinor: status === 'planned' ? 40000 : 32000,
        committedOrdersMinor: 0, expectedIncomeMinor: 0, pendingRefundMinor: 0,
        minimumProjectedCashMinor: status === 'planned' ? 20000 : 28000,
        minimumSavingsHeadroomMinor: status === 'planned' ? 10000 : 18000,
        minimumCashOn: day, dataStatus: 'observed',
      },
    });
    const port: BudgetItemPort = {
      async applyBudgetItemChange(receivedClient, ownerId, input) {
        assert.equal(receivedClient, client);
        assert.equal(ownerId, consumer.id);
        changes += 1;
        return result('planned', input.itemId ? 2 : 1);
      },
      async cancelBudgetItem(receivedClient, ownerId) {
        assert.equal(receivedClient, client);
        assert.equal(ownerId, consumer.id);
        cancellations += 1;
        return result('cancelled', 3);
      },
    };
    app.addHook('preHandler', async (request) => {
      const role = request.headers['x-test-role'];
      if (role) request.authUser = {
        id: role === 'consumer' ? consumer.id : randomUUID(),
        email: '', displayName: '', role: role as 'consumer' | 'reviewer',
      };
    });
    const runInCurrentTransaction = async <T>(run: (transactionClient: PoolClient) => Promise<T>) => run(client);
    await app.register(registerBudgetItemApi, { budgetItemPort: port, transaction: runInCurrentTransaction });
    const baseHeaders = { origin: config.webOrigin, 'idempotency-key': 'b01-create-0001', 'x-test-role': 'consumer' };
    const createBody = {
      periodId, itemId: null, expectedPeriodVersion: 1, kind: 'planned_spend',
      title: ' 朋友聚餐 ', categoryCode: 'food', plannedOn: day,
      userEstimatedAmountMinor: 8000, priority: 'adjustable', changeReason: '新增聚餐安排',
    };
    assert.equal((await app.inject({ method: 'POST', url: `/api/budget-periods/${periodId}/items`, payload: createBody })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: `/api/budget-periods/${periodId}/items`, headers: { ...baseHeaders, 'x-test-role': 'reviewer' }, payload: createBody })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: `/api/budget-periods/${periodId}/items`, headers: { ...baseHeaders, origin: 'https://invalid.example' }, payload: createBody })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: `/api/budget-periods/${periodId}/items`, headers: { origin: config.webOrigin, 'x-test-role': 'consumer' }, payload: createBody })).statusCode, 400);
    const created = await app.inject({ method: 'POST', url: `/api/budget-periods/${periodId}/items`, headers: baseHeaders, payload: createBody });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().data.item.itemId, itemId);
    assert.equal(created.json().data.candidateOffers.length, 2);
    assert.equal(created.json().data.candidateOffers[0].quote.quoteSource, 'demo');
    assert.equal(created.json().meta.periodVersion, 2);
    const repeated = await app.inject({ method: 'POST', url: `/api/budget-periods/${periodId}/items`, headers: baseHeaders, payload: createBody });
    assert.equal(repeated.statusCode, 201);
    assert.deepEqual(repeated.json(), created.json());
    assert.equal(changes, 1);
    const conflict = await app.inject({ method: 'POST', url: `/api/budget-periods/${periodId}/items`, headers: baseHeaders, payload: { ...createBody, title: '另一安排' } });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error.code, 'IDEMPOTENCY_CONFLICT');
    const wrongPath = await app.inject({ method: 'PATCH', url: `/api/budget-periods/${periodId}/items/${randomUUID()}`, headers: { ...baseHeaders, 'idempotency-key': 'b01-patch-0001' }, payload: { ...createBody, itemId } });
    assert.equal(wrongPath.statusCode, 400);
    const changed = await app.inject({ method: 'PATCH', url: `/api/budget-periods/${periodId}/items/${itemId}`, headers: { ...baseHeaders, 'idempotency-key': 'b01-patch-0002' }, payload: { ...createBody, itemId, expectedPeriodVersion: 2, changeReason: '调整聚餐日期' } });
    assert.equal(changed.statusCode, 200);
    assert.equal(changes, 2);
    const cancelled = await app.inject({
      method: 'POST', url: `/api/budget-periods/${periodId}/items/${itemId}/cancellations`,
      headers: { ...baseHeaders, 'idempotency-key': 'b01-cancel-001' },
      payload: { periodId, itemId, expectedPeriodVersion: 3, reason: '取消聚餐安排' },
    });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().data.item.status, 'cancelled');
    assert.deepEqual(cancelled.json().data.candidateOffers, []);
    assert.equal(cancellations, 1);

    unavailableApp.addHook('preHandler', async (request) => {
      request.authUser = { id: consumer.id, email: '', displayName: '', role: 'consumer' };
    });
    await unavailableApp.register(registerBudgetItemApi, { transaction: runInCurrentTransaction });
    const unavailable = await unavailableApp.inject({
      method: 'POST', url: `/api/budget-periods/${periodId}/items`,
      headers: { origin: config.webOrigin, 'idempotency-key': 'b01-unavailable', 'x-test-role': 'consumer' },
      payload: createBody,
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
