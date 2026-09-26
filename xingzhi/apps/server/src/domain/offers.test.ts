import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { createIsolatedTestDatabase } from '../db/isolated-test-database.js';
import { budgetItemCancelInput, consumerApiError } from '@xingzhi/contracts';

const database = await createIsolatedTestDatabase();
const { pool } = database;
after(() => database.close());
const { seedConsumerCatalog } = await import('../db/consumer-catalog.js');
const { registerOfferApi } = await import('../routes/offers.js');

test('B00 catalog/quote boundaries and repeatable initialization', async () => {
  const client = await pool.connect();
  const app = Fastify();
  try {
    await client.query('BEGIN');
    const day = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const legacy = await client.query("SELECT * FROM catalog_items WHERE code IN ('A-RAIL','B-STAY','C-ACTIVITY','D-PLAN') ORDER BY code");
    await seedConsumerCatalog(client, day);
    const before = await client.query('SELECT * FROM offer_quotes ORDER BY id');
    await seedConsumerCatalog(client, day);
    assert.deepEqual((await client.query('SELECT * FROM offer_quotes ORDER BY id')).rows, before.rows);
    assert.deepEqual((await client.query("SELECT * FROM catalog_items WHERE code IN ('A-RAIL','B-STAY','C-ACTIVITY','D-PLAN') ORDER BY code")).rows, legacy.rows);
    // Test-only identity injection; production app continues to load persistent sessions.
    app.addHook('preHandler', async (request) => {
      if (request.headers['x-test-role']) request.authUser = { id: randomUUID(), email: '', displayName: '', role: request.headers['x-test-role'] as 'consumer' };
    });
    await app.register(registerOfferApi, { db: client });
    const get = (url: string, role = 'consumer') => app.inject({ url, headers: role ? { 'x-test-role': role } : {} });
    assert.equal((await get(`/api/offers?plannedOn=${day}`, '')).statusCode, 401);
    assert.equal((await get(`/api/offers?plannedOn=${day}`, 'reviewer')).statusCode, 403);
    assert.equal((await get('/api/offers?plannedOn=2026-02-30')).statusCode, 400);
    const list = (await get(`/api/offers?plannedOn=${day}&categoryCode=food`)).json().data.items;
    const dinner = list.find((x: {code:string}) => x.code === 'CONSUMER-DINNER-99');
    const listing = list.find((x: {code:string}) => x.code === 'CONSUMER-FOOD-LISTING');
    assert.ok(dinner && listing);
    const url = `/api/offers/${dinner.id}/quote?plannedOn=${day}`;
    const quote = (await get(url)).json().data;
    assert.equal(quote.priceMinor, 9900);
    assert.equal(quote.quoteSource, 'demo');
    assert.equal(quote.serviceOn, day);
    assert.equal((await get(`/api/offers/${listing.id}/quote?plannedOn=${day}`)).statusCode, 409);
    assert.equal((await get(`/api/offers/${dinner.id}/quote?plannedOn=2099-01-01`)).statusCode, 409);
    const readBefore = (await client.query('SELECT * FROM offer_quotes ORDER BY id')).rows;
    await get(url);
    assert.deepEqual((await client.query('SELECT * FROM offer_quotes ORDER BY id')).rows, readBefore);
    await client.query('SAVEPOINT boundary');
    await client.query('UPDATE catalog_items SET active=false WHERE id=$1', [dinner.id]);
    assert.equal((await get(url)).statusCode, 409);
    assert.ok(!(await get(`/api/offers?plannedOn=${day}`)).json().data.items.some((x:{id:string})=>x.id===dinner.id));
    await client.query('ROLLBACK TO SAVEPOINT boundary');
    await client.query("UPDATE offer_quotes SET status='withdrawn' WHERE id=$1", [quote.quoteId]);
    assert.equal((await get(url)).statusCode, 409);
    await client.query('ROLLBACK TO SAVEPOINT boundary');
    await client.query("UPDATE offer_quotes SET status='expired' WHERE id=$1", [quote.quoteId]);
    assert.equal((await get(url)).statusCode, 409);
    budgetItemCancelInput.parse({ periodId:randomUUID(), itemId:randomUUID(), expectedPeriodVersion:1, reason:'取消安排' });
    consumerApiError.parse({error:{code:'FINANCE_SCOPE_REVOKED',message:'已撤回'},correlationId:randomUUID()});
  } finally {
    await app.close();
    await client.query('ROLLBACK');
    client.release();
  }
});
