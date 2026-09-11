import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelCostMicros } from './model-pricing.js';

test('人民币计费区分缓存命中、未命中和输出，并向上取整到微元', () => {
  assert.equal(modelCostMicros({ input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 1_000_000 }), 12_100_000);
  assert.equal(modelCostMicros({ input: 0, cacheRead: 1, cacheWrite: 0, output: 0 }), 1);
  assert.equal(modelCostMicros({ input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 512 }), 3_004_608);
  assert.throws(() => modelCostMicros({ input: -1, cacheRead: 0, cacheWrite: 0, output: 0 }));
  assert.throws(() => modelCostMicros({ input: NaN, cacheRead: 0, cacheWrite: 0, output: 0 }));
});
