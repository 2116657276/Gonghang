export function toYuan(minor: number): string {
  return `¥${(minor / 100).toFixed(2)}`;
}

export function sumMinor(values: Array<number | string | null | undefined>): number {
  return values.reduce<number>((total, value) => total + Number(value ?? 0), 0);
}

export function remainingBudget(limitMinor: number, paidMinor: number, reservedMinor: number): number {
  return limitMinor - paidMinor - reservedMinor;
}
