// DeepSeek V4.1 Flash official CNY rates, checked 2026-09-12:
// https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
// Use peak rates for budget protection; the provider invoice remains authoritative.
export const deepseekPricing = {
  currency: 'CNY', verifiedAt: '2026-09-12', model: 'deepseek-flash',
  estimate: 'official_cny_peak_upper_bound',
  yuanPerMillionTokens: { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 },
} as const;

export function modelCostMicros(usage: { input: number; cacheRead: number; cacheWrite: number; output: number }) {
  for (const count of Object.values(usage)) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('模型 token 用量无效，保留费用预占。');
  }
  // Integer hundredths of micro-CNY avoid floating-point errors; round upwards once.
  const hundredths = (BigInt(usage.input) + BigInt(usage.cacheWrite)) * 200n
    + BigInt(usage.cacheRead) * 4n + BigInt(usage.output) * 800n;
  const micros = Number((hundredths + 99n) / 100n);
  if (!Number.isSafeInteger(micros)) throw new Error('模型费用超出安全整数范围。');
  return micros;
}
