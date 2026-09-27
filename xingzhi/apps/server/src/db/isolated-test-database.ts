import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { config } from '../config.js';

// Import db/client only after selecting the private search_path: its Pool is created at import time.
export async function createIsolatedTestDatabase() {
  const connection = new URL(config.databaseUrl);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(connection.hostname),
    '数据库集成测试只允许连接本机 PostgreSQL');
  assert.match(connection.pathname,
    /^\/xingzhi_(?:dev|test(?:_[a-z0-9_]+)?|m1_acceptance_[a-z0-9_]+)$/,
    '数据库集成测试只允许使用行止本机开发库或显式隔离测试库');
  const admin = new Pool({ connectionString: connection.toString() });
  const schema = `xz_test_${randomUUID().replaceAll('-', '')}`;
  connection.searchParams.set('options', `-c search_path=${schema}`);
  config.databaseUrl = connection.toString();
  config.paymentMode = 'simulation';
  let closePool: (() => Promise<void>) | undefined;
  let created = false;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    created = true;
    const clientModule = await import('./client.js');
    closePool = clientModule.closePool;
    const migrations = new URL('./migrations/', import.meta.url);
    for (const name of (await readdir(migrations)).filter((item) => item.endsWith('.sql')).sort()) {
      await clientModule.pool.query(await readFile(new URL(name, migrations), 'utf8'));
    }
    await clientModule.pool.query(`INSERT INTO users (id,email,display_name,role,password_hash) VALUES
      ($1,'consumer-a@xingzhi.local','测试消费者 A','consumer','disabled'),
      ($2,'consumer-b@xingzhi.local','测试消费者 B','consumer','disabled'),
      ($3,'merchant@test.local','测试商户','merchant_admin','disabled')`,
    [randomUUID(), randomUUID(), randomUUID()]);
    return {
      pool: clientModule.pool,
      async close() {
        try {
          await closePool?.();
          await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        } finally {
          await admin.end();
        }
      },
    };
  } catch (error) {
    try {
      await closePool?.();
      if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    } finally {
      await admin.end();
    }
    throw error;
  }
}
