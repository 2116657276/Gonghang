import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import Fastify from 'fastify';
import type { PoolClient } from 'pg';
import { config } from '../config.js';
import { createIsolatedTestDatabase } from '../db/isolated-test-database.js';

const database = await createIsolatedTestDatabase();
const { pool } = database;
after(() => database.close());
const { seedConsumerFinanceDemo } = await import('../db/consumer-finance-demo.js');
const { registerFinanceAssessmentApi } = await import('../routes/finance-assessments.js');
const { buildCashflowEvents, forecastBudgetCashflow } = await import('./budget-cashflow.js');
const { commitPurchaseAssessment } = await import('./purchase-commit.js');
const { assessAdjustmentOption, assessPurchasePreview, assessUnexpectedSpend } = await import('./purchase-assessment.js');
const { createConfirmedOrder } = await import('./business-actions.js');

test('A04 previews immutable actual quote; A05 rechecks and commits one pending order atomically', async () => {
  const client = await pool.connect();
  const app = Fastify();
  try {
    await client.query('BEGIN');
    const now = new Date();
    const fixture = await seedConsumerFinanceDemo(client, now);
    const merchant = (await client.query<{ id: string }>(
      "SELECT id FROM users WHERE role='merchant_admin' ORDER BY id LIMIT 1",
    )).rows[0]!;
    const catalogId = randomUUID();
    const quoteId = randomUUID();
    await client.query(`INSERT INTO catalog_items
      (id,merchant_id,code,name,kind,description,price_minor,rule_label,
        simulation_mode,purchase_mode,category_code)
      VALUES($1,$2,$3,'Demo 聚餐','food','A04 临时测试报价',9900,'测试规则',
        'SUCCESS','orderable','food')`, [catalogId, merchant.id, `A04-${randomUUID()}`]);
    await client.query(`INSERT INTO offer_quotes
      (id,catalog_item_id,provider,quote_source,quote_version,price_minor,
        service_on,rule_version,rule_snapshot,valid_until)
      VALUES($1,$2,'demo-provider','demo',1,9900,$3::date,1,'{}'::jsonb,$4)`,
    [quoteId, catalogId, new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now), new Date(now.getTime() + 60 * 60_000)]);
    const versions = (await client.query<{ financialVersion: string; periodVersion: string }>(`SELECT
      a.financial_version AS "financialVersion",p.version AS "periodVersion"
      FROM budget_periods p JOIN finance_accounts a ON a.id=p.primary_account_id
      WHERE p.id=$1`, [fixture.periodId])).rows[0]!;
    const input = {
      periodId: fixture.periodId, budgetItemId: fixture.dinnerItemId, quoteId,
      expectedFinancialVersion: Number(versions.financialVersion),
      expectedPeriodVersion: Number(versions.periodVersion), expectedQuoteVersion: 1,
      mode: 'preview' as const,
    };
    const startOn = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
    const futureReplacement = buildCashflowEvents({ startOn, endOn: fixture.monthEnd,
      items: [{ id: fixture.dinnerItemId, plannedOn: fixture.monthEnd,
        kind: 'planned_spend', status: 'planned', estimatedMinor: '8000' }],
      orders: [], repayments: [],
      replacement: { budgetItemId: fixture.dinnerItemId, quotedAmountMinor: 9900, quoteId },
    });
    assert.deepEqual(futureReplacement.events.map((event) => [event.on, event.deltaMinor]),
      [[startOn, -9900]]); // The ¥80 future estimate does not mask today's ¥99 commitment.
    const baseline = await forecastBudgetCashflow(client, fixture.ownerId, fixture.periodId, { now });
    const preview = await assessPurchasePreview(client, fixture.ownerId, input, now);
    assert.equal(preview.replacedEstimateMinor, 8000);
    assert.equal(preview.quotedAmountMinor, 9900);
    assert.equal(preview.incrementalImpactMinor, 1900);
    assert.equal(preview.status, 'allowed');
    assert.equal(preview.shortfallMinor, 0);
    assert.equal(preview.basisSnapshotId, fixture.snapshotId);
    assert.equal(baseline.forecast.minimumSavingsHeadroomMinor! - 1900, 18100);
    const stored = await client.query('SELECT 1 FROM funding_assessments WHERE id=$1', [preview.assessmentId]);
    assert.equal(stored.rowCount, 1);
    const unexpected = await assessUnexpectedSpend(client, fixture.ownerId, fixture.periodId, {
      amountMinor: 30000, spendOn: fixture.monthEnd,
      expectedFinancialVersion: input.expectedFinancialVersion,
      expectedPeriodVersion: input.expectedPeriodVersion,
    }, now);
    assert.equal(unexpected.forecast.status, 'needs_adjustment');
    assert.equal(unexpected.forecast.shortfallMinor, 10000);
    const flexibleId = (await client.query<{ id: string }>(`SELECT id FROM budget_items
      WHERE period_id=$1 AND owner_id=$2 AND title='其他可调生活开支'`,
    [fixture.periodId, fixture.ownerId])).rows[0]!.id;
    const option = await assessAdjustmentOption(client, fixture.ownerId, fixture.periodId, {
      changes: [{ budgetItemId: flexibleId, action: 'cancel' }],
      unexpectedSpend: { amountMinor: 40000, spendOn: fixture.monthEnd },
      expectedFinancialVersion: input.expectedFinancialVersion,
      expectedPeriodVersion: input.expectedPeriodVersion,
    }, now);
    assert.equal(option.forecast.status, 'allowed');
    assert.equal(option.forecast.minimumSavingsHeadroomMinor, 12000);
    assert.equal((await client.query<{ status: string }>(
      'SELECT status FROM budget_items WHERE id=$1', [flexibleId])).rows[0]!.status, 'planned');
    await assert.rejects(assessPurchasePreview(client, randomUUID(), input, now),
      (error: { code?: string }) => error.code === 'RESOURCE_FORBIDDEN');
    await assert.rejects(assessPurchasePreview(client, fixture.ownerId,
      { ...input, expectedFinancialVersion: input.expectedFinancialVersion - 1 }, now),
    (error: { code?: string }) => error.code === 'VERSION_CONFLICT');
    await client.query('SAVEPOINT quote_withdrawal');
    await client.query("UPDATE offer_quotes SET status='withdrawn' WHERE id=$1", [quoteId]);
    await assert.rejects(assessPurchasePreview(client, fixture.ownerId, input, now),
      (error: { code?: string }) => error.code === 'QUOTE_STALE');
    await client.query('ROLLBACK TO SAVEPOINT quote_withdrawal');
    await assert.rejects(createConfirmedOrder(client, {
      id: fixture.ownerId, email: '', displayName: '', role: 'consumer',
    }, { confirmationId: randomUUID(), planItemId: randomUUID() }),
    (error: { code?: string }) => error.code === 'LEGACY_PURCHASE_DISABLED');

    app.addHook('preHandler', async (request) => {
      request.authUser = { id: fixture.ownerId, email: '', displayName: '', role: 'consumer' };
    });
    await app.register(registerFinanceAssessmentApi, {
      transaction: async <T>(run: (transactionClient: PoolClient) => Promise<T>) => run(client),
    });
    const request = { method: 'POST' as const, url: '/api/finance/assessments',
      headers: { origin: config.webOrigin, 'idempotency-key': 'a04-preview-key-0001' }, payload: input };
    const first = await app.inject(request);
    assert.equal(first.statusCode, 201);
    const replay = await app.inject(request);
    assert.equal(replay.statusCode, 201);
    assert.equal(replay.json().data.assessmentId, first.json().data.assessmentId);
    const conflict = await app.inject({ ...request, payload: { ...input, expectedQuoteVersion: 2 } });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error.code, 'IDEMPOTENCY_CONFLICT');

    const intentId = randomUUID();
    await client.query(`INSERT INTO purchase_intents
      (id,owner_id,period_id,budget_item_id,quote_id,assessment_id,
        financial_version,period_version,quote_version,expires_at,idempotency_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10)`, [
      intentId, fixture.ownerId, fixture.periodId, fixture.dinnerItemId, quoteId,
      preview.assessmentId, input.expectedFinancialVersion, input.expectedPeriodVersion,
      preview.expiresAt, 'a05-intent-0001',
    ]);
    const commitInput = { ownerId: fixture.ownerId, periodId: fixture.periodId,
      budgetItemId: fixture.dinnerItemId, quoteId, assessmentId: preview.assessmentId,
      purchaseIntentId: intentId, expectedFinancialVersion: input.expectedFinancialVersion,
      expectedPeriodVersion: input.expectedPeriodVersion, expectedQuoteVersion: 1,
      acceptedAmountMinor: 9900, confirmedByUser: true as const };
    await assert.rejects(commitPurchaseAssessment(client,
      { ...commitInput, acceptedAmountMinor: 8000 }, async () => randomUUID(), now),
    (error: { code?: string }) => error.code === 'QUOTE_STALE');
    await client.query('SAVEPOINT failed_commit');
    await assert.rejects(commitPurchaseAssessment(client, commitInput,
      async (sameClient, scope) => {
        await sameClient.query(`UPDATE purchase_intents
          SET status='confirmed',accepted_amount_minor=$2,confirmed_at=now()
          WHERE id=$1 AND owner_id=$3`,
        [scope.purchaseIntentId, scope.acceptedAmountMinor, scope.ownerId]);
        return randomUUID(); // B failed to write a scoped order: A must reject.
      }, now), (error: { code?: string }) => error.code === 'CONFIRMATION_SCOPE_MISMATCH');
    await client.query('ROLLBACK TO SAVEPOINT failed_commit');
    assert.equal((await client.query<{ status: string }>(
      'SELECT status FROM purchase_intents WHERE id=$1', [intentId])).rows[0]!.status, 'proposed');
    const committed = await commitPurchaseAssessment(client, commitInput, async (sameClient, scope) => {
      await sameClient.query(`UPDATE purchase_intents
        SET status='confirmed',accepted_amount_minor=$2,confirmed_at=now()
        WHERE id=$1 AND owner_id=$3 AND status='proposed'`,
      [scope.purchaseIntentId, scope.acceptedAmountMinor, scope.ownerId]);
      const orderId = randomUUID();
      await sameClient.query(`INSERT INTO orders
        (id,owner_id,budget_period_id,purchase_intent_id,item_name,amount_minor,
          simulation_mode,reserved_minor)
        VALUES($1,$2,$3,$4,'Demo 聚餐',$5,'SUCCESS',$5)`, [
        orderId, scope.ownerId, scope.periodId, scope.purchaseIntentId,
        scope.acceptedAmountMinor,
      ]);
      await sameClient.query(`UPDATE purchase_intents SET status='ordered'
        WHERE id=$1 AND owner_id=$2 AND status='confirmed'`, [scope.purchaseIntentId, scope.ownerId]);
      return orderId;
    }, now);
    assert.equal(committed.acceptedAmountMinor, 9900);
    const after = await forecastBudgetCashflow(client, fixture.ownerId, fixture.periodId, { now });
    assert.equal(after.forecast.status, 'allowed');
    assert.equal(after.forecast.minimumSavingsHeadroomMinor, 18100);
    const item = (await client.query<{ status: string }>('SELECT status FROM budget_items WHERE id=$1',
      [fixture.dinnerItemId])).rows[0]!;
    assert.equal(item.status, 'committed');
    await assert.rejects(assessAdjustmentOption(client, fixture.ownerId, fixture.periodId, {
      changes: [{ budgetItemId: fixture.dinnerItemId, action: 'cancel' }],
      expectedFinancialVersion: Number((await client.query<{ financialVersion: string }>(
        'SELECT financial_version AS "financialVersion" FROM finance_accounts WHERE id=$1',
        [fixture.accountId])).rows[0]!.financialVersion),
      expectedPeriodVersion: Number((await client.query<{ periodVersion: string }>(
        'SELECT version AS "periodVersion" FROM budget_periods WHERE id=$1',
        [fixture.periodId])).rows[0]!.periodVersion),
    }, now), (error: { code?: string }) => error.code === 'ITEM_NOT_ORDERABLE');
    await assert.rejects(commitPurchaseAssessment(client, commitInput,
      async () => randomUUID(), now), (error: { code?: string }) => error.code === 'VERSION_CONFLICT');

    await client.query('SAVEPOINT immutable_check');
    await assert.rejects(client.query(`UPDATE funding_assessments SET status='blocked' WHERE id=$1`,
      [preview.assessmentId]));
    await client.query('ROLLBACK TO SAVEPOINT immutable_check');
  } finally {
    await app.close();
    await client.query('ROLLBACK');
    client.release();
  }
});
