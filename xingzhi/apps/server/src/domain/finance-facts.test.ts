import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import type { PoolClient } from 'pg';
import { config } from '../config.js';
import { pool, closePool } from '../db/client.js';
import { seedConsumerFinanceDemo } from '../db/consumer-finance-demo.js';
import { registerFinanceAccountApi } from '../routes/finance-accounts.js';
import { loadFinanceAccountFacts, readExecutionCashBasis } from './finance-facts.js';

test('A00 fixture repeats without changing historical facts; A01 restricts cash and revocation', async () => {
  const client = await pool.connect();
  const app = Fastify();
  try {
    await client.query('BEGIN');
    const beforeOrders = (await client.query('SELECT id,status,amount_minor FROM orders ORDER BY id')).rows;
    const beforeCatalog = (await client.query("SELECT id,price_minor,active FROM catalog_items WHERE code IN ('A-RAIL','B-STAY','C-ACTIVITY','D-PLAN') ORDER BY code")).rows;
    const fixture = await seedConsumerFinanceDemo(client);
    const first = await loadFinanceAccountFacts(client, fixture.ownerId, fixture.accountId);
    const periodBefore = (await client.query<{ version: string }>(
      'SELECT version FROM budget_periods WHERE id=$1', [fixture.periodId],
    )).rows[0]!;
    assert.deepEqual(await seedConsumerFinanceDemo(client), fixture);
    const repeated = await loadFinanceAccountFacts(client, fixture.ownerId, fixture.accountId);
    assert.equal(repeated.account.financialVersion, first.account.financialVersion);
    assert.equal((await client.query<{ version: string }>(
      'SELECT version FROM budget_periods WHERE id=$1', [fixture.periodId],
    )).rows[0]!.version, periodBefore.version);
    assert.deepEqual((await client.query('SELECT id,status,amount_minor FROM orders ORDER BY id')).rows, beforeOrders);
    assert.deepEqual((await client.query("SELECT id,price_minor,active FROM catalog_items WHERE code IN ('A-RAIL','B-STAY','C-ACTIVITY','D-PLAN') ORDER BY code")).rows, beforeCatalog);
    assert.equal(first.cashBasis.confirmedCashMinor, 200000);
    assert.equal(first.latestSnapshot?.factStatus, 'observed');
    assert.equal(first.account.maskedIdentifier, '****A00');
    assert.equal((await client.query<{ amount: string }>(`SELECT SUM(user_estimated_amount_minor) AS amount
      FROM budget_items WHERE period_id=$1 AND kind='planned_spend'`, [fixture.periodId])).rows[0]!.amount, '40000');

    const secondConsumer = (await client.query<{ id: string }>(
      "SELECT id FROM users WHERE email='consumer-b@xingzhi.local' AND role='consumer'",
    )).rows[0]!;
    app.addHook('preHandler', async (request) => {
      if (request.headers['x-test-user'] === 'owner') {
        request.authUser = { id: fixture.ownerId, email: '', displayName: '', role: 'consumer' };
      } else if (request.headers['x-test-user'] === 'other') {
        request.authUser = { id: secondConsumer.id, email: '', displayName: '', role: 'consumer' };
      } else if (request.headers['x-test-user'] === 'reviewer') {
        request.authUser = { id: randomUUID(), email: '', displayName: '', role: 'reviewer' };
      }
    });
    const runCurrent = async <T>(run: (transactionClient: PoolClient) => Promise<T>) => run(client);
    await app.register(registerFinanceAccountApi, { db: client, transaction: runCurrent });
    assert.equal((await app.inject({ url: '/api/finance/accounts' })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/finance/accounts', headers: { 'x-test-user': 'reviewer' } })).statusCode, 403);
    const ownerList = await app.inject({ url: '/api/finance/accounts', headers: { 'x-test-user': 'owner' } });
    assert.equal(ownerList.statusCode, 200);
    assert.ok(ownerList.json().data.accounts.some(
      (row: { account: { accountId: string } }) => row.account.accountId === fixture.accountId,
    ));
    const otherList = await app.inject({ url: '/api/finance/accounts', headers: { 'x-test-user': 'other' } });
    assert.equal(otherList.statusCode, 200);
    assert.ok(!otherList.json().data.accounts.some((row: { account: { accountId: string } }) => row.account.accountId === fixture.accountId));
    await assert.rejects(readExecutionCashBasis(client, secondConsumer.id, fixture.accountId),
      (error: { code?: string }) => error.code === 'RESOURCE_FORBIDDEN');

    await client.query('SAVEPOINT facts');
    const coveredAt = first.latestSnapshot!.coveredThroughAt!;
    const afterCoverage = new Date(new Date(coveredAt).getTime() + 1000);
    await client.query(`INSERT INTO finance_ledger_entries
      (id,owner_id,account_id,source,direction,amount_minor,occurred_at,posted_at,status,dedupe_key)
      VALUES($1,$2,$3,'demo','inflow',10000,$4,$4,'posted',$5)`,
    [randomUUID(), fixture.ownerId, fixture.accountId, afterCoverage, randomUUID()]);
    await client.query(`INSERT INTO finance_ledger_entries
      (id,owner_id,account_id,source,direction,amount_minor,occurred_at,posted_at,status,dedupe_key)
      VALUES($1,$2,$3,'demo','outflow',3000,$4,$4,'posted',$5)`,
    [randomUUID(), fixture.ownerId, fixture.accountId, afterCoverage, randomUUID()]);
    const futurePostedAt = new Date(afterCoverage.getTime() + 86400000);
    await client.query(`INSERT INTO finance_ledger_entries
      (id,owner_id,account_id,source,direction,amount_minor,occurred_at,posted_at,status,dedupe_key)
      VALUES($1,$2,$3,'demo','inflow',50000,$4,$4,'posted',$5)`,
    [randomUUID(), fixture.ownerId, fixture.accountId, futurePostedAt, randomUUID()]);
    await client.query(`INSERT INTO finance_ledger_entries
      (id,owner_id,account_id,source,direction,amount_minor,occurred_at,status,dedupe_key,category)
      VALUES($1,$2,$3,'demo','inflow',5000,$4,'pending',$5,'refund')`,
    [randomUUID(), fixture.ownerId, fixture.accountId, afterCoverage, randomUUID()]);
    const withLedger = await loadFinanceAccountFacts(client, fixture.ownerId, fixture.accountId,
      new Date(afterCoverage.getTime() + 1000));
    assert.equal(withLedger.cashBasis.confirmedCashMinor, 207000);
    assert.equal(withLedger.displayOnly.pendingRefundMinor, 5000);
    await client.query('ROLLBACK TO SAVEPOINT facts');

    await client.query('SAVEPOINT incomplete');
    const newerId = randomUUID();
    await client.query(`INSERT INTO finance_account_snapshots
      (id,account_id,as_of,fact_status,source,available_balance_minor,provider_snapshot_ref)
      VALUES($1,$2,$3,'observed','demo',220000,$4)`,
    [newerId, fixture.accountId, new Date(Date.now() + 1000), randomUUID()]);
    const oldId = randomUUID();
    await client.query(`INSERT INTO finance_account_snapshots
      (id,account_id,as_of,covered_through_at,fact_status,source,available_balance_minor,provider_snapshot_ref)
      VALUES($1,$2,$3,$3,'observed','demo',190000,$4)`,
    [oldId, fixture.accountId, new Date(Date.now() - 86400000), randomUUID()]);
    const incomplete = await loadFinanceAccountFacts(client, fixture.ownerId, fixture.accountId);
    assert.equal(incomplete.latestSnapshot?.snapshotId, newerId);
    assert.equal(incomplete.cashBasis.confirmedCashMinor, null);
    assert.ok(incomplete.cashBasis.reasonCodes.includes('COVERAGE_UNKNOWN'));
    await assert.rejects(readExecutionCashBasis(client, fixture.ownerId, fixture.accountId),
      (error: { code?: string }) => error.code === 'FINANCE_BASIS_UNKNOWN');
    await client.query(`UPDATE finance_account_snapshots
      SET covered_through_at=as_of,available_balance_minor=NULL WHERE id=$1`, [newerId]);
    const noBalance = await loadFinanceAccountFacts(client, fixture.ownerId, fixture.accountId,
      new Date(Date.now() + 2000));
    assert.equal(noBalance.cashBasis.confirmedCashMinor, null);
    assert.ok(noBalance.cashBasis.reasonCodes.includes('AVAILABLE_BALANCE_UNKNOWN'));
    await client.query('ROLLBACK TO SAVEPOINT incomplete');

    await client.query('SAVEPOINT obligations');
    const creditId = randomUUID();
    await client.query(`INSERT INTO finance_accounts
      (id,owner_id,provider,account_type,provider_account_ref,masked_identifier,display_name,source,authorized_at)
      VALUES($1,$2,'demo','credit',$3,'****CREDIT','测试信用账户','demo',now())`,
    [creditId, fixture.ownerId, randomUUID()]);
    await client.query(`INSERT INTO finance_account_snapshots
      (id,account_id,as_of,covered_through_at,fact_status,source,available_balance_minor,credit_limit_minor)
      VALUES($1,$2,now(),now(),'observed','demo',100000,100000)`, [randomUUID(), creditId]);
    const credit = await loadFinanceAccountFacts(client, fixture.ownerId, creditId);
    assert.equal(credit.displayOnly.creditLimitMinor, 100000);
    assert.equal(credit.cashBasis.confirmedCashMinor, null);
    await assert.rejects(readExecutionCashBasis(client, fixture.ownerId, creditId),
      (error: { code?: string }) => error.code === 'FINANCE_BASIS_UNKNOWN');

    const billId = randomUUID();
    const installmentId = randomUUID();
    await client.query(`INSERT INTO finance_obligations
      (id,owner_id,liability_account_id,repayment_account_id,obligation_type,label,due_on,
        amount_due_minor,outstanding_minor,status,source)
      VALUES($1,$2,$3,$4,'credit_bill','本月账单',$5,12000,12000,'upcoming','demo')`,
    [billId, fixture.ownerId, creditId, fixture.accountId, fixture.monthEnd]);
    await client.query(`INSERT INTO finance_obligations
      (id,owner_id,liability_account_id,repayment_account_id,obligation_type,label,due_on,
        amount_due_minor,outstanding_minor,status,source,included_in_obligation_id)
      VALUES($1,$2,$3,$4,'installment','账单所含分期',$5,2000,2000,'upcoming','demo',$6)`,
    [installmentId, fixture.ownerId, creditId, fixture.accountId, fixture.monthEnd, billId]);
    const repayment = await readExecutionCashBasis(client, fixture.ownerId, fixture.accountId);
    assert.equal(repayment.obligations.remainingDueMinor, 12000);
    const settlementId = randomUUID();
    const settledAt = new Date(new Date(repayment.cashBasis.coveredThroughAt!).getTime() + 1000);
    await client.query(`INSERT INTO finance_ledger_entries
      (id,owner_id,account_id,source,direction,amount_minor,occurred_at,posted_at,status,dedupe_key)
      VALUES($1,$2,$3,'demo','outflow',12000,$4,$4,'posted',$5)`,
    [settlementId, fixture.ownerId, fixture.accountId, settledAt, randomUUID()]);
    await client.query(`UPDATE finance_obligations
      SET status='paid',settled_ledger_entry_id=$1,outstanding_minor=0 WHERE id=$2`,
    [settlementId, billId]);
    const paid = await readExecutionCashBasis(client, fixture.ownerId, fixture.accountId,
      new Date(settledAt.getTime() + 1000));
    assert.equal(paid.obligations.remainingDueMinor, 0);
    assert.equal(paid.cashBasis.confirmedCashMinor, 188000);
    await client.query('UPDATE finance_obligations SET included_in_obligation_id=$1 WHERE id=$2',
      [installmentId, billId]);
    const cycle = await loadFinanceAccountFacts(client, fixture.ownerId, fixture.accountId);
    assert.equal(cycle.obligations.dataStatus, 'unknown');
    assert.ok(cycle.obligations.items.some((row) => 'dataIssue' in row && row.dataIssue === 'OBLIGATION_CYCLE'));
    await assert.rejects(readExecutionCashBasis(client, fixture.ownerId, fixture.accountId),
      (error: { code?: string }) => error.code === 'FINANCE_BASIS_UNKNOWN');
    await client.query('ROLLBACK TO SAVEPOINT obligations');

    const url = `/api/finance/accounts/${fixture.accountId}/revocations`;
    const body = { expectedStatus: 'linked' };
    const headers = { origin: config.webOrigin, 'idempotency-key': 'a01-revoke-0001', 'x-test-user': 'owner' };
    assert.equal((await app.inject({ method: 'POST', url, headers: { ...headers, 'x-test-user': 'other' }, payload: body })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url, headers: { ...headers, origin: 'https://invalid.example' }, payload: body })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url, headers: { origin: config.webOrigin, 'x-test-user': 'owner' }, payload: body })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url, headers, payload: { expectedStatus: 'revoked' } })).statusCode, 400);
    const revoked = await app.inject({ method: 'POST', url, headers, payload: body });
    assert.equal(revoked.statusCode, 200);
    assert.equal(revoked.json().data.status, 'revoked');
    assert.deepEqual(revoked.json().data.affectedPeriodIds, [fixture.periodId]);
    assert.equal(revoked.json().data.financialVersion, first.account.financialVersion + 1);
    const periodAfter = (await client.query<{ version: string }>(
      'SELECT version FROM budget_periods WHERE id=$1', [fixture.periodId],
    )).rows[0]!;
    assert.equal(Number(periodAfter.version), Number(periodBefore.version) + 1);
    const revocationEvents = await client.query<{ count: string }>(`SELECT count(*) FROM budget_events
      WHERE period_id=$1 AND type='finance_account_revoked'`, [fixture.periodId]);
    assert.equal(Number(revocationEvents.rows[0]!.count), 1);
    assert.deepEqual((await app.inject({ method: 'POST', url, headers, payload: body })).json(), revoked.json());
    const again = await app.inject({ method: 'POST', url, headers: {
      ...headers, 'idempotency-key': 'a01-revoke-0002',
    }, payload: body });
    assert.equal(again.json().data.financialVersion, revoked.json().data.financialVersion);
    assert.equal((await client.query<{ version: string }>('SELECT version FROM budget_periods WHERE id=$1',
      [fixture.periodId])).rows[0]!.version, periodAfter.version);
    assert.equal(Number((await client.query<{ count: string }>(`SELECT count(*) FROM budget_events
      WHERE period_id=$1 AND type='finance_account_revoked'`, [fixture.periodId])).rows[0]!.count), 1);
    const after = await loadFinanceAccountFacts(client, fixture.ownerId, fixture.accountId);
    assert.equal(after.cashBasis.confirmedCashMinor, null);
    assert.equal(after.latestSnapshot?.snapshotId, fixture.snapshotId);
    await assert.rejects(readExecutionCashBasis(client, fixture.ownerId, fixture.accountId),
      (error: { code?: string }) => error.code === 'FINANCE_SCOPE_REVOKED');
    await client.query('SAVEPOINT demo_reauthorization');
    const reauthorized = await app.inject({ method: 'POST',
      url: `/api/finance/accounts/${fixture.accountId}/demo-reauthorizations`,
      headers: { origin: config.webOrigin, 'idempotency-key': 'a01-reauthorize-0001', 'x-test-user': 'owner' },
      payload: { expectedStatus: 'revoked', acknowledgedDemoData: true } });
    assert.equal(reauthorized.statusCode, 200);
    assert.equal(reauthorized.json().data.status, 'linked');
    assert.equal(reauthorized.json().data.financialVersion, revoked.json().data.financialVersion + 1);
    assert.equal((await client.query<{ status: string }>(
      'SELECT status FROM finance_accounts WHERE id=$1', [fixture.accountId])).rows[0]!.status, 'linked');
    assert.equal(Number((await client.query<{ count: string }>(`SELECT count(*) FROM budget_events
      WHERE period_id=$1 AND type='finance_demo_account_reauthorized'`, [fixture.periodId])).rows[0]!.count), 1);
    await client.query('ROLLBACK TO SAVEPOINT demo_reauthorization');
    await client.query('RELEASE SAVEPOINT demo_reauthorization');
    const replacement = await seedConsumerFinanceDemo(client);
    assert.notEqual(replacement.accountId, fixture.accountId);
    assert.notEqual(replacement.snapshotId, fixture.snapshotId);
    assert.notEqual(replacement.periodId, fixture.periodId);
    assert.equal((await client.query<{ status: string }>(
      'SELECT status FROM finance_accounts WHERE id=$1', [fixture.accountId],
    )).rows[0]!.status, 'revoked');
    assert.equal((await client.query<{ status: string }>(
      'SELECT status FROM finance_accounts WHERE id=$1', [replacement.accountId],
    )).rows[0]!.status, 'linked');
    assert.deepEqual(await seedConsumerFinanceDemo(client), replacement);
  } finally {
    await app.close();
    await client.query('ROLLBACK');
    client.release();
    await closePool();
  }
});
