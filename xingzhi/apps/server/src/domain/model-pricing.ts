// DeepSeek official CNY rates, checked 2026-09-08:
// https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
// Use peak rates for budget protection; the provider invoice remains authoritative.
export const deepseekPricing = {
  currency: 'CNY', verifiedAt: '2026-09-08', model: 'deepseek-v4-flash',
  estimate: 'official_cny_peak_upper_bound',
  yuanPerMillionTokens: { input: 3, cacheRead: 0.1, cacheWrite: 3, output: 9 },
} as const;

export function modelCostMicros(usage: { input: number; cacheRead: number; cacheWrite: number; output: number }) {
  for (const count of Object.values(usage)) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('模型 token 用量无效，保留费用预占。');
  }
  // Integer tenths of micro-CNY avoid floating-point errors; round upwards once.
  const tenths = (BigInt(usage.input) + BigInt(usage.cacheWrite)) * 30n
    + BigInt(usage.cacheRead) + BigInt(usage.output) * 90n;
  const micros = Number((tenths + 9n) / 10n);
  if (!Number.isSafeInteger(micros)) throw new Error('模型费用超出安全整数范围。');
  return micros;
}
