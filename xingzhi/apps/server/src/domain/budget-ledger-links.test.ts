import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { pool, closePool } from '../db/client.js';
import { seedConsumerFinanceDemo } from '../db/consumer-finance-demo.js';
import { forecastBudgetCashflow } from './budget-cashflow.js';
import { readBudgetLedgerLinks, linkBudgetLedgerEntry, unlinkBudgetLedgerEntry } from './budget-ledger-links.js';
import { reviewBudgetPeriod } from './budget-period-review.js';

test('F3.3 links posted expense once, releases only remaining plan and preserves unlink history', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fixture = await seedConsumerFinanceDemo(client);
    const snapshot = (await client.query<{ asOf: Date }>(
      'SELECT as_of AS "asOf" FROM finance_account_snapshots WHERE id=$1',
      [fixture.snapshotId])).rows[0]!;
    // A pristine Demo fixture can be reused after it was seeded earlier today.
    // Keep the review instant after both the posting and this test's new links.
    const now = new Date(Math.max(Date.now() + 5000, snapshot.asOf.getTime() + 3000));
    const before = await forecastBudgetCashflow(client, fixture.ownerId, fixture.periodId, { now });
    const entryId = randomUUID();
    const postedAt = new Date(snapshot.asOf.getTime() + 1000);
    await client.query(`INSERT INTO finance_ledger_entries
      (id,owner_id,account_id,source,direction,amount_minor,occurred_at,posted_at,
        status,category,dedupe_key) VALUES($1,$2,$3,'demo','outflow',2500,$4,$4,
        'posted','food',$5)`, [entryId, fixture.ownerId, fixture.accountId, postedAt, randomUUID()]);
    const basis = await readBudgetLedgerLinks(client, fixture.ownerId, fixture.periodId);
    const result = await linkBudgetLedgerEntry(client, fixture.ownerId, fixture.periodId, {
      entryId, itemId: fixture.dinnerItemId, coveredMinor: 2500,
      expectedFinancialVersion: basis.financialVersion,
      expectedPeriodVersion: basis.periodVersion, confirmedByUser: true,
    });
    assert.equal(result.links.filter((link) => link.active).length, 1);
    assert.equal(result.items.find((item) => item.itemId === fixture.dinnerItemId)?.remainingMinor, 5500);
    await assert.rejects(linkBudgetLedgerEntry(client, fixture.ownerId, fixture.periodId, {
      entryId, itemId: fixture.dinnerItemId, coveredMinor: 100,
      expectedFinancialVersion: result.financialVersion,
      expectedPeriodVersion: result.periodVersion, confirmedByUser: true,
    }), (error: { code?: string }) => error.code === 'VERSION_CONFLICT');
    const after = await forecastBudgetCashflow(client, fixture.ownerId, fixture.periodId, { now });
    assert.equal(after.forecast.minimumSavingsHeadroomMinor, before.forecast.minimumSavingsHeadroomMinor);
    const review = await reviewBudgetPeriod(client, fixture.ownerId, fixture.periodId, now);
    assert.equal(review.linkedActualExpenseMinor, 2500);
    assert.equal(review.unlinkedPostedExpenseMinor, 0);
    const secondEntryId = randomUUID();
    await client.query(`INSERT INTO finance_ledger_entries
      (id,owner_id,account_id,source,direction,amount_minor,occurred_at,posted_at,
        status,category,dedupe_key) VALUES($1,$2,$3,'demo','outflow',7000,$4,$4,
        'posted','food',$5)`, [secondEntryId, fixture.ownerId, fixture.accountId, postedAt, randomUUID()]);
    const secondBasis = await readBudgetLedgerLinks(client, fixture.ownerId, fixture.periodId);
    await assert.rejects(linkBudgetLedgerEntry(client, fixture.ownerId, fixture.periodId, {
      entryId: secondEntryId, itemId: fixture.dinnerItemId, coveredMinor: 6000,
      expectedFinancialVersion: secondBasis.financialVersion,
      expectedPeriodVersion: secondBasis.periodVersion, confirmedByUser: true,
    }), (error: { code?: string }) => error.code === 'AMOUNT_OUT_OF_RANGE');
    const twiceCovered = await linkBudgetLedgerEntry(client, fixture.ownerId, fixture.periodId, {
      entryId: secondEntryId, itemId: fixture.dinnerItemId, coveredMinor: 5500,
      expectedFinancialVersion: secondBasis.financialVersion,
      expectedPeriodVersion: secondBasis.periodVersion, confirmedByUser: true,
    });
    assert.equal(twiceCovered.items.find((item) => item.itemId === fixture.dinnerItemId)?.remainingMinor, 0);
    const partialReview = await reviewBudgetPeriod(client, fixture.ownerId, fixture.periodId, now);
    assert.equal(partialReview.linkedActualExpenseMinor, 8000);
    assert.equal(partialReview.unlinkedPostedExpenseMinor, 1500);
    await assert.rejects(readBudgetLedgerLinks(client, randomUUID(), fixture.periodId),
      (error: { code?: string }) => error.code === 'RESOURCE_FORBIDDEN');
    const unlinked = await unlinkBudgetLedgerEntry(client, fixture.ownerId, fixture.periodId,
      result.links[0]!.linkId, twiceCovered.periodVersion);
    assert.equal(unlinked.links.find((link) => link.linkId === result.links[0]!.linkId)?.active, false);
    assert.ok(unlinked.links.find((link) => link.linkId === result.links[0]!.linkId)?.unlinkedAt);
    assert.equal(unlinked.items.find((item) => item.itemId === fixture.dinnerItemId)?.remainingMinor, 2500);
    const afterUnlink = await forecastBudgetCashflow(client, fixture.ownerId, fixture.periodId, { now });
    assert.equal(afterUnlink.forecast.minimumSavingsHeadroomMinor,
      before.forecast.minimumSavingsHeadroomMinor! - 4000);

    const previousMonthEntryId = randomUUID();
    const previousMonth = new Date(`${fixture.monthStart}T00:00:00Z`);
    previousMonth.setUTCDate(0);
    await client.query(`INSERT INTO finance_ledger_entries
      (id,owner_id,account_id,source,direction,amount_minor,occurred_at,posted_at,
        status,category,dedupe_key) VALUES($1,$2,$3,'demo','outflow',100,$4,$5,
        'posted','food',$6)`, [previousMonthEntryId, fixture.ownerId, fixture.accountId,
      previousMonth, postedAt, randomUUID()]);
    const crossMonthBasis = await readBudgetLedgerLinks(client, fixture.ownerId, fixture.periodId);
    await assert.rejects(linkBudgetLedgerEntry(client, fixture.ownerId, fixture.periodId, {
      entryId: previousMonthEntryId, itemId: fixture.dinnerItemId, coveredMinor: 100,
      expectedFinancialVersion: crossMonthBasis.financialVersion,
      expectedPeriodVersion: crossMonthBasis.periodVersion, confirmedByUser: true,
    }), (error: { code?: string }) => error.code === 'FINANCE_BASIS_UNKNOWN');

    const otherAccountId = randomUUID();
    const otherEntryId = randomUUID();
    await client.query(`INSERT INTO finance_accounts
      (id,owner_id,provider,account_type,provider_account_ref,masked_identifier,
        display_name,source,authorized_at)
      VALUES($1,$2,'demo','debit',$3,'****OTHER','其他测试账户','demo',$4)`,
    [otherAccountId, fixture.ownerId, randomUUID(), now]);
    await client.query(`INSERT INTO finance_ledger_entries
      (id,owner_id,account_id,source,direction,amount_minor,occurred_at,posted_at,
        status,category,dedupe_key) VALUES($1,$2,$3,'demo','outflow',100,$4,$4,
        'posted','food',$5)`, [otherEntryId, fixture.ownerId, otherAccountId,
      postedAt, randomUUID()]);
    await assert.rejects(linkBudgetLedgerEntry(client, fixture.ownerId, fixture.periodId, {
      entryId: otherEntryId, itemId: fixture.dinnerItemId, coveredMinor: 100,
      expectedFinancialVersion: crossMonthBasis.financialVersion,
      expectedPeriodVersion: crossMonthBasis.periodVersion, confirmedByUser: true,
    }), (error: { code?: string }) => error.code === 'FINANCE_BASIS_UNKNOWN');
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await closePool();
  }
});
