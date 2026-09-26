<script setup lang="ts">
import { computed, ref } from 'vue';
import Taro, { useDidShow } from '@tarojs/taro';
import BottomSheet from '@/components/BottomSheet.vue';
import FactRow from '@/components/FactRow.vue';
import IpAvatar from '@/components/IpAvatar.vue';
import PageShell from '@/components/PageShell.vue';
import SectionCard from '@/components/SectionCard.vue';
import SectionHeader from '@/components/SectionHeader.vue';
import StatePanel from '@/components/StatePanel.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { useOverview } from '@/composables/useOverview';
import { useAmountVisibility } from '@/composables/useAmountVisibility';
import { openAiWithQuestion } from '@/lib/ai-entry';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { categoryLabel, clockTime, fundingLabel, shortDate, yuan } from '@/lib/format';
import type { AgentRunSummary, BudgetItem, ConsumerOrder, FinanceAccountFacts, LedgerEntry, PurchaseIntent, RollingCashflow } from '@/lib/types';

type SheetName = 'pending' | 'impact' | 'obligation' | 'plan' | 'ledger' | null;
type Obligation = FinanceAccountFacts['obligations']['items'][number];
type PendingAction = { id: string; title: string; detail: string; url?: string; obligationId?: string;
  amountMinor?: number | null; tone: 'info' | 'warning'; preference?: 'planning' | 'orders' | 'refunds' };

const overview = useOverview();
// Tab pages are cached on devices. Keep the loaded content mounted while
// refreshing onShow instead of tearing down and recreating the whole subtree.
const overviewReady = ref(false);
const activeSheet = ref<SheetName>(null);
const { balanceVisible, toggleBalanceVisibility } = useAmountVisibility();
const selectedObligation = ref<Obligation | null>(null);
const selectedPlan = ref<BudgetItem | null>(null);
const selectedLedger = ref<LedgerEntry | null>(null);
const intents = ref<PurchaseIntent[]>([]);
const orders = ref<ConsumerOrder[]>([]);
const agentRuns = ref<AgentRunSummary[]>([]);
const pendingError = ref('');
const rolling = ref<RollingCashflow | null>(null);
const rollingLoading = ref(false);
const rollingError = ref('');
const expandedTimeline = ref(false);
let rollingLoadSequence = 0;

async function loadPending() {
  pendingError.value = '';
  try {
    const [intentResult, orderResult, runResult] = await Promise.all([api.purchaseIntents(), api.orders(), api.agentRuns()]);
    intents.value = intentResult.data.intents;
    orders.value = orderResult.data.orders;
    agentRuns.value = runResult.data.items;
  } catch (reason) { pendingError.value = errorMessage(reason); }
}
async function loadOverviewAndForecast() {
  const sequence = ++rollingLoadSequence;
  rolling.value = null;
  rollingError.value = '';
  rollingLoading.value = true;
  await overview.load();
  if (sequence !== rollingLoadSequence) return;
  if (overview.error.value) { rollingLoading.value = false; return; }
  overviewReady.value = true;
  const period = overview.currentPeriod.value;
  if (!period || period.period.status !== 'active') { rollingLoading.value = false; return; }
  try {
    const result = (await api.rollingCashflow(period.period.periodId)).data;
    if (sequence !== rollingLoadSequence) return;
    if (result.financialVersion !== period.basis.financialVersion
      || result.periodVersion !== period.basis.periodVersion) {
      rollingError.value = '资金或计划依据发生变化，请刷新首页。';
      return;
    }
    rolling.value = result;
  } catch (reason) {
    if (sequence === rollingLoadSequence) rollingError.value = errorMessage(reason);
  } finally { if (sequence === rollingLoadSequence) rollingLoading.value = false; }
}
useDidShow(() => { void loadOverviewAndForecast(); void loadPending(); });

const greeting = computed(() => `${new Date().getHours() < 12 ? '早上好' : new Date().getHours() < 18 ? '下午好' : '晚上好'}，${overview.user.value?.displayName ?? '朋友'}`);
const recentLedger = computed(() => overview.primaryAccount.value?.ledger.slice(0, 3) ?? []);
const upcoming = computed(() => overview.primaryAccount.value?.obligations.items.filter(item => ['upcoming', 'overdue'].includes(item.status)) ?? []);
const pendingActions = computed<PendingAction[]>(() => {
  const values: PendingAction[] = upcoming.value.map(item => ({ id: `obligation-${item.id}`, title: item.label,
    detail: `${shortDate(item.dueOn)} · ${item.status === 'overdue' ? '已逾期' : '未来义务'}`,
    obligationId: item.id, amountMinor: item.remainingDueMinor ?? item.amountDueMinor,
    tone: item.status === 'overdue' ? 'warning' : 'info',
    preference: item.status === 'overdue' ? undefined : 'planning' }));
  for (const intent of intents.value.filter(value => value.status === 'proposed')) {
    const expired = Date.parse(intent.expiresAt) <= Date.now();
    values.push({ id: `intent-${intent.purchaseIntentId}`, title: expired ? `${intent.offerName} 报价已过期` : `确认购买：${intent.offerName}`,
      detail: expired ? '需要重新报价和评估' : `${shortDate(intent.expiresAt)} 前确认`,
      url: `/pages/purchase/detail?id=${intent.purchaseIntentId}`, amountMinor: intent.quotedAmountMinor,
      tone: expired ? 'warning' : 'info', preference: 'orders' });
  }
  for (const order of orders.value) {
    if (order.paymentStatus === 'pending') values.push({ id: `order-pay-${order.orderId}`, title: `待付款：${order.itemName}`,
      detail: '继续付款或关闭订单', url: `/pages/order/detail?id=${order.orderId}`,
      amountMinor: order.amountMinor, tone: 'info', preference: 'orders' });
    else if (order.paymentStatus === 'unknown') values.push({ id: `order-check-${order.orderId}`, title: `付款结果待核验：${order.itemName}`,
      detail: '进入订单主动查单', url: `/pages/order/detail?id=${order.orderId}`,
      amountMinor: order.amountMinor, tone: 'warning', preference: 'orders' });
    if (order.status === 'cancellation_processing') values.push({ id: `refund-${order.orderId}`, title: `退款处理中：${order.itemName}`,
      detail: '查看渠道批次与到账状态', url: `/pages/refund/detail?orderId=${order.orderId}`,
      amountMinor: order.amountMinor - order.refundedMinor, tone: 'info', preference: 'refunds' });
  }
  for (const run of agentRuns.value.filter(value => value.state === 'RUNNING')) values.push({ id: `agent-${run.id}`, title: '行止正在整理你的问题',
    detail: '可查看进度或停止运行', url: '/subpackage/common/ai-history', tone: 'info', preference: 'planning' });
  return values;
});
const attention = computed(() => pendingActions.value.filter(item => !item.preference
  || overview.preferences.value?.notifications[item.preference] !== false).slice(0, 3));
const planItems = computed(() => overview.currentPeriod.value?.items.filter(item => item.status !== 'cancelled').slice(0, 2) ?? []);
const forecastStatus = computed(() => overview.currentPeriod.value?.forecast.status ?? 'unknown');
const rollingForecast = computed(() => rolling.value?.forecast ?? null);
const rollingDaily = computed(() => rollingForecast.value?.daily ?? []);
const chartDays = computed(() => {
  const daily = rollingDaily.value;
  if (!daily.some(day => day.projectedCashMinor !== null)) return [];
  const count = Math.min(7, daily.length);
  const indexes = Array.from({ length: count }, (_, index) =>
    Math.round(index * (daily.length - 1) / Math.max(1, count - 1)));
  return indexes.map(index => daily[index]!).filter((day, index, values) => index === 0 || day.on !== values[index - 1]?.on);
});
const chartPoints = computed(() => {
  const days = chartDays.value;
  const values = days.map(day => day.projectedCashMinor).filter((value): value is number => value !== null);
  if (!values.length) return [];
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const range = Math.max(1, maximum - minimum);
  return days.map((day, index) => {
    const value = day.projectedCashMinor;
    return {
      on: day.on,
      value,
      left: days.length === 1 ? 50 : 6 + index * 88 / (days.length - 1),
      top: value === null ? null : 16 + (maximum - value) * 62 / range,
      minimum: value === minimum,
    };
  });
});
const chartSegments = computed(() => chartPoints.value.slice(0, -1).flatMap((point, index) => {
  const next = chartPoints.value[index + 1]!;
  if (point.top === null || next.top === null) return [];
  const dx = next.left - point.left;
  const dy = next.top - point.top;
  return [{
    left: point.left,
    top: point.top,
    width: Math.sqrt(dx * dx + dy * dy),
    angle: Math.atan2(dy, dx) * 180 / Math.PI,
  }];
}));
const lowestDay = computed(() => rollingDaily.value.find(day => day.on === rollingForecast.value?.minimumCashOn) ?? null);
const rollingHeadroom = computed(() => lowestDay.value?.savingsHeadroomMinor ?? null);
const rollingFoot = computed(() => {
  if (rollingLoading.value) return '正在计算';
  if (!rollingForecast.value || rollingForecast.value.status === 'unknown') return '完整缓冲依据不足';
  const worst = rollingForecast.value.minimumSavingsHeadroomMinor;
  if (worst !== null && worst < 0) return `30 天预计缺口 ${yuan(-worst)}`;
  return rollingHeadroom.value === null ? '最低日差额待确认' : `最低日缓冲 ${yuan(rollingHeadroom.value)}`;
});
const accountState = computed(() => !overview.primaryAccount.value ? '等待选择'
  : overview.primaryAccount.value.cashBasis.dataStatus === 'observed' ? '资金已核验' : '资金待核验');
const forecastState = computed(() => rollingLoading.value ? '正在计算'
  : !rollingForecast.value || rollingForecast.value.status === 'unknown' ? '依据待补全'
    : rollingForecast.value.status === 'allowed' ? '缓冲充足' : '需要留意');
const forecastAmount = computed(() => rollingLoading.value ? '计算中'
  : rollingForecast.value?.minimumProjectedCashMinor === null || rollingForecast.value?.minimumProjectedCashMinor === undefined
    ? '待补全' : yuan(rollingForecast.value.minimumProjectedCashMinor));
const forecastFoot = computed(() => rollingForecast.value?.minimumCashOn
  ? `${rollingFoot.value} · 最低日 ${shortDate(rollingForecast.value.minimumCashOn)}` : rollingFoot.value);
const factTime = computed(() => {
  const account = overview.primaryAccount.value;
  const value = account?.cashBasis.dataStatus === 'observed' ? account.cashBasis.asOf : account?.latestSnapshot?.asOf;
  if (!value) return '暂无资金快照时间';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '资金快照时间待确认';
  const formatted = `${shortDate(value)} ${clockTime(value)}`;
  return `${account?.cashBasis.dataStatus === 'observed' ? '资金依据' : '最近快照'} ${formatted}`;
});
const cashflowSummary = computed(() => {
  const forecast = rollingForecast.value;
  if (!forecast || forecast.status === 'unknown' || forecast.minimumCashOn === null) return '资金依据或相邻月份规划不足，无法给出完整的 30 天结论。';
  const headroom = rollingHeadroom.value;
  if (headroom === null) return '最低日与保留目标差额待确认。';
  const otherGap = forecast.minimumSavingsHeadroomMinor !== null
    && forecast.minimumSavingsHeadroomMinor < headroom
    && forecast.minimumSavingsHeadroomMinor < 0
    ? `另有日期预计缺口 ${yuan(-forecast.minimumSavingsHeadroomMinor)}，需要调整安排。` : '';
  return `${shortDate(forecast.minimumCashOn)}最低日与保留目标差额 ${yuan(Math.abs(headroom))}${headroom < 0 ? '，需要调整安排' : '，仍有缓冲'}。${otherGap}`;
});
const timeline = computed(() => {
  const days = rollingDaily.value;
  if (!days.length) return [];
  const start = days[0]!.on;
  const end = days[days.length - 1]!.on;
  const accountId = overview.primaryAccount.value?.account.accountId;
  const items = overview.periods.value.filter(period => period.period.accountId === accountId && period.period.status === 'active')
    .flatMap(period => period.items.filter(item => item.status === 'planned'
      && item.plannedOn >= start && item.plannedOn <= end).map(item => ({
        id: `item-${item.itemId}`, on: item.plannedOn, title: item.title,
        kind: item.kind === 'expected_income' ? '预计收入' : item.kind === 'essential_expense' ? '必要支出' : '可调计划',
        amountMinor: item.userEstimatedAmountMinor, included: item.kind !== 'expected_income',
      })));
  const obligations = (overview.primaryAccount.value?.obligations.items ?? [])
    .filter(item => ['upcoming', 'overdue'].includes(item.status) && item.dueOn >= start && item.dueOn <= end)
    .map(item => ({ id: `obligation-${item.id}`, on: item.dueOn, title: item.label,
      kind: '还款义务', amountMinor: item.remainingDueMinor ?? item.amountDueMinor,
      included: item.remainingDueMinor !== null && item.remainingDueMinor !== undefined }));
  return [...items, ...obligations].sort((a, b) => a.on.localeCompare(b.on) || a.id.localeCompare(b.id));
});
const visibleTimeline = computed(() => expandedTimeline.value ? timeline.value : timeline.value.slice(0, 5));
const minimumCauses = computed(() => {
  const events = lowestDay.value?.events ?? [];
  const itemName = new Map(overview.periods.value.flatMap(period => period.items.map(item => [item.itemId, item.title] as const)));
  const obligationName = new Map((overview.primaryAccount.value?.obligations.items ?? []).map(item => [item.id, item.label] as const));
  return events.map(event => ({ id: `${event.kind}-${event.referenceId}`,
    name: event.kind === 'repayment' ? obligationName.get(event.referenceId) ?? '还款义务'
      : event.kind === 'planned_expense' ? itemName.get(event.referenceId) ?? '计划支出'
        : event.kind === 'committed_order' ? '已承诺订单' : '已确认资金',
    deltaMinor: event.deltaMinor }));
});
const statusTone = (status: string) => status === 'allowed' ? 'success' : status === 'unknown' ? 'info' : 'warning';

const sheetCopy = computed(() => ({
  pending: { title: '需要你处理', description: '仅列出服务端已确认的待办与未来义务。', primary: '' },
  impact: { title: '未来 30 天资金影响', description: '以下是当前资金依据的摘要，不代表未来余额保证。', primary: overview.currentPeriod.value ? '查看本月分析' : '' },
  obligation: { title: selectedObligation.value?.label ?? '未来义务', description: '这是尚未发生或尚未完全结清的资金安排。', primary: '' },
  plan: { title: selectedPlan.value?.title ?? '计划影响', description: '计划金额与资金结论分开展示，以服务端状态为准。', primary: '查看计划详情' },
  ledger: { title: categoryLabel(selectedLedger.value?.displayCategory ?? null), description: '这是一笔账户事实记录。', primary: '查看全部账目' },
}[activeSheet.value ?? 'pending']));

function showObligation(item: Obligation) { selectedObligation.value = item; activeSheet.value = 'obligation'; }
function showPlan(item: BudgetItem) { selectedPlan.value = item; activeSheet.value = 'plan'; }
function showLedger(item: LedgerEntry) { selectedLedger.value = item; activeSheet.value = 'ledger'; }
function openPending(item: PendingAction) {
  if (item.obligationId) { const obligation = upcoming.value.find(value => value.id === item.obligationId); if (obligation) showObligation(obligation); return; }
  activeSheet.value = null;
  if (item.url) void Taro.navigateTo({ url: item.url });
}
function switchTab(url: string) { void Taro.switchTab({ url }); }
function askAboutMinimum() {
  const period = overview.currentPeriod.value;
  if (!period) return;
  const on = rollingForecast.value?.minimumCashOn ?? undefined;
  void openAiWithQuestion({ periodId: period.period.periodId, on,
    question: on
      ? `请根据${shortDate(on)}的最低余额和本月保留目标，解释当天为什么需要留意，并给出可由我确认的调整建议。`
      : '请解释本月资金判断为什么暂时未知，以及我需要补充哪些事实。' });
}
function handleSheetPrimary() {
  const sheet = activeSheet.value;
  activeSheet.value = null;
  if (sheet === 'ledger') return switchTab('/pages/ledger/index');
  if (sheet === 'plan' && selectedPlan.value && overview.currentPeriod.value) return Taro.navigateTo({ url: `/pages/item/detail?periodId=${overview.currentPeriod.value.period.periodId}&itemId=${selectedPlan.value.itemId}` });
  if (sheet === 'impact' && overview.currentPeriod.value) return Taro.navigateTo({ url: `/pages/impact/detail?periodId=${overview.currentPeriod.value.period.periodId}` });
}
function openAccount() {
  const id = overview.primaryAccount.value?.account.accountId;
  void Taro.navigateTo({ url: id ? `/pages/account/detail?id=${id}` : '/pages/account/select' });
}
</script>

<template>
  <PageShell :title="greeting" subtitle="今天也看看钱怎么安排">
    <template #hero>
      <button class="pending-button" aria-label="查看待处理事项" @tap="activeSheet='pending'">
        <text class="pending-button__bell">⌁</text><text v-if="pendingActions.length" class="pending-button__count">{{ pendingActions.length>9?'9+':pendingActions.length }}</text>
      </button>
    </template>
    <StatePanel v-if="!overviewReady && overview.loading.value" title="正在读取当前资金事实" detail="只展示服务端已经确认的数据。" />
    <StatePanel v-else-if="!overviewReady && overview.error.value" title="暂时无法读取首页" :detail="overview.error.value" tone="error"><button class="secondary-button retry" @tap="loadOverviewAndForecast">重新加载</button></StatePanel>
    <template v-else>
      <view v-if="overview.loading.value" class="notice">正在更新账户和计划，当前显示上次读取的数据。</view>
      <view v-else-if="overview.error.value" class="notice notice--error">刷新失败，当前显示上次读取的数据：{{ overview.error.value }}<button class="link-button" @tap="loadOverviewAndForecast">重新加载 ›</button></view>
      <view class="summary-grid">
        <view class="section-card summary-card summary-card--account" @tap="openAccount">
          <view class="summary-card__heading">
            <view class="summary-card__identity"><view class="summary-card__icon summary-card__icon--account" aria-hidden="true"><view class="account-icon__stripe"/><view class="account-icon__chip"/></view><text class="summary-card__label">我的主账户</text></view>
            <button class="visibility-button" :aria-label="balanceVisible?'隐藏主账户金额':'显示主账户金额'" @tap.stop="toggleBalanceVisibility">{{ balanceVisible ? '隐藏' : '显示' }}</button>
          </view>
          <text class="summary-card__meta">{{ overview.primaryAccount.value?.account.displayName ?? '尚未选择账户' }}</text>
          <text class="summary-card__amount amount">{{ !overview.primaryAccount.value?'—':balanceVisible ? yuan(overview.primaryAccount.value.cashBasis.confirmedCashMinor) : '••••' }}</text>
          <view class="summary-card__footer"><text class="summary-card__state"><text class="summary-card__dot"/>{{ accountState }}</text><text class="summary-card__arrow">›</text></view>
          <text class="summary-card__foot">{{ factTime }}</text>
        </view>
        <view class="section-card summary-card summary-card--forecast" @tap="activeSheet='impact'">
          <view class="summary-card__heading">
            <view class="summary-card__identity"><view class="summary-card__icon summary-card__icon--forecast" aria-hidden="true"><view class="forecast-icon__bar forecast-icon__bar--one"/><view class="forecast-icon__bar forecast-icon__bar--two"/><view class="forecast-icon__bar forecast-icon__bar--three"/><view class="forecast-icon__line"/></view><text class="summary-card__label">未来 30 天</text></view>
            <text class="summary-card__arrow">›</text>
          </view>
          <text class="summary-card__meta">预计最低余额</text>
          <text class="summary-card__amount amount" :class="{'summary-card__amount--state':forecastAmount==='计算中'||forecastAmount==='待补全'}">{{ forecastAmount }}</text>
          <view class="summary-card__footer"><text class="summary-card__state"><text class="summary-card__dot"/>{{ forecastState }}</text></view>
          <text class="summary-card__foot">{{ forecastFoot }}</text>
        </view>
      </view>
      <button v-if="attention.length" class="urgent-brief" @tap="activeSheet='pending'"><view><text>有 {{ pendingActions.length }} 项需要留意</text><text>{{ attention[0]?.title }} · {{ attention[0]?.detail }}</text></view><text aria-hidden="true">›</text></button>
      <view v-if="rollingError" class="notice notice--warning forecast-error">30 天预测暂时不可用：{{ rollingError }}</view>
      <SectionHeader title="未来资金走势" :action="overview.currentPeriod.value ? '查看本月分析' : undefined" @action="activeSheet='impact'" />
      <SectionCard v-if="rollingDaily.length" class="forecast-card">
        <view class="forecast-card__lead"><view class="forecast-card__lead-icon" aria-hidden="true">30</view><view><text class="forecast-card__summary">{{ cashflowSummary }}</text><text class="forecast-card__note">逐日预测只使用已确认现金和已登记安排；预计收入不提前计入现金。</text></view></view>
        <view v-if="chartPoints.length" class="trend-chart" aria-label="未来资金折线图">
          <view class="trend-chart__grid trend-chart__grid--top"/><view class="trend-chart__grid trend-chart__grid--middle"/><view class="trend-chart__grid trend-chart__grid--bottom"/>
          <view v-for="(segment,index) in chartSegments" :key="`line-${index}`" class="trend-chart__line" :style="`left:${segment.left}%;top:${segment.top}%;width:${segment.width}%;transform:rotate(${segment.angle}deg)`"/>
          <view v-for="point in chartPoints" v-show="point.top!==null" :key="point.on" class="trend-chart__point" :class="{'trend-chart__point--minimum':point.minimum}" :style="`left:${point.left}%;top:${point.top??0}%`"><text>{{ yuan(point.value) }}</text></view>
          <view class="trend-chart__labels"><text v-for="point in chartPoints" :key="point.on">{{ shortDate(point.on) }}</text></view>
        </view>
        <text v-else class="trend-chart__empty">已登记日期不足，暂时无法绘制走势。</text>
        <button class="text-action" @tap="activeSheet='impact'">查看 30 天完整分析 ›</button>
      </SectionCard>
      <StatePanel v-else :title="rollingLoading?'正在计算逐日资金':'暂无完整 30 天预测'" :detail="overview.currentPeriod.value?'资金依据或相邻月份规划尚未齐全。':'先建立并激活本月计划，才能查看未来走势。'" />
      <SectionCard v-if="rollingForecast?.minimumCashOn" class="minimum-card">
        <text class="minimum-card__title">最低日原因 · {{ shortDate(rollingForecast.minimumCashOn) }}</text>
        <view v-if="minimumCauses.length" class="cause-list"><text v-for="cause in minimumCauses" :key="cause.id">{{ cause.name }} {{ cause.deltaMinor>0?'+':'' }}{{ yuan(cause.deltaMinor) }}</text></view>
        <text v-else class="minimum-card__note">当天没有新增安排，之前日期的资金变动仍会影响余额。</text>
        <button class="text-action" @tap="askAboutMinimum">就这一天问行止 ›</button>
      </SectionCard>
      <view class="ai-entry" @tap="switchTab('/pages/ai/index')"><IpAvatar size="small"/><view class="ai-entry__copy"><text>问问行止</text><text>看看本月安排，先解释再由你决定</text></view><text class="ai-entry__arrow">›</text></view>
      <SectionHeader title="未来安排" />
      <SectionCard v-if="visibleTimeline.length" class="timeline-card">
        <view v-for="item in visibleTimeline" :key="item.id" class="timeline-row">
          <text class="timeline-row__date">{{ shortDate(item.on) }}</text>
          <view class="timeline-row__copy"><text>{{ item.title }}</text><text>{{ item.kind }} · {{ !item.included?'未计入预测现金':rollingForecast?.status==='unknown'?'预测待核验':'已纳入预测' }}</text></view>
          <text class="timeline-row__amount amount">{{ yuan(item.amountMinor) }}</text>
        </view>
        <button v-if="timeline.length>5" class="text-action" @tap="expandedTimeline=!expandedTimeline">{{ expandedTimeline?'收起安排':`查看全部 ${timeline.length} 项` }}</button>
      </SectionCard>
      <StatePanel v-else title="未来 30 天暂无已登记安排" detail="新增房租、还款或预计收入后，会按日期显示在这里。" />
      <SectionHeader title="需要留意" :action="pendingActions.length ? '查看待办' : undefined" @action="activeSheet='pending'" />
      <view v-if="attention.length" class="attention-list">
        <view v-for="item in attention" :key="item.id" class="attention-row" @tap="openPending(item)"><view><text class="attention-row__title">{{ item.title }}</text><text class="attention-row__detail">{{item.detail}}</text></view><view class="attention-row__amount"><text v-if="item.amountMinor!==undefined" class="amount">{{ yuan(item.amountMinor) }}</text><text>›</text></view></view>
      </view>
      <StatePanel v-else title="当前没有需要立即处理的事项" detail="新的资金事实出现后，会在这里提示。" />
      <view v-if="pendingError" class="notice notice--warning pending-error">部分待办暂时未能同步：{{pendingError}}</view>
      <SectionHeader title="近期计划" action="查看全部" @action="switchTab('/pages/plan/index')" />
      <view v-if="planItems.length" class="plan-grid">
        <SectionCard v-for="item in planItems" :key="item.itemId" class="plan-card" @tap="showPlan(item)"><text class="plan-card__date">{{ shortDate(item.plannedOn) }}</text><text class="plan-card__title">{{ item.title }}</text><text class="plan-card__amount amount">{{ yuan(item.userEstimatedAmountMinor) }}</text><StatusBadge :label="`周期整体：${fundingLabel(forecastStatus)}`" :tone="statusTone(forecastStatus)" /></SectionCard>
      </view>
      <StatePanel v-else title="还没有近期计划" detail="可以从计划页建立草稿，或直接问问行止。" />
      <SectionHeader title="最近账目" action="查看全部" @action="switchTab('/pages/ledger/index')" />
      <SectionCard v-if="recentLedger.length" class="ledger-card">
        <view v-for="entry in recentLedger" :key="entry.entryId" class="ledger-row" @tap="showLedger(entry)"><view><text class="ledger-row__name">{{ entry.summary || categoryLabel(entry.displayCategory) }}</text><text class="ledger-row__time">{{ categoryLabel(entry.displayCategory) }} · {{ shortDate(entry.occurredAt) }}</text></view><view class="ledger-row__end"><text class="ledger-row__amount amount" :class="{'ledger-row__amount--in':entry.direction==='inflow'}">{{ entry.direction==='inflow'?'+':'-' }}{{ yuan(entry.amountMinor) }}</text><text class="ledger-row__arrow">›</text></view></view>
      </SectionCard>
      <StatePanel v-else title="暂无已发生账目" detail="预计收入与待到账退款不会显示成已入账。" />
    </template>
  </PageShell>

  <BottomSheet above-tab-bar :model-value="activeSheet!==null" :title="sheetCopy.title" :description="sheetCopy.description" :primary-text="sheetCopy.primary" @update:model-value="value=>{if(!value)activeSheet=null}" @primary="handleSheetPrimary">
    <template v-if="activeSheet==='pending'">
      <view v-if="pendingActions.length" class="sheet-list"><view v-for="item in pendingActions" :key="item.id" class="sheet-list__item" @tap="openPending(item)"><view><text>{{ item.title }}</text><text>{{item.detail}}</text></view><text v-if="item.amountMinor!==undefined" class="amount">{{ yuan(item.amountMinor) }}</text></view></view>
      <StatePanel v-else title="暂时没有待处理事项" detail="出现需要确认的变化时，会在这里提醒你。" />
    </template>
    <template v-else-if="activeSheet==='impact'"><FactRow label="未来 30 天预计最低余额" :value="yuan(rollingForecast?.minimumProjectedCashMinor)" emphasis/><FactRow label="本月保留目标" :value="yuan(overview.currentPeriod.value?.basis.savingsTargetMinor)"/><FactRow label="最低日与当日目标差额" :value="yuan(rollingHeadroom)"/><FactRow label="30 天最低缓冲" :value="yuan(rollingForecast?.minimumSavingsHeadroomMinor)"/><FactRow label="关键日期" :value="shortDate(rollingForecast?.minimumCashOn)"/><FactRow label="30 天结论" :value="rollingForecast?fundingLabel(rollingForecast.status):'依据不足'"/><view class="sheet-note">{{cashflowSummary}} 跨月时保留目标以当日规划为准；预计收入与待核退款不提前计入现金。缺相邻月规划时后续日期显示未知。</view></template>
    <template v-else-if="activeSheet==='obligation' && selectedObligation"><FactRow label="待处理金额" :value="yuan(selectedObligation.remainingDueMinor??selectedObligation.amountDueMinor)" emphasis/><FactRow label="预计日期" :value="shortDate(selectedObligation.dueOn)"/><FactRow label="当前状态" :value="selectedObligation.status==='overdue'?'已逾期':'尚未发生'"/><view class="sheet-note">未来义务与已入账支出分开显示，不会提前记到账目中。</view></template>
    <template v-else-if="activeSheet==='plan' && selectedPlan"><FactRow label="原计划估价" :value="yuan(selectedPlan.userEstimatedAmountMinor)" emphasis/><FactRow label="计划日期" :value="shortDate(selectedPlan.plannedOn)"/><FactRow label="预计最低余额" :value="yuan(overview.currentPeriod.value?.basis.minimumProjectedCashMinor)"/><FactRow label="周期整体状态" :value="fundingLabel(forecastStatus)"/></template>
    <template v-else-if="activeSheet==='ledger' && selectedLedger"><view class="ledger-detail-amount amount" :class="{'ledger-detail-amount--in':selectedLedger.direction==='inflow'}">{{ selectedLedger.direction==='inflow'?'+':'-' }}{{ yuan(selectedLedger.amountMinor) }}</view><FactRow label="状态" :value="selectedLedger.status==='posted'?'已入账':selectedLedger.status==='reversed'?'已冲正':'处理中'"/><FactRow label="分类" :value="categoryLabel(selectedLedger.displayCategory)"/><FactRow label="发生时间" :value="shortDate(selectedLedger.occurredAt)"/><FactRow label="账户" :value="overview.primaryAccount.value?.account.displayName??'—'"/></template>
  </BottomSheet>
</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.retry{margin:24px auto 0}.pending-button{position:absolute;z-index:4;top:calc(40px + env(safe-area-inset-top));right:30px;display:flex;width:66px;height:66px;align-items:center;justify-content:center;padding:0;color:$brand-deep;background:rgba(255,255,255,.66);border:1px solid rgba(255,255,255,.86);border-radius:50%;box-shadow:$shadow-card}.pending-button__bell{font-size:36px;line-height:1}.pending-button__count{position:absolute;right:-4px;top:-4px;display:flex;min-width:30px;height:30px;align-items:center;justify-content:center;padding:0 7px;color:#fff;background:$danger;border:3px solid #EDF3EF;border-radius:999px;font-size:18px;line-height:1}
.summary-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}.summary-card{position:relative;display:flex;min-width:0;min-height:272px;flex-direction:column;overflow:hidden}.summary-card::after{position:absolute;right:-46px;bottom:-54px;width:150px;height:150px;border:24px solid rgba(47,111,90,.035);border-radius:50%;content:'';pointer-events:none}.summary-card--forecast{background:linear-gradient(155deg,#FFFFFF 0%,#F5FAF7 100%)}.summary-card__heading{position:relative;z-index:1;display:flex;min-width:0;align-items:center;justify-content:space-between;gap:10px}.summary-card__identity{display:flex;min-width:0;align-items:center;gap:13px}.summary-card__icon{position:relative;display:flex;flex:0 0 50px;width:50px;height:50px;align-items:center;justify-content:center;color:$brand-primary;background:$surface-tint;border:1px solid rgba(47,111,90,.08);border-radius:15px}.summary-card__icon--account::before{width:27px;height:19px;border:3px solid currentColor;border-radius:5px;content:''}.account-icon__stripe{position:absolute;left:12px;top:20px;width:26px;height:3px;background:currentColor}.account-icon__chip{position:absolute;right:13px;bottom:13px;width:7px;height:5px;background:currentColor;border-radius:2px}.summary-card__icon--forecast{align-items:flex-end;gap:3px;padding-bottom:11px}.forecast-icon__bar{width:5px;background:currentColor;border-radius:4px 4px 1px 1px}.forecast-icon__bar--one{height:9px}.forecast-icon__bar--two{height:15px}.forecast-icon__bar--three{height:23px}.forecast-icon__line{position:absolute;left:11px;top:15px;width:28px;height:13px;border-top:3px solid currentColor;transform:rotate(-20deg)}.summary-card__eyebrow,.summary-card__label,.summary-card__meta,.summary-card__amount,.summary-card__foot{display:block}.summary-card__eyebrow{margin-bottom:2px;color:$text-tertiary;font-size:17px;line-height:1.2}.summary-card__label{min-width:0;font-size:25px;font-weight:720;line-height:1.3;white-space:nowrap}.summary-card__meta{position:relative;z-index:1;margin-top:20px;color:$text-secondary;font-size:20px;line-height:1.35}.summary-card__amount{position:relative;z-index:1;margin-top:7px;font-size:40px;font-weight:760;line-height:1.2;white-space:nowrap}.summary-card__amount--state{font-size:30px;letter-spacing:.02em}.summary-card__footer{position:relative;z-index:1;display:flex;align-items:center;justify-content:space-between;margin-top:auto;padding-top:17px}.summary-card__state{display:inline-flex;align-items:center;padding:7px 10px;color:$brand-deep;background:rgba(232,240,236,.92);border-radius:999px;font-size:17px;line-height:1.2}.summary-card__dot{width:7px;height:7px;margin-right:7px;background:$brand-primary;border-radius:50%}.summary-card__arrow{color:$brand-primary;font-size:34px;line-height:1}.summary-card__foot{position:relative;z-index:1;margin-top:10px;color:$text-tertiary;font-size:18px;line-height:1.35}.visibility-button{display:inline-flex;flex:0 0 auto;width:auto;align-items:center;justify-content:center;padding:7px 10px;color:$text-tertiary;background:$soft-surface;border-radius:999px;font-size:17px;line-height:1.2;white-space:nowrap}
.forecast-error{margin-top:14px}.forecast-card__lead{display:flex;align-items:flex-start;gap:16px}.forecast-card__lead-icon{display:flex;flex:0 0 52px;height:52px;align-items:center;justify-content:center;color:$brand-primary;background:$surface-tint;border-radius:16px;font-size:24px;font-weight:760}.forecast-card__summary,.forecast-card__note,.minimum-card__title,.minimum-card__note{display:block}.forecast-card__summary{font-size:29px;font-weight:700;line-height:1.5}.forecast-card__note,.minimum-card__note{margin-top:6px;color:$text-secondary;font-size:24px;line-height:1.5}.daily-list{margin-top:20px;border-top:1px solid $border}.daily-row{display:flex;justify-content:space-between;gap:16px;padding:13px 0;border-bottom:1px solid $border;font-size:26px}.daily-row text:last-child{font-weight:650}.daily-row--minimum{color:$brand-deep}.daily-row--unknown{color:$text-tertiary;border-bottom-style:dashed}.daily-row--unknown text:last-child{font-weight:400}.text-action{width:100%;margin-top:14px;padding:12px;color:$brand-primary;background:transparent;font-size:25px}.minimum-card{margin-top:14px;background:$soft-surface}.minimum-card__title{font-size:27px;font-weight:700}.cause-list{display:grid;gap:7px;margin-top:10px;color:$text-secondary;font-size:25px}.timeline-card{padding-block:8px}.timeline-row{display:flex;align-items:flex-start;gap:14px;padding:17px 0}.timeline-row+.timeline-row{border-top:1px solid $border}.timeline-row__date{flex:0 0 96px;color:$text-secondary;font-size:24px}.timeline-row__copy{flex:1;min-width:0}.timeline-row__copy text{display:block;font-size:26px;line-height:1.35}.timeline-row__copy text+text{margin-top:5px;color:$text-tertiary;font-size:23px}.timeline-row__amount{font-size:25px;font-weight:680;white-space:nowrap}
.ai-entry{display:flex;align-items:center;gap:20px;margin-top:16px;padding:20px 24px;background:rgba(255,255,255,.72);border:1px solid rgba(255,255,255,.85);border-radius:20px;box-shadow:$shadow-card}.ai-entry__copy{flex:1}.ai-entry__copy text{display:block;font-size:30px;font-weight:650}.ai-entry__copy text+text{margin-top:6px;color:$text-secondary;font-size:25px;font-weight:400}.ai-entry__arrow{color:$brand-primary;font-size:42px}
.attention-list{overflow:hidden;background:#FFFBF4;border:1px solid #EAD3B0;border-radius:20px}.attention-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:24px}.attention-row+.attention-row{border-top:1px solid #F0DFC4}.attention-row text{display:block}.attention-row__title{font-size:29px;font-weight:650}.attention-row__detail{margin-top:7px;color:$text-secondary;font-size:24px}.attention-row__amount{display:flex;align-items:center;gap:10px;color:$text-secondary}.attention-row__amount .amount{color:$text-primary;font-weight:650}
.plan-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}.plan-card{display:flex;min-width:0;flex-direction:column}.plan-card text{display:block}.plan-card__date{color:$text-secondary;font-size:25px;line-height:1.3}.plan-card__title{display:-webkit-box;min-height:2.6em;margin-top:8px;overflow:hidden;font-size:30px;font-weight:680;line-height:1.3;-webkit-box-orient:vertical;-webkit-line-clamp:2}.plan-card__amount{margin:16px 0;font-size:34px;font-weight:720;line-height:1.2;white-space:nowrap}.plan-card .status-badge{align-self:flex-start;margin-top:auto}
.ledger-card{padding-block:8px}.ledger-row{display:flex;align-items:center;justify-content:space-between;padding:20px 4px}.ledger-row+.ledger-row{border-top:1px solid $border}.ledger-row text{display:block}.ledger-row__name{font-size:29px;font-weight:600}.ledger-row__time{margin-top:5px;color:$text-tertiary;font-size:24px}.ledger-row__end{display:flex;align-items:center;gap:12px}.ledger-row__amount{font-weight:680}.ledger-row__amount--in,.ledger-detail-amount--in{color:$success}.ledger-row__arrow{color:$text-tertiary;font-size:32px}
.pending-error{margin-top:14px}.sheet-list{overflow:hidden;border:1px solid $border;border-radius:18px}.sheet-list__item{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:20px}.sheet-list__item+.sheet-list__item{border-top:1px solid $border}.sheet-list__item text{display:block}.sheet-list__item view text:first-child{font-size:28px;font-weight:620}.sheet-list__item view text+text{margin-top:6px;color:$text-secondary;font-size:24px}.sheet-list__item>.amount{font-weight:680}.sheet-note{margin-top:22px;padding:18px 20px;color:$text-secondary;background:$soft-surface;border-radius:16px;font-size:25px;line-height:1.55}.ledger-detail-amount{margin-bottom:20px;font-size:44px;font-weight:760}
.trend-chart{position:relative;height:260px;margin-top:24px;overflow:visible;background:linear-gradient(180deg,rgba(232,240,236,.42),rgba(255,255,255,0));border-radius:18px}.trend-chart__grid{position:absolute;left:4%;right:4%;height:1px;background:rgba(47,111,90,.12)}.trend-chart__grid--top{top:16%}.trend-chart__grid--middle{top:47%}.trend-chart__grid--bottom{top:78%}.trend-chart__line{position:absolute;z-index:2;height:5px;background:$brand-primary;border-radius:999px;transform-origin:left center}.trend-chart__point{position:absolute;z-index:3;width:15px;height:15px;background:#fff;border:5px solid $brand-primary;border-radius:50%;transform:translate(-50%,-50%)}.trend-chart__point text{position:absolute;left:50%;top:-34px;color:$brand-deep;font-size:18px;font-weight:650;white-space:nowrap;transform:translateX(-50%)}.trend-chart__point--minimum{border-color:#D08A35}.trend-chart__labels{position:absolute;left:2%;right:2%;bottom:5px;display:flex;justify-content:space-between;color:$text-tertiary;font-size:18px}.trend-chart__empty{display:block;margin-top:20px;color:$text-secondary;font-size:24px}
.trend-chart{height:240px;overflow:hidden}.trend-chart__labels{bottom:8px}.trend-chart__empty{display:block;margin-top:20px;color:$text-secondary;font-size:24px}

/* 两张首页核心卡片用原生 view 渲染，避免真机自定义组件节点丢失。 */
.summary-grid{display:flex;width:100%;align-items:stretch;gap:24px}.summary-card.section-card{flex:1 1 0;min-width:0;min-height:336px;padding:28px;border:1px solid $border;border-radius:$radius-card;box-shadow:none}.summary-card--account{background:$surface-tint}.summary-card--forecast{background:linear-gradient(155deg,$card 0%,$accent-blue 145%)}.summary-card__identity{gap:16px}.summary-card__label{font-size:32px;font-weight:600;line-height:1.4;white-space:normal}.summary-card__meta{margin-top:20px;font-size:28px}.summary-card__amount{margin-top:8px;font-size:48px;font-weight:700;line-height:1.2;white-space:normal;overflow-wrap:anywhere}.summary-card__amount--state{font-size:36px}.summary-card__state{min-height:48px;padding:8px 12px;font-size:26px}.summary-card__foot{font-size:26px;line-height:1.45}.visibility-button{min-width:76px;min-height:64px;padding:8px 10px;color:$brand-primary;background:rgba(255,255,255,.72);font-size:24px}
.urgent-brief{display:flex;width:100%;min-height:88px;align-items:center;justify-content:space-between;gap:20px;margin-top:24px;padding:16px 24px;color:$warning;background:$warning-surface;border:1px solid rgba(133,80,26,.16);border-radius:24px;text-align:left}.urgent-brief view{flex:1;min-width:0}.urgent-brief text{display:block;font-size:28px;line-height:1.45}.urgent-brief view text:first-child{font-weight:600}.urgent-brief view text+text{margin-top:4px;color:$text-secondary;font-size:26px}.urgent-brief>text{flex:0 0 auto;font-size:40px}
.forecast-card{border-radius:$radius-card}.forecast-card__lead-icon{flex-basis:64px;height:64px;border-radius:20px;font-size:28px}.forecast-card__summary{font-size:32px;font-weight:600}.forecast-card__note,.minimum-card__note{font-size:28px}.trend-chart{height:288px;border-radius:24px}.trend-chart__point text,.trend-chart__labels{font-size:22px}.text-action{min-height:88px;font-size:28px}.minimum-card{margin-top:24px;border-radius:$radius-card}.minimum-card__title{font-size:32px}.cause-list{font-size:28px}
.ai-entry{gap:24px;margin-top:24px;padding:24px 28px;background:$surface-tint;border:1px solid rgba(38,125,98,.12);border-radius:$radius-card;box-shadow:none}.ai-entry__copy text{font-size:32px;font-weight:600}.ai-entry__copy text+text{font-size:28px}.attention-list,.ledger-card,.sheet-list{border-radius:$radius-card}.attention-row{padding:28px 32px}.attention-row__title,.ledger-row__name{font-size:32px}.attention-row__detail,.ledger-row__time{font-size:28px}.plan-grid{gap:24px}.plan-card__title{font-size:32px}.plan-card__amount{font-size:36px}.ledger-row{min-height:128px;padding:24px 4px}.ledger-row__amount{font-size:36px}.sheet-note{font-size:28px}.ledger-detail-amount{font-size:64px}
@media screen and (max-width:360px){.summary-grid{gap:20px}.summary-card.section-card{min-height:360px;padding:24px}.summary-card__identity{display:block}.summary-card__label{margin-top:10px;font-size:30px}.summary-card__amount{font-size:42px}.summary-card__amount--state{font-size:34px}.summary-card__foot{font-size:24px}.visibility-button{position:absolute;right:18px;top:18px}.plan-grid{grid-template-columns:1fr}.attention-row,.ledger-row,.sheet-list__item{align-items:flex-start}.attention-row__amount,.ledger-row__end{flex:0 0 auto}.plan-card__amount{white-space:normal}.timeline-row{flex-wrap:wrap}.timeline-row__date{flex-basis:82px}.ai-entry{gap:18px;padding:22px 24px}}
</style>
