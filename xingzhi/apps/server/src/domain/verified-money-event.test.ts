import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import type { PoolClient } from 'pg';
import { config } from '../config.js';
import { pool, closePool } from '../db/client.js';
import { seedConsumerFinanceDemo } from '../db/consumer-finance-demo.js';
import { registerBudgetPeriodReviewApi } from '../routes/budget-period-review.js';
import { assessPurchasePreview } from './purchase-assessment.js';
import { commitPurchaseAssessment } from './purchase-commit.js';
import { applyVerifiedMoneyEvent } from './verified-money-event.js';
import { reviewBudgetPeriod } from './budget-period-review.js';
import { forecastBudgetCashflow } from './budget-cashflow.js';
import { loadFinanceAccountFacts } from './finance-facts.js';

test('A06 distinguishes provider results from verified account postings and reviews late settlement', async () => {
  const client = await pool.connect();
  const app = Fastify();
  try {
    await client.query('BEGIN');
    const now = new Date();
    const fixture = await seedConsumerFinanceDemo(client, now);
    const merchantId = (await client.query<{ id: string }>(
      "SELECT id FROM users WHERE role='merchant_admin' ORDER BY id LIMIT 1",
    )).rows[0]!.id;
    const catalogId = randomUUID();
    const quoteId = randomUUID();
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
    await client.query(`INSERT INTO catalog_items
      (id,merchant_id,code,name,kind,description,price_minor,rule_label,
        simulation_mode,purchase_mode,category_code)
      VALUES($1,$2,$3,'Demo 聚餐','food','A06 订单证据测试',9900,'测试规则',
        'SUCCESS','orderable','food')`, [catalogId, merchantId, `A06-${randomUUID()}`]);
    await client.query(`INSERT INTO offer_quotes
      (id,catalog_item_id,provider,quote_source,quote_version,price_minor,
        service_on,rule_version,rule_snapshot,valid_until)
      VALUES($1,$2,'simulation','demo',1,9900,$3::date,1,'{}'::jsonb,$4)`,
    [quoteId, catalogId, today, new Date(now.getTime() + 60 * 60_000)]);
    const versions = (await client.query<{ financialVersion: string; periodVersion: string }>(`SELECT
      a.financial_version AS "financialVersion",p.version AS "periodVersion"
      FROM finance_accounts a JOIN budget_periods p ON p.primary_account_id=a.id
      WHERE p.id=$1`, [fixture.periodId])).rows[0]!;
    const preview = await assessPurchasePreview(client, fixture.ownerId, {
      periodId: fixture.periodId, budgetItemId: fixture.dinnerItemId, quoteId,
      expectedFinancialVersion: Number(versions.financialVersion),
      expectedPeriodVersion: Number(versions.periodVersion), expectedQuoteVersion: 1,
      mode: 'preview',
    }, now);
    assert.equal(preview.status, 'allowed');
    const intentId = randomUUID();
    await client.query(`INSERT INTO purchase_intents
      (id,owner_id,period_id,budget_item_id,quote_id,assessment_id,
        financial_version,period_version,quote_version,expires_at,idempotency_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10)`, [
      intentId, fixture.ownerId, fixture.periodId, fixture.dinnerItemId, quoteId,
      preview.assessmentId, preview.financialVersion, preview.periodVersion,
      preview.expiresAt, 'a06-intent-0001',
    ]);
    const committed = await commitPurchaseAssessment(client, {
      ownerId: fixture.ownerId, periodId: fixture.periodId,
      budgetItemId: fixture.dinnerItemId, quoteId, assessmentId: preview.assessmentId,
      purchaseIntentId: intentId, expectedFinancialVersion: preview.financialVersion,
      expectedPeriodVersion: preview.periodVersion, expectedQuoteVersion: 1,
      acceptedAmountMinor: 9900, confirmedByUser: true,
    }, async (sameClient, scope) => {
      await sameClient.query(`UPDATE purchase_intents
        SET status='confirmed',accepted_amount_minor=$2,confirmed_at=now()
        WHERE id=$1 AND owner_id=$3`,
      [scope.purchaseIntentId, scope.acceptedAmountMinor, scope.ownerId]);
      const orderId = randomUUID();
      await sameClient.query(`INSERT INTO orders
        (id,owner_id,budget_period_id,purchase_intent_id,item_name,amount_minor,
          simulation_mode,reserved_minor)
        VALUES($1,$2,$3,$4,'Demo 聚餐',9900,'SUCCESS',9900)`,
      [orderId, scope.ownerId, scope.periodId, scope.purchaseIntentId]);
      await sameClient.query(`UPDATE purchase_intents SET status='ordered' WHERE id=$1`,
        [scope.purchaseIntentId]);
      return orderId;
    }, now);
    const pending = { orderId: committed.orderId, provider: 'simulation',
      providerEventId: `pending-${randomUUID()}`, eventType: 'payment_pending' as const,
      amountMinor: 9900, currency: 'CNY' as const, occurredAt: now.toISOString(),
      verificationState: 'unverified' as const, source: 'demo' as const };
    const first = await applyVerifiedMoneyEvent(client, fixture.ownerId, pending, {}, now);
    const replay = await applyVerifiedMoneyEvent(client, fixture.ownerId, pending, {}, now);
    assert.equal(first.eventId, replay.eventId);
    assert.equal(replay.reused, true);
    const before = await reviewBudgetPeriod(client, fixture.ownerId, fixture.periodId, now);
    assert.equal(before.confirmedOrderPaymentsMinor, 0);
    assert.equal(before.currentConfirmedCashMinor, 200000);
    await assert.rejects(applyVerifiedMoneyEvent(client, fixture.ownerId,
      { ...pending, providerEventId: `fake-bank-${randomUUID()}`,
        eventType: 'payment_posted', verificationState: 'verified', source: 'bank_api' },
      { appliedLedgerEntryId: randomUUID() }, now),
    (error: { code?: string }) => error.code === 'CONFIRMATION_SCOPE_MISMATCH');
    await assert.rejects(applyVerifiedMoneyEvent(client, fixture.ownerId,
      { ...pending, providerEventId: `no-ledger-${randomUUID()}`,
        eventType: 'payment_posted', verificationState: 'verified' }, {}, now),
    (error: { code?: string }) => error.code === 'FINANCE_BASIS_UNKNOWN');

    const debitId = randomUUID();
    const paidAt = new Date(now.getTime() + 1000);
    const checkedAt = new Date(now.getTime() + 2000);
    await client.query(`INSERT INTO finance_ledger_entries
      (id,owner_id,account_id,source,source_ref,direction,amount_minor,
        occurred_at,posted_at,status,category,order_id,dedupe_key)
      VALUES($1,$2,$3,'demo',$4,'outflow',9900,$5,$5,'posted','food',$6,$7)`, [
      debitId, fixture.ownerId, fixture.accountId, `simulation-debit-${debitId}`,
      paidAt, committed.orderId, `a06-debit-${debitId}`,
    ]);
    const postedPayment = { ...pending, providerEventId: `paid-${randomUUID()}`,
      eventType: 'payment_posted' as const, verificationState: 'verified' as const,
      occurredAt: paidAt.toISOString() };
    const payment = await applyVerifiedMoneyEvent(client, fixture.ownerId, postedPayment,
      { appliedLedgerEntryId: debitId }, checkedAt);
    assert.equal(payment.appliedLedgerEntryId, debitId);
    await client.query('SAVEPOINT direct_money_guard');
    await assert.rejects(client.query(`INSERT INTO finance_money_events
      (id,owner_id,order_id,provider,provider_event_id,event_type,amount_minor,
        occurred_at,verification_state,source,applied_ledger_entry_id)
      VALUES($1,$2,$3,'simulation',$4,'payment_posted',9900,$5,'verified','bank_api',$6)`, [
      randomUUID(), fixture.ownerId, committed.orderId,
      `forged-source-${randomUUID()}`, paidAt, debitId,
    ]));
    await client.query('ROLLBACK TO SAVEPOINT direct_money_guard');
    assert.equal((await applyVerifiedMoneyEvent(client, fixture.ownerId, postedPayment,
      { appliedLedgerEntryId: debitId }, checkedAt)).reused, true);
    assert.equal((await client.query<{ status: string }>(
      'SELECT status FROM budget_items WHERE id=$1', [fixture.dinnerItemId])).rows[0]!.status, 'settled');
    await assert.rejects(applyVerifiedMoneyEvent(client, fixture.ownerId,
      { ...postedPayment, providerEventId: `duplicate-paid-${randomUUID()}` },
      { appliedLedgerEntryId: debitId }, checkedAt),
    (error: { code?: string }) => error.code === 'IDEMPOTENCY_CONFLICT');
    const afterPayment = await reviewBudgetPeriod(client, fixture.ownerId, fixture.periodId, checkedAt);
    assert.equal(afterPayment.confirmedOrderPaymentsMinor, 9900);
    assert.equal(afterPayment.confirmedPeriodOutflowMinor, 9900);
    assert.equal(afterPayment.currentConfirmedCashMinor, 190100);
    const afterForecast = await forecastBudgetCashflow(client, fixture.ownerId, fixture.periodId,
      { now: checkedAt });
    assert.equal(afterForecast.forecast.minimumSavingsHeadroomMinor, 18100);

    const requested = { ...pending, providerEventId: `refund-request-${randomUUID()}`,
      eventType: 'refund_requested' as const, amountMinor: 3000,
      occurredAt: checkedAt.toISOString() };
    await applyVerifiedMoneyEvent(client, fixture.ownerId, requested, {}, checkedAt);
    await applyVerifiedMoneyEvent(client, fixture.ownerId, {
      ...requested, providerEventId: `refund-verified-${randomUUID()}`,
      eventType: 'refund_verified', verificationState: 'verified',
    }, {}, checkedAt);
    const beforeRefund = await reviewBudgetPeriod(client, fixture.ownerId, fixture.periodId, checkedAt);
    assert.equal(beforeRefund.refundAwaitingArrivalMinor, 3000);
    assert.equal(beforeRefund.confirmedRefundReceivedMinor, 0);
    assert.equal(beforeRefund.currentConfirmedCashMinor, 190100);
    const refundId = randomUUID();
    const refundAt = new Date(now.getTime() + 3000);
    const refundCheckedAt = new Date(now.getTime() + 4000);
    await client.query(`INSERT INTO finance_ledger_entries
      (id,owner_id,account_id,source,source_ref,direction,amount_minor,
        occurred_at,posted_at,status,category,order_id,dedupe_key)
      VALUES($1,$2,$3,'demo',$4,'inflow',3000,$5,$5,'posted','refund',$6,$7)`, [
      refundId, fixture.ownerId, fixture.accountId, `simulation-refund-${refundId}`,
      refundAt, committed.orderId, `a06-refund-${refundId}`,
    ]);
    const postedRefund = { ...requested, providerEventId: `refund-posted-${randomUUID()}`,
      eventType: 'refund_posted' as const, verificationState: 'verified' as const,
      occurredAt: refundAt.toISOString() };
    await applyVerifiedMoneyEvent(client, fixture.ownerId, postedRefund,
      { appliedLedgerEntryId: refundId }, refundCheckedAt);
    const afterRefund = await reviewBudgetPeriod(client, fixture.ownerId,
      fixture.periodId, refundCheckedAt);
    assert.equal(afterRefund.confirmedRefundReceivedMinor, 3000);
    assert.equal(afterRefund.refundAwaitingArrivalMinor, 0);
    assert.equal(afterRefund.currentConfirmedCashMinor, 193100);

    await client.query('SAVEPOINT linked_immutable');
    await assert.rejects(client.query(`UPDATE finance_ledger_entries SET status='reversed' WHERE id=$1`,
      [debitId]));
    await client.query('ROLLBACK TO SAVEPOINT linked_immutable');
    await client.query('SAVEPOINT order_immutable');
    await assert.rejects(client.query('UPDATE orders SET amount_minor=10900 WHERE id=$1',
      [committed.orderId]));
    await client.query('ROLLBACK TO SAVEPOINT order_immutable');

    const sandboxCatalogId = randomUUID();
    const sandboxQuoteId = randomUUID();
    const flexibleId = (await client.query<{ id: string }>(`SELECT id FROM budget_items
      WHERE period_id=$1 AND owner_id=$2 AND title='其他可调生活开支'`,
    [fixture.periodId, fixture.ownerId])).rows[0]!.id;
    await client.query(`INSERT INTO catalog_items
      (id,merchant_id,code,name,kind,description,price_minor,rule_label,
        simulation_mode,purchase_mode)
      VALUES($1,$2,$3,'沙盒候选','activity','沙盒不等于账户到账',5000,'测试规则',
        'SUCCESS','orderable')`, [sandboxCatalogId, merchantId, `A06-SBX-${randomUUID()}`]);
    await client.query(`INSERT INTO offer_quotes
      (id,catalog_item_id,provider,quote_source,quote_version,price_minor,
        service_on,rule_version,rule_snapshot,valid_until)
      VALUES($1,$2,'alipay','demo',1,5000,$3::date,1,'{}'::jsonb,$4)`,
    [sandboxQuoteId, sandboxCatalogId, fixture.monthEnd, new Date(now.getTime() + 60 * 60_000)]);
    const freshVersions = (await client.query<{ financialVersion: string; periodVersion: string }>(`SELECT
      a.financial_version AS "financialVersion",p.version AS "periodVersion"
      FROM finance_accounts a JOIN budget_periods p ON p.primary_account_id=a.id
      WHERE p.id=$1`, [fixture.periodId])).rows[0]!;
    const sandboxPreview = await assessPurchasePreview(client, fixture.ownerId, {
      periodId: fixture.periodId, budgetItemId: flexibleId, quoteId: sandboxQuoteId,
      expectedFinancialVersion: Number(freshVersions.financialVersion),
      expectedPeriodVersion: Number(freshVersions.periodVersion),
      expectedQuoteVersion: 1, mode: 'preview',
    }, refundCheckedAt);
    assert.equal(sandboxPreview.status, 'allowed');
    const sandboxIntentId = randomUUID();
    await client.query(`INSERT INTO purchase_intents
      (id,owner_id,period_id,budget_item_id,quote_id,assessment_id,
        financial_version,period_version,quote_version,expires_at,idempotency_key)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10)`, [
      sandboxIntentId, fixture.ownerId, fixture.periodId, flexibleId,
      sandboxQuoteId, sandboxPreview.assessmentId, sandboxPreview.financialVersion,
      sandboxPreview.periodVersion, sandboxPreview.expiresAt, 'a06-sandbox-intent-0001',
    ]);
    const sandbox = await commitPurchaseAssessment(client, {
      ownerId: fixture.ownerId, periodId: fixture.periodId, budgetItemId: flexibleId,
      quoteId: sandboxQuoteId, assessmentId: sandboxPreview.assessmentId,
      purchaseIntentId: sandboxIntentId,
      expectedFinancialVersion: sandboxPreview.financialVersion,
      expectedPeriodVersion: sandboxPreview.periodVersion, expectedQuoteVersion: 1,
      acceptedAmountMinor: 5000, confirmedByUser: true,
    }, async (sameClient, scope) => {
      await sameClient.query(`UPDATE purchase_intents
        SET status='confirmed',accepted_amount_minor=5000,confirmed_at=now()
        WHERE id=$1`, [scope.purchaseIntentId]);
      const orderId = randomUUID();
      await sameClient.query(`INSERT INTO orders
        (id,owner_id,budget_period_id,purchase_intent_id,item_name,amount_minor,
          environment,provider,simulation_mode,reserved_minor)
        VALUES($1,$2,$3,$4,'沙盒候选',5000,'sandbox','alipay','UNKNOWN',5000)`,
      [orderId, scope.ownerId, scope.periodId, scope.purchaseIntentId]);
      await sameClient.query(`UPDATE purchase_intents SET status='ordered' WHERE id=$1`,
        [scope.purchaseIntentId]);
      return orderId;
    }, refundCheckedAt);
    const sandboxPending = { orderId: sandbox.orderId, provider: 'alipay',
      providerEventId: `alipay-pending-${randomUUID()}`, eventType: 'payment_pending' as const,
      amountMinor: 5000, currency: 'CNY' as const,
      occurredAt: refundCheckedAt.toISOString(), verificationState: 'unverified' as const,
      source: 'demo' as const };
    await applyVerifiedMoneyEvent(client, fixture.ownerId, sandboxPending, {}, refundCheckedAt);
    await assert.rejects(applyVerifiedMoneyEvent(client, fixture.ownerId, {
      ...sandboxPending, providerEventId: `alipay-receipt-${randomUUID()}`,
      eventType: 'payment_posted', verificationState: 'verified',
    }, { appliedLedgerEntryId: debitId }, refundCheckedAt),
    (error: { code?: string }) => error.code === 'CONFIRMATION_SCOPE_MISMATCH');
    assert.equal((await reviewBudgetPeriod(client, fixture.ownerId,
      fixture.periodId, refundCheckedAt)).currentConfirmedCashMinor, 193100);

    const targetBeforeChange = (await client.query<{ version: string }>(
      'SELECT version FROM budget_periods WHERE id=$1', [fixture.periodId])).rows[0]!.version;
    await client.query(`INSERT INTO budget_target_changes
      (id,owner_id,period_id,confirmed_by,previous_target_minor,new_target_minor,
        reason,basis_period_version)
      VALUES($1,$2,$3,$2,50000,40000,'测试本人调低储蓄目标',$4)`,
    [randomUUID(), fixture.ownerId, fixture.periodId, targetBeforeChange]);
    await client.query(`UPDATE budget_periods SET savings_target_minor=40000
      WHERE id=$1 AND owner_id=$2`, [fixture.periodId, fixture.ownerId]);

    await client.query(`UPDATE budget_periods SET status='closed',closed_at=now()
      WHERE id=$1 AND owner_id=$2`, [fixture.periodId, fixture.ownerId]);
    const lateRefundId = randomUUID();
    const lateAt = new Date(now.getTime() + 5000);
    const lateCheckedAt = new Date(now.getTime() + 6000);
    await client.query(`INSERT INTO finance_ledger_entries
      (id,owner_id,account_id,source,source_ref,direction,amount_minor,
        occurred_at,posted_at,status,category,order_id,dedupe_key)
      VALUES($1,$2,$3,'demo',$4,'inflow',1000,$5,$5,'posted','food',$6,$7)`, [
      lateRefundId, fixture.ownerId, fixture.accountId, `late-refund-${lateRefundId}`,
      lateAt, committed.orderId, `a06-late-refund-${lateRefundId}`,
    ]);
    await applyVerifiedMoneyEvent(client, fixture.ownerId, {
      ...requested, providerEventId: `late-posted-${randomUUID()}`,
      eventType: 'refund_posted', amountMinor: 1000,
      verificationState: 'verified', occurredAt: lateAt.toISOString(),
    }, { appliedLedgerEntryId: lateRefundId }, lateCheckedAt);
    const closed = await reviewBudgetPeriod(client, fixture.ownerId, fixture.periodId, lateCheckedAt);
    assert.equal(closed.reviewStatus, 'unknown');
    assert.ok(closed.unknownIssues.includes('CLOSING_SNAPSHOT_MISSING'));
    assert.equal(closed.confirmedRefundReceivedMinor, 4000);
    assert.equal(closed.periodEndUnspentCashMinor, null);
    assert.equal(closed.originalSavingsTargetMinor, 50000);
    assert.equal(closed.currentSavingsTargetMinor, 40000);
    assert.equal(closed.targetChangeCount, 1);
    const factsWithPostedRefund = await loadFinanceAccountFacts(client,
      fixture.ownerId, fixture.accountId, lateCheckedAt);
    assert.equal(factsWithPostedRefund.ledger.find((row) => row.entryId === lateRefundId)?.isRefund, true,
      '已入账 refund_posted 事实应识别原分类为 food 的退款流水');

    await client.query(`UPDATE orders SET payment_status='paid',reserved_minor=0
      WHERE id=$1`, [committed.orderId]);
    await client.query(`UPDATE orders SET payment_status='failed',reserved_minor=0
      WHERE id=$1`, [sandbox.orderId]);
    const closingCutoff = new Date(`${fixture.monthEnd}T16:00:00Z`);
    await client.query(`INSERT INTO finance_account_snapshots
      (id,account_id,available_balance_minor,as_of,covered_through_at,
        fact_status,source,provider_snapshot_ref)
      VALUES($1,$2,60000,$3,$3,'observed','demo',$4)`, [
      randomUUID(), fixture.accountId, closingCutoff, `a06-closing-${randomUUID()}`,
    ]);
    const complete = await reviewBudgetPeriod(client, fixture.ownerId,
      fixture.periodId, new Date(closingCutoff.getTime() + 1000));
    assert.equal(complete.reviewStatus, 'complete');
    assert.equal(complete.periodEndUnspentCashMinor, 60000);
    assert.equal(complete.periodEndTargetGapMinor, 0);
    assert.equal(complete.originalSavingsTargetMinor, 50000);
    await client.query('SAVEPOINT target_audit');
    await client.query(`UPDATE budget_periods SET savings_target_minor=50000 WHERE id=$1`,
      [fixture.periodId]);
    const mismatched = await reviewBudgetPeriod(client, fixture.ownerId,
      fixture.periodId, new Date(closingCutoff.getTime() + 1000));
    assert.equal(mismatched.reviewStatus, 'unknown');
    assert.ok(mismatched.unknownIssues.includes('TARGET_AUDIT_MISMATCH'));
    await client.query('ROLLBACK TO SAVEPOINT target_audit');
    await assert.rejects(reviewBudgetPeriod(client, randomUUID(), fixture.periodId, refundCheckedAt),
      (error: { code?: string }) => error.code === 'RESOURCE_FORBIDDEN');

    app.addHook('preHandler', async (request) => {
      if (request.headers['x-test-role'] === 'none') return;
      request.authUser = { id: fixture.ownerId, email: '', displayName: '',
        role: request.headers['x-test-role'] === 'reviewer' ? 'reviewer' : 'consumer' };
    });
    await app.register(registerBudgetPeriodReviewApi, { db: client });
    assert.equal((await app.inject({ method: 'GET', url: `/api/budget-periods/${fixture.periodId}/review`,
      headers: { 'x-test-role': 'none' } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: `/api/budget-periods/${fixture.periodId}/review`,
      headers: { 'x-test-role': 'reviewer' } })).statusCode, 403);
    const response = await app.inject({ method: 'GET',
      url: `/api/budget-periods/${fixture.periodId}/review` });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.confirmedRefundReceivedMinor,
      (await reviewBudgetPeriod(client, fixture.ownerId, fixture.periodId)).confirmedRefundReceivedMinor);
    assert.equal(response.json().data.accountSource, 'demo');
  } finally {
    await app.close();
    await client.query('ROLLBACK');
    client.release();
    await closePool();
  }
});
