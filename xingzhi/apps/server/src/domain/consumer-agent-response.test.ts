import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeDraftImpact, displayMoney, groundedAgentResponse, describeUnknownReasons } from './consumer-agent-response.js';

test('F3 金额按分格式化，预算允许仍明确显示余额减少', () => {
  assert.equal(displayMoney(70000), '700.00 元');
  assert.equal(displayMoney(-123), '-1.23 元');
  const text = describeDraftImpact(
    { minimumProjectedCashMinor: 70000, minimumSavingsHeadroomMinor: 20000, status: 'allowed' },
    { minimumProjectedCashMinor: 60000, minimumSavingsHeadroomMinor: 10000, status: 'allowed' });
  assert.match(text, /700\.00 元 → 600\.00 元（减少 100\.00 元）/);
  assert.match(text, /200\.00 元 → 100\.00 元（减少 100\.00 元）/);
  assert.match(text, /不代表余额没有变化/);
});

test('F3 缺少金额或资金依据时不宣称零影响或预算允许', () => {
  const text = describeDraftImpact(
    { minimumProjectedCashMinor: 70000, minimumSavingsHeadroomMinor: 20000, status: 'allowed' },
    { minimumProjectedCashMinor: null, minimumSavingsHeadroomMinor: null, status: 'unknown' });
  assert.match(text, /依据不足（无法比较）/);
  assert.doesNotMatch(text, /→ 0\.00|加入后仍在/);
  assert.match(groundedAgentResponse([]), /暂不能给出资金结论/);
});


test('F3 未知原因区分未确认必要支出、过期快照和跨月缺失', () => {
  assert.match(describeUnknownReasons(['BUDGET_NECESSITIES_UNCONFIRMED']), /本月必要支出尚未确认/);
  assert.match(describeUnknownReasons(['SNAPSHOT_STALE', 'FINANCE_BASIS_UNKNOWN']), /快照已过期/);
  assert.doesNotMatch(describeUnknownReasons(['SNAPSHOT_STALE', 'FINANCE_BASIS_UNKNOWN']), /未建立.*月份/);
  assert.match(describeUnknownReasons(['PERIOD_OR_FACT_UNKNOWN', 'ADJACENT_PERIOD_UNKNOWN']), /相邻月份预算/);
});
