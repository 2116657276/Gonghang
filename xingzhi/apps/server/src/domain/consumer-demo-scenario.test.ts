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
  const repeated = await seed({ ...input, password: 'different-password' });
  assert.equal(repeated.reused, true);
  assert.equal(repeated.ownerId, first.ownerId);
  assert.equal(repeated.periodId, null);
  await assert.rejects(seed({ ...input, password: 'x', mode: 'complete' }), /不能改写/);
});
