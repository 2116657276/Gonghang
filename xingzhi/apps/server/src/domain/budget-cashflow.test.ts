import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import type { PoolClient } from 'pg';
import { config } from '../config.js';
import { pool, closePool } from '../db/client.js';
import { seedConsumerFinanceDemo } from '../db/consumer-finance-demo.js';
import { registerPlanningDraftApi } from '../routes/planning-drafts.js';
import { loadFinanceAccountFacts } from './finance-facts.js';
import { forecastBudgetCashflow, previewBudgetItemChange, previewBudgetItemImpact } from './budget-cashflow.js';
import { budgetPlanningDraftPort } from './budget-planning-draft-port.js';

test('A03 reads one owned period, evaluates B02 drafts and never writes budget/order facts', async () => {
  const client = await pool.connect();
  const app = Fastify();
  try {
    await client.query('BEGIN');
    const fixture = await seedConsumerFinanceDemo(client);
    const snapshot = (await client.query<{ as_of: Date }>(
      'SELECT as_of FROM finance_account_snapshots WHERE id=$1', [fixture.snapshotId],
    )).rows[0]!;
    const now = new Date(snapshot.as_of.getTime() + 1000);
    const facts = await loadFinanceAccountFacts(client, fixture.ownerId, fixture.accountId, now);
    const periodVersion = Number((await client.query<{ version: string }>(
      'SELECT version FROM budget_periods WHERE id=$1', [fixture.periodId],
    )).rows[0]!.version);
    const financialVersion = facts.account.financialVersion;
    const itemCount = Number((await client.query<{ count: string }>(
      'SELECT count(*) FROM budget_items WHERE period_id=$1', [fixture.periodId],
    )).rows[0]!.count);
    const assessmentCount = Number((await client.query<{ count: string }>(
      'SELECT count(*) FROM funding_assessments WHERE period_id=$1', [fixture.periodId],
    )).rows[0]!.count);
    const orderCount = Number((await client.query<{ count: string }>(
      'SELECT count(*) FROM orders',
    )).rows[0]!.count);

    const month = await forecastBudgetCashflow(client, fixture.ownerId, fixture.periodId, {
      expectedFinancialVersion: financialVersion, expectedPeriodVersion: periodVersion, now,
    });
    assert.equal(month.forecast.status, 'allowed');
    assert.equal(month.forecast.minimumSavingsHeadroomMinor, 20000);
    assert.equal(month.forecast.periodEndSavableMinor, 70000);
    assert.equal(month.forecast.daily.at(-1)?.on, fixture.monthEnd);
    const dinnerId = (await client.query<{ id: string }>(`SELECT id FROM budget_items
      WHERE period_id=$1 AND owner_id=$2 AND title='朋友聚餐'`,
    [fixture.periodId, fixture.ownerId])).rows[0]!.id;
    const itemImpact = await previewBudgetItemImpact(client, fixture.ownerId, fixture.periodId, dinnerId);
    assert.equal(itemImpact.withItem.minimumSavingsHeadroomMinor, 20000);
    assert.equal(itemImpact.withoutItem.minimumSavingsHeadroomMinor, 28000);
    const changed = await previewBudgetItemChange(client, fixture.ownerId, fixture.periodId, {
      periodId: fixture.periodId, itemId: dinnerId, expectedPeriodVersion: periodVersion,
      expectedFinancialVersion: financialVersion, kind: 'planned_spend', title: '朋友聚餐',
      categoryCode: null, plannedOn: fixture.monthEnd, userEstimatedAmountMinor: 4000,
      priority: 'adjustable', changeReason: '缩减本月聚餐预算',
    });
    assert.equal(changed.before.minimumSavingsHeadroomMinor, 20000);
    assert.equal(changed.after.minimumSavingsHeadroomMinor, 24000);
    assert.equal(Number((await client.query<{ count: string }>(
      'SELECT count(*) FROM budget_items WHERE period_id=$1', [fixture.periodId],
    )).rows[0]!.count), itemCount);
    await client.query('SAVEPOINT empty_profile');
    const emptyAccountId = randomUUID();
    const emptySnapshotId = randomUUID();
    const emptyPeriodId = randomUUID();
    await client.query(`INSERT INTO finance_accounts
      (id,owner_id,provider,account_type,provider_account_ref,masked_identifier,display_name,source,authorized_at)
      VALUES($1,$2,'demo','debit',$3,'****EMPTY','未填必要支出账户','demo',$4)`,
    [emptyAccountId, fixture.ownerId, randomUUID(), now]);
    await client.query(`INSERT INTO finance_account_snapshots
      (id,account_id,available_balance_minor,as_of,covered_through_at,fact_status,source)
      VALUES($1,$2,200000,$3,$3,'observed','demo')`, [emptySnapshotId, emptyAccountId, now]);
    await client.query(`INSERT INTO budget_periods
      (id,owner_id,primary_account_id,baseline_snapshot_id,month_start,month_end,savings_target_minor,status)
      VALUES($1,$2,$3,$4,$5,$6,50000,'active')`, [
      emptyPeriodId, fixture.ownerId, emptyAccountId, emptySnapshotId,
      fixture.monthStart, fixture.monthEnd,
    ]);
    const emptyProfile = await forecastBudgetCashflow(client, fixture.ownerId, emptyPeriodId, { now });
    assert.equal(emptyProfile.forecast.status, 'unknown');
    assert.ok(emptyProfile.forecast.reasonCodes.includes('BUDGET_NECESSITIES_UNCONFIRMED'));
    await client.query('ROLLBACK TO SAVEPOINT empty_profile');
    const proposal = [{
      title: '额外小吃', plannedOn: fixture.monthEnd, userEstimatedAmountMinor: 1000,
      priority: 'adjustable' as const, requirements: [], catalogItemId: null, suggestion: null,
    }];
    const assessment = await forecastBudgetCashflow(client, fixture.ownerId, fixture.periodId, {
      expectedFinancialVersion: financialVersion, expectedPeriodVersion: periodVersion,
      proposedItems: proposal, now,
    });
    assert.equal(assessment.forecast.status, 'allowed');
    assert.equal(assessment.forecast.minimumSavingsHeadroomMinor, 19000);
    await assert.rejects(forecastBudgetCashflow(client, fixture.ownerId, fixture.periodId, {
      expectedFinancialVersion: financialVersion - 1, expectedPeriodVersion: periodVersion, now,
    }), (error: { code?: string }) => error.code === 'VERSION_CONFLICT');
    await assert.rejects(forecastBudgetCashflow(client, randomUUID(), fixture.periodId, { now }),
      (error: { code?: string }) => error.code === 'RESOURCE_FORBIDDEN');

    const incompleteProposal = [{ ...proposal[0]!, userEstimatedAmountMinor: null }];
    const unknown = await forecastBudgetCashflow(client, fixture.ownerId, fixture.periodId, {
      expectedFinancialVersion: financialVersion, expectedPeriodVersion: periodVersion,
      proposedItems: incompleteProposal, now,
    });
    assert.equal(unknown.forecast.status, 'unknown');
    assert.equal(unknown.forecast.shortfallMinor, null);
    const rolling = await forecastBudgetCashflow(client, fixture.ownerId, fixture.periodId,
      { rolling30: true, now });
    if (rolling.forecast.daily.at(-1)!.on > fixture.monthEnd) {
      assert.equal(rolling.forecast.status, 'unknown');
      assert.ok(rolling.forecast.reasonCodes.includes('ADJACENT_PERIOD_UNKNOWN'));
      await client.query('SAVEPOINT adjacent');
      const nextMonthStart = new Date(`${fixture.monthStart}T00:00:00Z`);
      nextMonthStart.setUTCMonth(nextMonthStart.getUTCMonth() + 1);
      const nextMonthStartText = nextMonthStart.toISOString().slice(0, 10);
      const followingMonth = new Date(nextMonthStart);
      followingMonth.setUTCMonth(followingMonth.getUTCMonth() + 1);
      followingMonth.setUTCDate(0);
      const nextMonthEndText = followingMonth.toISOString().slice(0, 10);
      const existingNext = await client.query('SELECT 1 FROM budget_periods WHERE owner_id=$1 AND primary_account_id=$2 AND month_start=$3::date',
        [fixture.ownerId, fixture.accountId, nextMonthStartText]);
      if (!existingNext.rowCount) {
        const nextPeriodId = randomUUID();
        await client.query(`INSERT INTO budget_periods
          (id,owner_id,primary_account_id,baseline_snapshot_id,month_start,month_end,savings_target_minor,status)
          VALUES($1,$2,$3,$4,$5,$6,60000,'active')`, [
          nextPeriodId, fixture.ownerId, fixture.accountId, fixture.snapshotId,
          nextMonthStartText, nextMonthEndText,
        ]);
        await client.query(`INSERT INTO budget_items
          (id,owner_id,period_id,account_id,kind,title,planned_on,user_estimated_amount_minor,priority)
          VALUES($1,$2,$3,$4,'planned_spend','下月目标',$5,10000,'adjustable')`, [
          randomUUID(), fixture.ownerId, nextPeriodId, fixture.accountId, nextMonthStartText,
        ]);
        await client.query(`INSERT INTO budget_items
          (id,owner_id,period_id,account_id,kind,title,planned_on,user_estimated_amount_minor,priority)
          VALUES($1,$2,$3,$4,'expected_income','下月预计收入',$5,100000,'required')`, [
          randomUUID(), fixture.ownerId, nextPeriodId, fixture.accountId, nextMonthStartText,
        ]);
        const covered = await forecastBudgetCashflow(client, fixture.ownerId, fixture.periodId,
          { rolling30: true, now });
        assert.equal(covered.forecast.status, 'allowed');
        assert.equal(covered.forecast.periodEndCashMinor, 60000);
        assert.equal(covered.forecast.minimumSavingsHeadroomMinor, 0);
        assert.equal(covered.conditionalIncomeMinor, 100000); // Display-only.
      }
      await client.query('ROLLBACK TO SAVEPOINT adjacent');
    }
    await client.query('SAVEPOINT revoked');
    await client.query(`UPDATE finance_accounts SET status='revoked',revoked_at=now() WHERE id=$1`,
      [fixture.accountId]);
    await assert.rejects(forecastBudgetCashflow(client, fixture.ownerId, fixture.periodId, { now }),
      (error: { code?: string }) => error.code === 'FINANCE_SCOPE_REVOKED');
    await client.query('ROLLBACK TO SAVEPOINT revoked');

    app.addHook('preHandler', async (request) => {
      request.authUser = { id: fixture.ownerId, email: '', displayName: '', role: 'consumer' };
    });
    const runCurrent = async <T>(run: (transactionClient: PoolClient) => Promise<T>) => run(client);
    await app.register(registerPlanningDraftApi, {
      planningDraftPort: budgetPlanningDraftPort, db: client, transaction: runCurrent,
    });
    const liveAssessment = await forecastBudgetCashflow(client, fixture.ownerId, fixture.periodId, {
      expectedFinancialVersion: financialVersion, expectedPeriodVersion: periodVersion,
      proposedItems: proposal,
    });
    const created = await app.inject({ method: 'POST', url: '/api/ai/planning-drafts',
      headers: { origin: config.webOrigin, 'idempotency-key': 'a03-b02-draft-0001' },
      payload: { periodId: fixture.periodId, expectedFinancialVersion: financialVersion,
        expectedPeriodVersion: periodVersion, items: proposal },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().data.assessment.status, liveAssessment.forecast.status);
    assert.equal(created.json().data.assessment.shortfallMinor, liveAssessment.forecast.shortfallMinor);
    assert.equal(Number((await client.query<{ count: string }>(
      'SELECT count(*) FROM budget_items WHERE period_id=$1', [fixture.periodId],
    )).rows[0]!.count), itemCount);
    assert.equal(Number((await client.query<{ count: string }>(
      'SELECT count(*) FROM funding_assessments WHERE period_id=$1', [fixture.periodId],
    )).rows[0]!.count), assessmentCount);
    assert.equal(Number((await client.query<{ count: string }>(
      'SELECT count(*) FROM orders',
    )).rows[0]!.count), orderCount);
  } finally {
    await app.close();
    await client.query('ROLLBACK');
    client.release();
    await closePool();
  }
});
