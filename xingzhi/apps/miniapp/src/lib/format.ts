export function yuan(minor: number | null | undefined, fallback = '—') {
  if (minor === null || minor === undefined) return fallback;
  const value = (minor / 100).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  const [integer, decimal] = value.split('.');
  return `¥${integer!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${decimal ? `.${decimal}` : ''}`;
}

export function shortDate(value: string | null | undefined) {
  if (!value) return '日期待确认';
  const date = new Date(value.length === 10 ? `${value}T00:00:00+08:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

export function clockTime(value: string | null | undefined) {
  if (!value) return '时间未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function dateKey(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function minorFromYuan(value: string) {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const minor = Math.round(Number(normalized) * 100);
  return Number.isSafeInteger(minor) ? minor : null;
}

export function yuanInput(minor: number | null | undefined) {
  return minor === null || minor === undefined ? '' : (minor / 100).toFixed(2).replace(/\.00$/, '');
}

export const categoryLabel = (value: string | null) => ({
  food: '餐饮', housing: '居住', transport: '交通', utilities: '生活缴费', health: '健康',
  education: '学习', shopping: '购物', entertainment: '休闲', repayment: '还款',
  income: '收入', refund: '退款', purchase: '计划消费', unexpected: '临时支出', other: '其他',
}[value ?? 'other'] ?? '其他');

export const fundingLabel = (status: string) => ({
  allowed: '符合当前约束', needs_adjustment: '当前需要调整', blocked: '当前无法继续', unknown: '信息尚不足',
}[status] ?? status);
