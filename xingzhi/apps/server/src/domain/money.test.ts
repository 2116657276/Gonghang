import assert from 'node:assert/strict';
import test from 'node:test';
import { remainingBudget, sumMinor, toYuan } from './money.js';

test('金额始终以分累计，并按已支付与占用计算可用预算', () => {
  assert.equal(sumMinor([88_000, '60000', null]), 148_000);
  assert.equal(remainingBudget(300_000, 148_000, 32_000), 120_000);
  assert.equal(toYuan(800), '¥8.00');
});
