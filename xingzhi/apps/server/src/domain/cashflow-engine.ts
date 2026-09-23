export type CashflowEvent = {
  on: string;
  deltaMinor: number;
  kind: 'planned_expense' | 'repayment' | 'committed_order' | 'confirmed_future_cash';
  referenceId: string;
};

export type DailyCashflow = {
  on: string;
  projectedCashMinor: number | null;
  savingsHeadroomMinor: number | null;
  cashShortfallMinor: number | null;
  savingsShortfallMinor: number | null;
  dataStatus: 'observed' | 'unknown';
  events: CashflowEvent[];
};

function validMinor(value: number) {
  if (!Number.isSafeInteger(value)) throw new Error('现金流金额必须是安全整数分。');
  return value;
}

function eachDate(startOn: string, endOn: string) {
  const current = new Date(`${startOn}T00:00:00Z`);
  const end = new Date(`${endOn}T00:00:00Z`);
  if (Number.isNaN(current.getTime()) || Number.isNaN(end.getTime()) || current > end) {
    throw new Error('现金流日期范围不正确。');
  }
  const dates: string[] = [];
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

export function unknownDailyCashflow(startOn: string, endOn: string, reasonCodes: string[]) {
  const affectedDates = eachDate(startOn, endOn);
  return {
    status: 'unknown' as const, reasonCodes, shortfallMinor: null,
    minimumProjectedCashMinor: null, minimumSavingsHeadroomMinor: null,
    minimumCashOn: null, periodEndCashMinor: null,
    periodEndSavableMinor: null, savingsTargetGapMinor: null,
    affectedDates,
    daily: affectedDates.map((on): DailyCashflow => ({
      on, projectedCashMinor: null, savingsHeadroomMinor: null,
      cashShortfallMinor: null, savingsShortfallMinor: null, dataStatus: 'unknown',
      events: [],
    })),
  };
}

export function calculateDailyCashflow(input: {
  openingCashMinor: number;
  savingsTargetMinor: number;
  startOn: string;
  endOn: string;
  events: CashflowEvent[];
  unknownDates?: string[];
  savingsTargetsByDate?: Record<string, number>;
}) {
  validMinor(input.openingCashMinor);
  validMinor(input.savingsTargetMinor);
  if (input.openingCashMinor < 0 || input.savingsTargetMinor < 0) {
    throw new Error('现金基准和储蓄目标不能为负。');
  }
  const dates = eachDate(input.startOn, input.endOn);
  const dateSet = new Set(dates);
  const byDate = new Map<string, number>();
  const eventsByDate = new Map<string, CashflowEvent[]>();
  for (const event of input.events) {
    validMinor(event.deltaMinor);
    if (!dateSet.has(event.on)) throw new Error('现金流事件必须位于评估日期内。');
    byDate.set(event.on, validMinor((byDate.get(event.on) ?? 0) + event.deltaMinor));
    eventsByDate.set(event.on, [...(eventsByDate.get(event.on) ?? []), event]);
  }
  const unknown = new Set(input.unknownDates ?? []);
  for (const target of Object.values(input.savingsTargetsByDate ?? {})) {
    validMinor(target);
    if (target < 0) throw new Error('每日储蓄保留目标不能为负。');
  }
  const firstTarget = input.savingsTargetsByDate?.[dates[0]!] ?? input.savingsTargetMinor;
  let cash = input.openingCashMinor;
  let minimumCash = cash;
  let minimumHeadroom = cash - firstTarget;
  let unknownSeen = false;
  const daily: DailyCashflow[] = dates.map((on) => {
    if (unknown.has(on)) unknownSeen = true;
    if (unknownSeen) {
      return {
        on, projectedCashMinor: null, savingsHeadroomMinor: null,
        cashShortfallMinor: null, savingsShortfallMinor: null, dataStatus: 'unknown',
        events: eventsByDate.get(on) ?? [],
      };
    }
    cash = validMinor(cash + (byDate.get(on) ?? 0));
    const target = input.savingsTargetsByDate?.[on] ?? input.savingsTargetMinor;
    const headroom = validMinor(cash - target);
    minimumCash = Math.min(minimumCash, cash);
    minimumHeadroom = Math.min(minimumHeadroom, headroom);
    return {
      on, projectedCashMinor: cash, savingsHeadroomMinor: headroom,
      cashShortfallMinor: Math.max(0, -cash), savingsShortfallMinor: Math.max(0, -headroom),
      dataStatus: 'observed',
      events: eventsByDate.get(on) ?? [],
    };
  });
  const affectedDates = daily.filter((day) => day.dataStatus === 'unknown'
    || (day.savingsShortfallMinor ?? 0) > 0).map((day) => day.on);
  const status = unknownSeen ? 'unknown' as const
    : minimumCash < 0 ? 'blocked' as const
      : minimumHeadroom < 0 ? 'needs_adjustment' as const : 'allowed' as const;
  const reasonCodes = status === 'unknown' ? ['PERIOD_OR_FACT_UNKNOWN']
    : status === 'blocked' ? ['INSUFFICIENT_FUNDS']
      : status === 'needs_adjustment' ? ['SAVINGS_TARGET_AT_RISK'] : ['WITHIN_BUDGET'];
  return {
    status,
    reasonCodes,
    shortfallMinor: unknownSeen ? null : Math.max(0, -minimumHeadroom),
    minimumProjectedCashMinor: unknownSeen ? null : minimumCash,
    minimumSavingsHeadroomMinor: unknownSeen ? null : minimumHeadroom,
    minimumCashOn: unknownSeen ? null : daily.find((day) => day.projectedCashMinor === minimumCash)?.on ?? input.startOn,
    periodEndCashMinor: unknownSeen ? null : cash,
    periodEndSavableMinor: unknownSeen ? null : Math.max(0, cash),
    savingsTargetGapMinor: unknownSeen ? null : Math.max(0,
      (input.savingsTargetsByDate?.[dates[dates.length - 1]!] ?? input.savingsTargetMinor) - cash),
    affectedDates,
    daily,
  };
}
