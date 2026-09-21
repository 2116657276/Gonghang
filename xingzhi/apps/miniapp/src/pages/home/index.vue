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
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { categoryLabel, fundingLabel, shortDate, yuan } from '@/lib/format';
import type { AgentRunSummary, BudgetItem, ConsumerOrder, FinanceAccountFacts, LedgerEntry, PurchaseIntent } from '@/lib/types';

type SheetName = 'pending' | 'impact' | 'obligation' | 'plan' | 'ledger' | null;
type Obligation = FinanceAccountFacts['obligations']['items'][number];
type PendingAction = { id: string; title: string; detail: string; url?: string; obligationId?: string; amountMinor?: number | null; tone: 'info' | 'warning' };

const overview = useOverview();
const activeSheet = ref<SheetName>(null);
const balanceVisible = ref(true);
const selectedObligation = ref<Obligation | null>(null);
const selectedPlan = ref<BudgetItem | null>(null);
const selectedLedger = ref<LedgerEntry | null>(null);
const intents = ref<PurchaseIntent[]>([]);
const orders = ref<ConsumerOrder[]>([]);
const agentRuns = ref<AgentRunSummary[]>([]);
const pendingError = ref('');

async function loadPending() {
  pendingError.value = '';
  try {
    const [intentResult, orderResult, runResult] = await Promise.all([api.purchaseIntents(), api.orders(), api.agentRuns()]);
    intents.value = intentResult.data.intents;
    orders.value = orderResult.data.orders;
    agentRuns.value = runResult.data.items;
  } catch (reason) { pendingError.value = errorMessage(reason); }
}
useDidShow(() => { void overview.load(); void loadPending(); });

const greeting = computed(() => `${new Date().getHours() < 12 ? '早上好' : new Date().getHours() < 18 ? '下午好' : '晚上好'}，${overview.user.value?.displayName ?? '朋友'}`);
const recentLedger = computed(() => overview.primaryAccount.value?.ledger.slice(0, 3) ?? []);
const upcoming = computed(() => overview.primaryAccount.value?.obligations.items.filter(item => ['upcoming', 'overdue'].includes(item.status)) ?? []);
const pendingActions = computed<PendingAction[]>(() => {
  const values: PendingAction[] = upcoming.value.map(item => ({ id: `obligation-${item.id}`, title: item.label,
    detail: `${shortDate(item.dueOn)} · ${item.status === 'overdue' ? '已逾期' : '未来义务'}`,
    obligationId: item.id, amountMinor: item.remainingDueMinor ?? item.amountDueMinor, tone: item.status === 'overdue' ? 'warning' : 'info' }));
  for (const intent of intents.value.filter(value => value.status === 'proposed')) {
    const expired = Date.parse(intent.expiresAt) <= Date.now();
    values.push({ id: `intent-${intent.purchaseIntentId}`, title: expired ? `${intent.offerName} 报价已过期` : `确认购买：${intent.offerName}`,
      detail: expired ? '需要重新报价和评估' : `${shortDate(intent.expiresAt)} 前确认`,
      url: `/pages/purchase/detail?id=${intent.purchaseIntentId}`, amountMinor: intent.quotedAmountMinor, tone: expired ? 'warning' : 'info' });
  }
  for (const order of orders.value) {
    if (order.paymentStatus === 'pending') values.push({ id: `order-pay-${order.orderId}`, title: `待付款：${order.itemName}`,
      detail: '继续付款或关闭订单', url: `/pages/order/detail?id=${order.orderId}`, amountMinor: order.amountMinor, tone: 'info' });
    else if (order.paymentStatus === 'unknown') values.push({ id: `order-check-${order.orderId}`, title: `付款结果待核验：${order.itemName}`,
      detail: '进入订单主动查单', url: `/pages/order/detail?id=${order.orderId}`, amountMinor: order.amountMinor, tone: 'warning' });
    if (order.status === 'cancellation_processing') values.push({ id: `refund-${order.orderId}`, title: `退款处理中：${order.itemName}`,
      detail: '查看渠道批次与到账状态', url: `/pages/refund/detail?orderId=${order.orderId}`, amountMinor: order.amountMinor - order.refundedMinor, tone: 'info' });
  }
  for (const run of agentRuns.value.filter(value => value.state === 'RUNNING')) values.push({ id: `agent-${run.id}`, title: '行止正在整理你的问题',
    detail: '可查看进度或停止运行', url: '/pages/ai/history', tone: 'info' });
  return values;
});
const attention = computed(() => pendingActions.value.slice(0, 3));
const planItems = computed(() => overview.currentPeriod.value?.items.filter(item => item.status !== 'cancelled').slice(0, 2) ?? []);
const forecastStatus = computed(() => overview.currentPeriod.value?.forecast.status ?? 'unknown');
const statusTone = (status: string) => status === 'allowed' ? 'success' : status === 'unknown' ? 'info' : 'warning';

const sheetCopy = computed(() => ({
  pending: { title: '需要你处理', description: '仅列出服务端已确认的待办与未来义务。', primary: '' },
  impact: { title: '未来 30 天资金影响', description: '以下是当前资金依据的摘要，不代表未来余额保证。', primary: '查看完整分析' },
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
function handleSheetPrimary() {
  const sheet = activeSheet.value;
  activeSheet.value = null;
  if (sheet === 'ledger') return switchTab('/pages/ledger/index');
  if (sheet === 'plan' && selectedPlan.value && overview.currentPeriod.value) return Taro.navigateTo({ url: `/pages/item/detail?periodId=${overview.currentPeriod.value.period.periodId}&itemId=${selectedPlan.value.itemId}` });
  if (sheet === 'impact' && overview.currentPeriod.value) return Taro.navigateTo({ url: `/pages/impact/detail?periodId=${overview.currentPeriod.value.period.periodId}` });
}
function openAccount() { const id=overview.primaryAccount.value?.account.accountId;if(id)void Taro.navigateTo({url:`/pages/account/detail?id=${id}`}); }
</script>

<template>
  <PageShell :title="greeting" subtitle="今天也看看钱怎么安排">
    <template #hero>
      <button class="pending-button" aria-label="查看待处理事项" @tap="activeSheet='pending'">
        <text class="pending-button__bell">⌁</text><text v-if="pendingActions.length" class="pending-button__count">{{ pendingActions.length>9?'9+':pendingActions.length }}</text>
      </button>
    </template>
    <StatePanel v-if="overview.loading.value" title="正在读取当前资金事实" detail="只展示服务端已经确认的数据。" />
    <StatePanel v-else-if="overview.error.value" title="暂时无法读取首页" :detail="overview.error.value" tone="error"><button class="secondary-button retry" @tap="overview.load">重新加载</button></StatePanel>
    <template v-else>
      <view class="summary-grid">
        <SectionCard class="summary-card" @tap="openAccount">
          <view class="summary-card__heading"><text class="summary-card__label">我的主账户</text><button class="visibility-button" @tap.stop="balanceVisible=!balanceVisible">{{ balanceVisible ? '隐藏' : '显示' }}</button></view>
          <text class="summary-card__meta">{{ overview.primaryAccount.value?.account.displayName ?? '尚未选择账户' }}</text>
          <text class="summary-card__amount amount">{{ balanceVisible ? yuan(overview.primaryAccount.value?.cashBasis.confirmedCashMinor) : '••••' }}</text>
          <text class="summary-card__foot">{{ overview.primaryAccount.value?.cashBasis.dataStatus==='observed'?'已核验可用现金':'资金依据待完善' }}</text>
        </SectionCard>
        <SectionCard class="summary-card" @tap="activeSheet='impact'">
          <text class="summary-card__label">未来 30 天</text><text class="summary-card__meta">预计最低余额</text>
          <text class="summary-card__amount amount">{{ yuan(overview.currentPeriod.value?.basis.minimumProjectedCashMinor) }}</text>
          <text class="summary-card__foot">关键日期 {{ shortDate(overview.currentPeriod.value?.basis.minimumCashOn) }}</text>
        </SectionCard>
      </view>
      <view class="ai-entry" @tap="switchTab('/pages/ai/index')"><IpAvatar size="medium"/><view class="ai-entry__copy"><text>最近想做什么？</text><text>先说想法，行止帮你理清影响</text></view><text class="ai-entry__arrow">›</text></view>
      <SectionHeader title="需要留意" :action="pendingActions.length ? '查看待办' : undefined" @action="activeSheet='pending'" />
      <view v-if="attention.length" class="attention-list">
        <view v-for="item in attention" :key="item.id" class="attention-row" @tap="openPending(item)"><view><text class="attention-row__title">{{ item.title }}</text><text class="attention-row__detail">{{item.detail}}</text></view><view class="attention-row__amount"><text v-if="item.amountMinor!==undefined" class="amount">{{ yuan(item.amountMinor) }}</text><text>›</text></view></view>
      </view>
      <StatePanel v-else title="当前没有需要立即处理的事项" detail="新的资金事实出现后，会在这里提示。" />
      <view v-if="pendingError" class="notice notice--warning pending-error">部分待办暂时未能同步：{{pendingError}}</view>
      <SectionHeader title="近期计划" action="查看全部" @action="switchTab('/pages/plan/index')" />
      <view v-if="planItems.length" class="plan-grid">
        <SectionCard v-for="item in planItems" :key="item.itemId" class="plan-card" @tap="showPlan(item)"><text class="plan-card__date">{{ shortDate(item.plannedOn) }}</text><text class="plan-card__title">{{ item.title }}</text><text class="plan-card__amount amount">{{ yuan(item.userEstimatedAmountMinor) }}</text><StatusBadge :label="fundingLabel(forecastStatus)" :tone="statusTone(forecastStatus)" /></SectionCard>
      </view>
      <StatePanel v-else title="还没有近期计划" detail="可以从计划页建立草稿，或直接问问行止。" />
      <SectionHeader title="最近账目" action="查看全部" @action="switchTab('/pages/ledger/index')" />
      <SectionCard v-if="recentLedger.length" class="ledger-card">
        <view v-for="entry in recentLedger" :key="entry.entryId" class="ledger-row" @tap="showLedger(entry)"><view><text class="ledger-row__name">{{ categoryLabel(entry.displayCategory) }}</text><text class="ledger-row__time">{{ shortDate(entry.occurredAt) }}</text></view><view class="ledger-row__end"><text class="ledger-row__amount amount" :class="{'ledger-row__amount--in':entry.direction==='inflow'}">{{ entry.direction==='inflow'?'+':'-' }}{{ yuan(entry.amountMinor) }}</text><text class="ledger-row__arrow">›</text></view></view>
      </SectionCard>
      <StatePanel v-else title="暂无已发生账目" detail="预计收入与待到账退款不会显示成已入账。" />
    </template>
  </PageShell>

  <BottomSheet :model-value="activeSheet!==null" :title="sheetCopy.title" :description="sheetCopy.description" :primary-text="sheetCopy.primary" @update:model-value="value=>{if(!value)activeSheet=null}" @primary="handleSheetPrimary">
    <template v-if="activeSheet==='pending'">
      <view v-if="pendingActions.length" class="sheet-list"><view v-for="item in pendingActions" :key="item.id" class="sheet-list__item" @tap="openPending(item)"><view><text>{{ item.title }}</text><text>{{item.detail}}</text></view><text v-if="item.amountMinor!==undefined" class="amount">{{ yuan(item.amountMinor) }}</text></view></view>
      <StatePanel v-else title="暂时没有待处理事项" detail="出现需要确认的变化时，会在这里提醒你。" />
    </template>
    <template v-else-if="activeSheet==='impact'"><FactRow label="预计最低余额" :value="yuan(overview.currentPeriod.value?.basis.minimumProjectedCashMinor)" emphasis/><FactRow label="保留目标" :value="yuan(overview.currentPeriod.value?.basis.savingsTargetMinor)"/><FactRow label="关键日期" :value="shortDate(overview.currentPeriod.value?.basis.minimumCashOn)"/><FactRow label="当前结论" :value="fundingLabel(forecastStatus)"/></template>
    <template v-else-if="activeSheet==='obligation' && selectedObligation"><FactRow label="待处理金额" :value="yuan(selectedObligation.remainingDueMinor??selectedObligation.amountDueMinor)" emphasis/><FactRow label="预计日期" :value="shortDate(selectedObligation.dueOn)"/><FactRow label="当前状态" :value="selectedObligation.status==='overdue'?'已逾期':'尚未发生'"/><view class="sheet-note">未来义务与已入账支出分开显示，不会提前记到账目中。</view></template>
    <template v-else-if="activeSheet==='plan' && selectedPlan"><FactRow label="原计划估价" :value="yuan(selectedPlan.userEstimatedAmountMinor)" emphasis/><FactRow label="计划日期" :value="shortDate(selectedPlan.plannedOn)"/><FactRow label="预计最低余额" :value="yuan(overview.currentPeriod.value?.basis.minimumProjectedCashMinor)"/><FactRow label="资金状态" :value="fundingLabel(forecastStatus)"/></template>
    <template v-else-if="activeSheet==='ledger' && selectedLedger"><view class="ledger-detail-amount amount" :class="{'ledger-detail-amount--in':selectedLedger.direction==='inflow'}">{{ selectedLedger.direction==='inflow'?'+':'-' }}{{ yuan(selectedLedger.amountMinor) }}</view><FactRow label="状态" :value="selectedLedger.status==='posted'?'已入账':selectedLedger.status==='reversed'?'已冲正':'处理中'"/><FactRow label="分类" :value="categoryLabel(selectedLedger.displayCategory)"/><FactRow label="发生时间" :value="shortDate(selectedLedger.occurredAt)"/><FactRow label="账户" :value="overview.primaryAccount.value?.account.displayName??'—'"/></template>
  </BottomSheet>
</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.retry{margin:24px auto 0}.pending-button{position:absolute;z-index:4;top:calc(40px + env(safe-area-inset-top));right:30px;display:flex;width:66px;height:66px;align-items:center;justify-content:center;padding:0;color:$brand-deep;background:rgba(255,255,255,.66);border:1px solid rgba(255,255,255,.86);border-radius:50%;box-shadow:$shadow-card}.pending-button__bell{font-size:36px;line-height:1}.pending-button__count{position:absolute;right:-4px;top:-4px;display:flex;min-width:30px;height:30px;align-items:center;justify-content:center;padding:0 7px;color:#fff;background:$danger;border:3px solid #EDF3EF;border-radius:999px;font-size:18px;line-height:1}
.summary-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}.summary-card{display:flex;min-width:0;min-height:230px;flex-direction:column}.summary-card__heading{display:flex;min-width:0;align-items:center;justify-content:space-between;gap:10px}.summary-card__label,.summary-card__meta,.summary-card__amount,.summary-card__foot{display:block}.summary-card__label{min-width:0;font-size:27px;font-weight:700;line-height:1.3;white-space:nowrap}.summary-card__meta{margin-top:18px;color:$text-secondary;font-size:21px;line-height:1.35}.summary-card__amount{margin-top:8px;font-size:42px;font-weight:750;line-height:1.2;white-space:nowrap}.summary-card__foot{margin-top:auto;padding-top:18px;color:$text-tertiary;font-size:20px;line-height:1.35}.visibility-button{display:inline-flex;flex:0 0 auto;width:auto;align-items:center;justify-content:center;padding:7px 10px;color:$text-tertiary;background:$soft-surface;border-radius:999px;font-size:18px;line-height:1.2;white-space:nowrap}
.ai-entry{display:flex;align-items:center;gap:20px;margin-top:16px;padding:20px 24px;background:rgba(255,255,255,.72);border:1px solid rgba(255,255,255,.85);border-radius:20px;box-shadow:$shadow-card}.ai-entry__copy{flex:1}.ai-entry__copy text{display:block;font-size:26px;font-weight:650}.ai-entry__copy text+text{margin-top:6px;color:$text-secondary;font-size:21px;font-weight:400}.ai-entry__arrow{color:$brand-primary;font-size:42px}
.attention-list{overflow:hidden;background:#FFFBF4;border:1px solid #EAD3B0;border-radius:20px}.attention-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:24px}.attention-row+.attention-row{border-top:1px solid #F0DFC4}.attention-row text{display:block}.attention-row__title{font-size:25px;font-weight:650}.attention-row__detail{margin-top:7px;color:$text-secondary;font-size:20px}.attention-row__amount{display:flex;align-items:center;gap:10px;color:$text-secondary}.attention-row__amount .amount{color:$text-primary;font-weight:650}
.plan-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}.plan-card{display:flex;min-width:0;flex-direction:column}.plan-card text{display:block}.plan-card__date{color:$text-secondary;font-size:21px;line-height:1.3}.plan-card__title{display:-webkit-box;min-height:2.6em;margin-top:8px;overflow:hidden;font-size:27px;font-weight:680;line-height:1.3;-webkit-box-orient:vertical;-webkit-line-clamp:2}.plan-card__amount{margin:16px 0;font-size:30px;font-weight:720;line-height:1.2;white-space:nowrap}.plan-card .status-badge{align-self:flex-start;margin-top:auto}
.ledger-card{padding-block:8px}.ledger-row{display:flex;align-items:center;justify-content:space-between;padding:20px 4px}.ledger-row+.ledger-row{border-top:1px solid $border}.ledger-row text{display:block}.ledger-row__name{font-size:25px;font-weight:600}.ledger-row__time{margin-top:5px;color:$text-tertiary;font-size:20px}.ledger-row__end{display:flex;align-items:center;gap:12px}.ledger-row__amount{font-weight:680}.ledger-row__amount--in,.ledger-detail-amount--in{color:$success}.ledger-row__arrow{color:$text-tertiary;font-size:32px}
.pending-error{margin-top:14px}.sheet-list{overflow:hidden;border:1px solid $border;border-radius:18px}.sheet-list__item{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:20px}.sheet-list__item+.sheet-list__item{border-top:1px solid $border}.sheet-list__item text{display:block}.sheet-list__item view text:first-child{font-size:24px;font-weight:620}.sheet-list__item view text+text{margin-top:6px;color:$text-secondary;font-size:20px}.sheet-list__item>.amount{font-weight:680}.sheet-note{margin-top:22px;padding:18px 20px;color:$text-secondary;background:$soft-surface;border-radius:16px;font-size:21px;line-height:1.55}.ledger-detail-amount{margin-bottom:20px;font-size:44px;font-weight:760}
@media screen and (max-width:360px){.summary-grid,.plan-grid{grid-template-columns:1fr}.summary-card{min-height:190px}.summary-card__label{white-space:normal}.summary-card__amount{font-size:38px}.attention-row,.ledger-row,.sheet-list__item{align-items:flex-start}.attention-row__amount,.ledger-row__end{flex:0 0 auto}.attention-row__detail,.ledger-row__time{line-height:1.4}.plan-card__amount{white-space:normal}.ai-entry{gap:14px;padding:18px 20px}}
</style>
