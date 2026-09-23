import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculateDailyCashflow } from './cashflow-engine.js';
import { buildCashflowEvents } from './budget-cashflow.js';

const startOn = '2026-09-15';
const endOn = '2026-09-30';
const base = {
  openingCashMinor: 200000, savingsTargetMinor: 50000, startOn, endOn,
  events: [
    { on: endOn, deltaMinor: -90000, kind: 'planned_expense' as const, referenceId: 'essentials' },
    { on: endOn, deltaMinor: -40000, kind: 'planned_expense' as const, referenceId: 'flexible' },
  ],
};

test('A03 protects ¥500 savings: ¥200 → ¥181 → ¥219 gap', () => {
  const original = calculateDailyCashflow(base);
  assert.equal(original.status, 'allowed');
  assert.equal(original.minimumSavingsHeadroomMinor, 20000);
  assert.deepEqual(original.daily.at(-1)?.events.map((event) => event.referenceId),
    ['essentials', 'flexible']);
  const withQuoteDifference = calculateDailyCashflow({ ...base, events: [
    ...base.events,
    { on: startOn, deltaMinor: -1900, kind: 'committed_order', referenceId: 'quote-difference' },
  ] });
  assert.equal(withQuoteDifference.status, 'allowed');
  assert.equal(withQuoteDifference.minimumSavingsHeadroomMinor, 18100);
  const emergency = calculateDailyCashflow({ ...base, events: [
    ...base.events,
    { on: startOn, deltaMinor: -1900, kind: 'committed_order', referenceId: 'quote-difference' },
    { on: startOn, deltaMinor: -40000, kind: 'planned_expense', referenceId: 'emergency' },
  ] });
  assert.equal(emergency.status, 'needs_adjustment');
  assert.equal(emergency.shortfallMinor, 21900);
  assert.ok(emergency.affectedDates.includes(endOn));
});

test('A03 refuses a mid-month overdraft despite a positive final balance', () => {
  const forecast = calculateDailyCashflow({
    openingCashMinor: 10000, savingsTargetMinor: 0,
    startOn: '2026-09-01', endOn: '2026-09-04',
    events: [
      { on: '2026-09-02', deltaMinor: -12000, kind: 'planned_expense', referenceId: 'early-bill' },
      // A trusted future cash fact is a pure-engine scenario, not user-estimated income.
      { on: '2026-09-03', deltaMinor: 5000, kind: 'confirmed_future_cash', referenceId: 'verified-inflow' },
    ],
  });
  assert.equal(forecast.periodEndCashMinor, 3000);
  assert.equal(forecast.minimumProjectedCashMinor, -2000);
  assert.equal(forecast.status, 'blocked');
  assert.ok(forecast.affectedDates.includes('2026-09-02'));
});

test('A03 replaces one estimate with its order and shares one account across goals', () => {
  const built = buildCashflowEvents({
    startOn, endOn,
    items: [
      { id: 'dinner', plannedOn: endOn, kind: 'planned_spend', status: 'planned', estimatedMinor: '8000' },
      { id: 'other-goal', plannedOn: endOn, kind: 'planned_spend', status: 'planned', estimatedMinor: '32000' },
      { id: 'necessities', plannedOn: endOn, kind: 'essential_expense', status: 'planned', estimatedMinor: '90000' },
      { id: 'future-salary', plannedOn: endOn, kind: 'expected_income', status: 'planned', estimatedMinor: '100000' },
    ],
    orders: [{ id: 'dinner-order', budgetItemId: 'dinner', amountMinor: 9900,
      paymentStatus: 'pending', debitedInBank: false }],
    repayments: [],
  });
  assert.equal(built.conditionalIncomeMinor, 100000);
  assert.ok(!built.events.some((event) => event.referenceId === 'dinner'));
  const forecast = calculateDailyCashflow({ openingCashMinor: 200000,
    savingsTargetMinor: 50000, startOn, endOn, events: built.events });
  assert.equal(forecast.minimumSavingsHeadroomMinor, 18100); // Not ¥80 + ¥99.
  assert.equal(forecast.status, 'allowed');
  const twoGoals = calculateDailyCashflow({ openingCashMinor: 150000,
    savingsTargetMinor: 0, startOn, endOn, events: [
      { on: endOn, deltaMinor: -80000, kind: 'planned_expense', referenceId: 'goal-one' },
      { on: endOn, deltaMinor: -80000, kind: 'planned_expense', referenceId: 'goal-two' },
    ] });
  assert.equal(twoGoals.status, 'blocked');
  assert.equal(twoGoals.minimumProjectedCashMinor, -10000);
});

test('A03 does not treat an unplanned next month as zero expense', () => {
  const forecast = calculateDailyCashflow({ ...base, endOn: '2026-10-14',
    unknownDates: ['2026-10-01'] });
  assert.equal(forecast.status, 'unknown');
  assert.equal(forecast.periodEndCashMinor, null);
  assert.equal(forecast.daily.find((day) => day.on === '2026-10-01')?.projectedCashMinor, null);
  assert.equal(forecast.daily.find((day) => day.on === '2026-10-14')?.projectedCashMinor, null);
});
