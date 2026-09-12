import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deepseekPricing, modelCostMicros } from './model-pricing.js';

test('模型费率使用 DeepSeek V4.1 Flash 的官方 API 标识', () => {
  assert.equal(deepseekPricing.model, 'deepseek-flash');
  assert.deepEqual(deepseekPricing.yuanPerMillionTokens, { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 });
});

test('人民币计费区分缓存命中、未命中和输出，并向上取整到微元', () => {
  assert.equal(modelCostMicros({ input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 1_000_000 }), 10_040_000);
  assert.equal(modelCostMicros({ input: 0, cacheRead: 1, cacheWrite: 0, output: 0 }), 1);
  assert.equal(modelCostMicros({ input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 512 }), 2_004_096);
  assert.throws(() => modelCostMicros({ input: -1, cacheRead: 0, cacheWrite: 0, output: 0 }));
  assert.throws(() => modelCostMicros({ input: NaN, cacheRead: 0, cacheWrite: 0, output: 0 }));
});
