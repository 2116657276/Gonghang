import type { PlanningDraftView } from '@xingzhi/contracts';
import type { readBudgetPeriod } from './budget-periods.js';

export function displayMoney(minor: number | null): string {
  return minor === null ? '依据不足' : `${(minor / 100).toFixed(2)} 元`;
}

type ForecastSummary = {
  minimumProjectedCashMinor: number | null;
  minimumSavingsHeadroomMinor: number | null;
  status: string;
  reasonCodes?: string[];
};

export function describeDraftImpact(before: ForecastSummary, after: ForecastSummary): string {
  const change = (oldValue: number | null, newValue: number | null) =>
    oldValue === null || newValue === null ? '无法比较'
      : newValue === oldValue ? '不变'
        : `${newValue < oldValue ? '减少' : '增加'} ${displayMoney(Math.abs(newValue - oldValue))}`;
  return [
    '若将这份草稿全部加入正式计划：',
    `预计最低余额：${displayMoney(before.minimumProjectedCashMinor)} → ${displayMoney(after.minimumProjectedCashMinor)}（${change(before.minimumProjectedCashMinor, after.minimumProjectedCashMinor)}）。`,
    `储蓄余量／缺口：${displayMoney(before.minimumSavingsHeadroomMinor)} → ${displayMoney(after.minimumSavingsHeadroomMinor)}（${change(before.minimumSavingsHeadroomMinor, after.minimumSavingsHeadroomMinor)}）。`,
    after.status === 'allowed' ? '加入后仍在当前预算内；这不代表余额没有变化。'
      : after.status === 'unknown' ? '信息不完整，目前不能判断是否在预算内。'
        : '加入后存在资金或储蓄目标缺口，需要调整。',
  ].join('\n');
}

export type BudgetQuestionFocus = 'overview' | 'lowest_balance' | 'unknown' | 'adjustable';
export type AdjustableImpact = { title: string; plannedOn: string; before: number | null; after: number | null };

export function describeUnknownReasons(codes: string[]): string {
  const labels: Record<string, string> = {
    BUDGET_NECESSITIES_UNCONFIRMED: '本月必要支出尚未确认，请先补充房租、生活费等必要安排。',
    ADJACENT_PERIOD_UNKNOWN: '未来 30 天跨入尚未建立或激活的月份，请补充相邻月份预算。',
    PERIOD_NOT_ACTIVE_OR_CURRENT: '所选周期尚未激活或不在当前月份，请核对周期状态和月份。',
    PERIOD_CLOSED: '所选周期已结束，请查看历史复盘或选择当前周期。',
    FINANCE_SCOPE_REVOKED: '账户授权已撤回，当前结果不能继续执行。',
    ACCOUNT_NOT_DEBIT: '此账户不是可用于现金规划的借记账户。',
    SNAPSHOT_MISSING: '缺少账户快照，请先取得可核验的账户资金资料。',
    SNAPSHOT_STALE: '账户快照已过期，请更新账户事实后重新查看。',
    SNAPSHOT_NOT_OBSERVED: '账户快照尚未核验，暂不能确定余额。',
    AVAILABLE_BALANCE_UNKNOWN: '可用余额尚不明确，请核对账户资料。',
    COVERAGE_UNKNOWN: '账户快照的流水覆盖时间未知，暂不能合并计算余额。',
    COVERAGE_BEFORE_SNAPSHOT: '流水覆盖时间早于快照时间，请核对账户资料。',
    COVERAGE_IN_FUTURE: '流水覆盖时间不正确，请核对账户资料。',
    SNAPSHOT_SOURCE_MISMATCH: '账户与快照来源不一致，请核对数据来源。',
    PAYMENT_RESULT_UNKNOWN: '存在结果尚未确认的付款，请先查明原订单状态。',
    PLAN_ACTUAL_COVERAGE_MISMATCH: '计划与实际支出的覆盖金额不一致，请检查关联记录。',
    COMMITTED_ITEM_WITHOUT_ORDER: '已承诺项目缺少对应订单，请核对计划与订单记录。',
    DUPLICATE_ORDER_COMMITMENT: '订单承诺记录重复，请核对订单后重新评估。',
    ADJUSTMENT_DATE_OUTSIDE_PERIOD: '调整日期超出本周期，请修改日期或选择对应月份。',
  };
  const explanations = codes.filter(code => !['FINANCE_BASIS_UNKNOWN', 'PERIOD_OR_FACT_UNKNOWN'].includes(code))
    .map(code => labels[code] ?? (code.startsWith('REPAYMENT_') || code === 'OBLIGATION_SCOPE_UNKNOWN'
      ? '还款账户、应还金额或结清状态尚未核验，请检查账单与还款安排。'
      : /DRAFT_ITEM_\d+_INCOMPLETE/.test(code) ? '草稿的日期、金额或优先级仍待补充。'
        : /DRAFT_ITEM_\d+_OUTSIDE_PERIOD/.test(code) ? '草稿日期不在所选周期，请调整日期或选择对应月份。'
          : '部分资金资料尚未核验，请检查账户与计划详情。'));
  return [...new Set(explanations.length ? explanations : ['部分资金资料尚未核验，请检查账户与计划详情。'])].join('\n');
}

export function describeBudget(result: Awaited<ReturnType<typeof readBudgetPeriod>> & { accountSource: string; rolling30?: ForecastSummary | null; adjustableImpacts?: AdjustableImpact[] }, focus: BudgetQuestionFocus = 'overview'): string {
  const { basis, period, forecast } = result;
  const lowest = forecast.daily.find(day => day.on === basis.minimumCashOn);
  const reasons = forecast.daily.filter(day => lowest && day.on <= lowest.on)
    .flatMap(day => day.events.map(event => {
      const item = result.items.find(item => item.itemId === event.referenceId);
      const title = item?.title ?? ({ planned_expense: '计划支出', repayment: '还款安排',
        committed_order: '已承诺订单', confirmed_future_cash: '已确认资金' })[event.kind];
      return `${day.on} ${title}：${displayMoney(event.deltaMinor)}`;
    }));
  return [
    result.accountSource === 'demo' ? '资金依据：演示数据，非真实银行同步。' : '资金依据：当前账户记录。',
    `预算周期：${period.monthStart} 至 ${period.monthEnd}；事实时间：${basis.asOf ?? '未知'}。`,
    `已确认现金：${displayMoney(basis.confirmedCashMinor)}；储蓄保留目标：${displayMoney(basis.savingsTargetMinor)}。`,
    `本周期预计最低余额：${displayMoney(basis.minimumProjectedCashMinor)}；最低日：${basis.minimumCashOn ?? '依据不足'}。`,
    `储蓄余量／缺口：${displayMoney(basis.minimumSavingsHeadroomMinor)}。`,
    '以上为当前周期结果；预计收入和待到账退款未当作已确认现金。',
    ...(result.rolling30 ? [
      `未来 30 天预计最低余额：${displayMoney(result.rolling30.minimumProjectedCashMinor)}；储蓄余量／缺口：${displayMoney(result.rolling30.minimumSavingsHeadroomMinor)}。`,
      ...(result.rolling30.status === 'unknown' ? ['30 天范围内存在缺失依据，不能用本周期结果替代。'] : []),
    ] : []),
    ...(forecast.status === 'unknown'
      ? ['本周期判断未知的原因：', describeUnknownReasons(forecast.reasonCodes)]
      : focus === 'unknown' ? ['本周期资金依据可以计算，并非未知。'] : []),
    ...(focus === 'unknown' && result.rolling30?.status === 'unknown'
      ? ['30 天判断未知的原因：', describeUnknownReasons(result.rolling30.reasonCodes ?? [])] : []),
    ...(focus !== 'adjustable' && reasons.length ? ['截至最低日的资金变动：', ...reasons] : []),
    ...(focus === 'lowest_balance' && forecast.status !== 'unknown'
      ? ['以上安排累计作用于已确认现金，形成该最低日；预计收入到账前不能抵消这些支出。'] : []),
    ...(focus === 'adjustable' ? describeAdjustableItems(result.adjustableImpacts ?? [], forecast.status) : []),
    '具体调整请查看计划项目的单项影响，再由你确认。',
  ].join('\n');
}

function describeAdjustableItems(items: AdjustableImpact[], status: string): string[] {
  if (status === 'unknown') return ['当前依据不足，无法确定调整项目后能改善多少余量，请先补齐上面的资料。'];
  if (!items.length) return ['当前没有可直接调整的未承诺消费项目；已关联实际支出或已进入购买确认的项目须到详情处理。'];
  return ['当前可调整项目（以下分别假设仅取消该项，尚未执行）：',
    ...items.map(item => `${item.plannedOn} ${item.title}：储蓄余量／缺口 ${displayMoney(item.before)} → ${displayMoney(item.after)}。`),
    '这些是独立比较，改善金额不能直接相加；保留目标未被降低，是否调整仍由你确认。'];
}

export function describeDraft(draft: PlanningDraftView, impact: string | null): string {
  return [
    '已保存待确认草稿：',
    ...draft.items.map(item => `${item.title}；日期：${item.plannedOn ?? '待补充'}；用户金额：${item.userEstimatedAmountMinor === null ? '待补充' : displayMoney(item.userEstimatedAmountMinor)}；${item.priority === 'required' ? '必须保留' : item.priority === 'adjustable' ? '可调整' : '优先级待补充'}。`),
    ...(draft.missingFields.length ? ['仍有用户字段待补充；模型建议不等于你的确认。'] : []),
    impact ?? '未取得完整资金依据，暂不判断加入后的资金影响。',
    '保存草稿没有修改正式预算，也没有建单或付款。请在草稿详情查看影响，并逐项确认后加入计划。',
  ].join('\n');
}

// Financial statements are rendered from tool facts, never from model prose.
// This also covers a model that skips tools or invents a successful write.
export function groundedAgentResponse(sections: Iterable<string>): string {
  const facts = [...sections];
  return facts.length ? facts.join('\n\n')
    : '本次未取得可展示的资金事实或已保存草稿，暂不能给出资金结论。请选择预算周期后重试，或到计划页面补充日期、金额和优先级。';
}
