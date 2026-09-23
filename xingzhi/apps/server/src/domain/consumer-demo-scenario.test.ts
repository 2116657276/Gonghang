import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { config } from '../config.js';
import { seedConsumerDemoScenario } from '../db/consumer-demo-scenario.js';

const connection = new URL(config.databaseUrl);
assert.ok(['localhost', '127.0.0.1'].includes(connection.hostname), '场景测试只允许本机数据库');
const admin = new Pool({ connectionString: connection.toString() });
const schema = `xz_scenario_${randomUUID().replaceAll('-', '')}`;
connection.searchParams.set('options', `-c search_path=${schema}`);
const pool = new Pool({ connectionString: connection.toString() });

before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  const directory = new URL('../db/migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(name, directory), 'utf8'));
  }
});

after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end();
});

async function seed(input: Parameters<typeof seedConsumerDemoScenario>[1]) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await seedConsumerDemoScenario(client, input);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

test('F2 account-only scenario creates finance facts without a budget and never changes mode', async () => {
  const now = new Date();
  const serviceOn = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const scenarioKey = `account-${randomUUID().replaceAll('-', '')}`;
  const input = { scenarioKey, serviceOn, password: 'test-password', now, mode: 'account-only' as const };
  const first = await seed(input);
  assert.equal(first.reused, false);
  assert.equal(first.mode, 'account-only');
  assert.equal(first.periodId, null);
  assert.equal(first.savingsTargetMinor, null);
  assert.equal(first.essentialAndRepaymentMinor, null);
  assert.equal(Number((await pool.query('SELECT count(*) FROM budget_periods WHERE owner_id=$1', [first.ownerId])).rows[0].count), 0);
  assert.equal(Number((await pool.query('SELECT count(*) FROM budget_items WHERE owner_id=$1', [first.ownerId])).rows[0].count), 0);
  assert.equal(Number((await pool.query('SELECT count(*) FROM finance_accounts WHERE owner_id=$1', [first.ownerId])).rows[0].count), 2);
  assert.equal(Number((await pool.query('SELECT count(*) FROM finance_ledger_entries WHERE owner_id=$1', [first.ownerId])).rows[0].count), 0);
  const repeated = await seed({ ...input, password: 'different-password' });
  assert.equal(repeated.reused, true);
  assert.equal(repeated.ownerId, first.ownerId);
  assert.equal(repeated.periodId, null);
  await assert.rejects(seed({ ...input, password: 'x', mode: 'complete' }), /不能改写/);
});

test('D1 complete scenarios bind one merchant and reviewer, with separate automatic and manual branches', async () => {
  const merchantId = randomUUID(); const reviewerId = randomUUID();
  await pool.query(`INSERT INTO users(id,email,display_name,role,password_hash) VALUES
    ($1,'merchant@xingzhi.local','测试商户','merchant_admin','disabled'),
    ($2,'reviewer@xingzhi.local','测试审核者','reviewer','disabled')`, [merchantId, reviewerId]);
  const now = new Date();
  const serviceOn = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const automatic = await seed({ scenarioKey: `auto-${randomUUID().replaceAll('-', '')}`,
    serviceOn, password: 'test-password', now, mode: 'complete', aftercareMode: 'automatic' });
  assert.equal(automatic.merchantId, merchantId); assert.equal(automatic.reviewerId, reviewerId);
  assert.ok(automatic.catalogItemId); assert.ok(automatic.quoteId);
  const ledger = (await pool.query<{ source: string; direction: string; amount_minor: number; covered: boolean }>(`
    SELECT l.source,l.direction,l.amount_minor,l.occurred_at<=s.covered_through_at AS covered
      FROM finance_ledger_entries l JOIN finance_account_snapshots s ON s.account_id=l.account_id
      WHERE l.owner_id=$1 ORDER BY l.amount_minor`, [automatic.ownerId])).rows;
  assert.deepEqual(ledger.map(row => [row.source, row.direction, row.amount_minor, row.covered]), [
    ['demo', 'outflow', 300, true], ['demo', 'outflow', 1800, true], ['demo', 'inflow', 30000, true],
  ]);
  const manualInput = { scenarioKey: `manual-${randomUUID().replaceAll('-', '')}`,
    serviceOn, password: 'test-password', now, mode: 'complete' as const,
    aftercareMode: 'merchant-review' as const };
  const manual = await seed(manualInput);
  assert.equal(manual.merchantId, merchantId); assert.equal(manual.reviewerId, reviewerId);
  assert.equal((await pool.query('SELECT cancellation_rule FROM catalog_items WHERE id=$1',
    [manual.catalogItemId])).rows[0].cancellation_rule, 'delay');
  assert.equal(Number((await pool.query(`SELECT count(*) FROM budget_review_scopes
    WHERE reviewer_id=$1 AND period_id=$2`, [reviewerId, manual.periodId])).rows[0].count), 1);
  const replay = await seed({ ...manualInput, password: 'different-password' });
  assert.equal(replay.reused, true); assert.equal(replay.quoteId, manual.quoteId);
});
