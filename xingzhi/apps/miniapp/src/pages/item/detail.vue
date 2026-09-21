<script setup lang="ts">
import { computed, ref } from 'vue';
import Taro, { useDidShow, useLoad } from '@tarojs/taro';
import FactRow from '@/components/FactRow.vue';
import PageShell from '@/components/PageShell.vue';
import SectionCard from '@/components/SectionCard.vue';
import SectionHeader from '@/components/SectionHeader.vue';
import StatePanel from '@/components/StatePanel.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { fundingLabel, shortDate, yuan } from '@/lib/format';
import type { BudgetItem, BudgetPeriod, PeriodEvent, PurchaseIntent } from '@/lib/types';

const periodId = ref('');
const itemId = ref('');
const period = ref<BudgetPeriod | null>(null);
const intents = ref<PurchaseIntent[]>([]);
const events = ref<PeriodEvent[]>([]);
const loading = ref(true);
const error = ref('');

const item = computed<BudgetItem | null>(() => period.value?.items.find(value => value.itemId === itemId.value) ?? null);
const latestIntent = computed(() => intents.value.find(value => value.periodId === periodId.value && value.budgetItemId === itemId.value) ?? null);
const canFindOffers = computed(() => period.value?.period.status === 'active' && item.value?.kind === 'planned_spend' && item.value?.status === 'planned');
const relatedEvents = computed(() => events.value.filter(event => {
  const itemMatches = event.data.itemId === itemId.value || event.data.budgetItemId === itemId.value;
  const intentMatches = latestIntent.value && event.data.purchaseIntentId === latestIntent.value.purchaseIntentId;
  const orderMatches = latestIntent.value?.orderId && event.data.orderId === latestIntent.value.orderId;
  return Boolean(itemMatches || intentMatches || orderMatches);
}).slice().reverse());
const eventLabel = (type: string) => ({ budget_item_created: '创建计划项目', budget_item_changed: '修改计划项目',
  budget_item_cancelled: '取消计划项目', purchase_intent_proposed: '生成购买确认', purchase_intent_expired: '购买确认已过期',
  purchase_intent_rejected: '放弃本次购买', purchase_committed: '确认购买并建立订单', payment_handoff_requested: '进入付款处理',
  order_aftercare_accepted: '提交订单善后', verified_money_event: '核验资金结果' }[type] ?? '计划状态已更新');

useLoad((options) => { periodId.value = options.periodId ?? ''; itemId.value = options.itemId ?? ''; });
useDidShow(() => { if (periodId.value && itemId.value) void load(); });

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [periodResult, intentResult, eventResult] = await Promise.all([
      api.period(periodId.value), api.purchaseIntents(), api.periodEvents(periodId.value),
    ]);
    period.value = periodResult.data;
    intents.value = intentResult.data.intents;
    events.value = eventResult.data.events;
  } catch (reason) {
    error.value = errorMessage(reason);
  } finally {
    loading.value = false;
  }
}

function edit() { void Taro.navigateTo({url:`/pages/item/edit?periodId=${periodId.value}&itemId=${itemId.value}`}); }
function impact() { void Taro.navigateTo({url:`/pages/impact/detail?periodId=${periodId.value}&itemId=${itemId.value}`}); }
function offers() { void Taro.navigateTo({url:`/pages/offers/index?periodId=${periodId.value}&itemId=${itemId.value}`}); }
</script>

<template>
  <PageShell :title="item?.title ?? '计划详情'" subtitle="一个计划的状态、影响与下一步" compact>
    <template #hero><button class="back" aria-label="返回" @tap="Taro.navigateBack()">‹</button></template>
    <StatePanel v-if="loading" title="正在读取计划详情" />
    <StatePanel v-else-if="error || !period || !item" title="计划详情暂时不可用" :detail="error || '没有找到对应计划项目。'" tone="error">
      <button class="secondary-button retry" @tap="load">重新加载</button>
    </StatePanel>
    <template v-else>
      <SectionCard class="summary-card">
        <view class="summary-heading"><view class="plan-icon">{{item.priority==='required'?'必':'愿'}}</view><view><text class="eyebrow">{{item.priority==='required'?'必须保留':'可以调整'}}</text><text class="plan-title">{{item.title}}</text></view><StatusBadge :label="item.status==='committed'?'已形成承诺':item.status==='planned'?'计划中':item.status" :tone="item.status==='cancelled'?'neutral':'success'"/></view>
        <text class="plan-amount amount">{{yuan(item.userEstimatedAmountMinor)}}</text>
        <view class="summary-meta"><text>{{shortDate(item.plannedOn)}}</text><text>{{item.kind==='essential_expense'?'必要支出':item.kind==='expected_income'?'预计收入':'计划消费'}}</text></view>
      </SectionCard>

      <SectionHeader title="当前资金影响" action="完整分析" @action="impact"/>
      <SectionCard class="impact-card" @tap="impact">
        <view class="row-between"><StatusBadge :label="fundingLabel(period.forecast.status)" :tone="period.forecast.status==='allowed'?'success':period.forecast.status==='unknown'?'info':'warning'"/><text class="impact-arrow">›</text></view>
        <view class="impact-grid"><view><text>预计最低余额</text><b class="amount">{{yuan(period.basis.minimumProjectedCashMinor)}}</b></view><view><text>保留目标</text><b class="amount">{{yuan(period.basis.savingsTargetMinor)}}</b></view></view>
        <FactRow v-if="period.forecast.shortfallMinor" label="预计缺口" :value="yuan(period.forecast.shortfallMinor)" emphasis/>
        <FactRow label="关键日期" :value="shortDate(period.basis.minimumCashOn)"/>
      </SectionCard>

      <SectionHeader title="购买与订单" />
      <SectionCard v-if="latestIntent" class="purchase-card">
        <view class="row-between"><view><text class="purchase-title">{{latestIntent.offerName}}</text><text class="purchase-meta">报价 {{yuan(latestIntent.quotedAmountMinor)}} · {{latestIntent.status}}</text></view><StatusBadge :label="latestIntent.orderId?'已有订单':latestIntent.status==='proposed'?'等待确认':'已结束'" :tone="latestIntent.orderId?'success':latestIntent.status==='proposed'?'info':'neutral'"/></view>
        <button v-if="latestIntent.orderId" class="primary-button full" @tap="Taro.navigateTo({url:`/pages/order/detail?id=${latestIntent.orderId}`})">查看关联订单</button>
        <button v-else-if="latestIntent.status==='proposed'" class="primary-button full" @tap="Taro.navigateTo({url:`/pages/purchase/detail?id=${latestIntent.purchaseIntentId}`})">继续购买确认</button>
        <button v-if="canFindOffers" class="secondary-button full" @tap="offers">重新查看候选与报价</button>
      </SectionCard>
      <StatePanel v-else title="还没有购买确认或订单" detail="查看候选不会自动下单，仍需要你确认报价和资金影响。">
        <button v-if="canFindOffers" class="secondary-button offers-button" @tap="offers">查看候选与报价</button>
      </StatePanel>

      <SectionHeader title="计划操作" />
      <view class="action-grid">
        <button v-if="period.period.status!=='closed'" class="secondary-button" @tap="edit">修改或取消</button>
        <button class="secondary-button" @tap="impact">重新查看影响</button>
        <button class="secondary-button action-wide" @tap="Taro.switchTab({url:'/pages/ai/index'})">让行止解释这个计划</button>
      </view>
      <view class="notice notice--info boundary">{{period.period.status==='closed'?'本周期已经归档，计划项目只读；历史影响与关联订单仍可查看。':'修改日期、金额、优先级或取消计划时，会进入独立编辑流程并重新计算资金影响。'}}</view>

      <SectionHeader title="计划行迹" />
      <SectionCard v-if="relatedEvents.length" class="timeline-card">
        <view v-for="event in relatedEvents" :key="event.id" class="timeline-row">
          <view class="timeline-dot" />
          <view><text>{{eventLabel(event.type)}}</text><text>{{shortDate(event.observedAt)}}</text></view>
        </view>
      </SectionCard>
      <StatePanel v-else title="暂无更多变更记录" detail="后续修改、购买、付款和善后会按事实记录在这里。" />
    </template>
  </PageShell>
</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.back{position:absolute;z-index:4;top:calc(34px + env(safe-area-inset-top));right:28px;width:64px;height:64px;color:$brand-deep;background:rgba(255,255,255,.72);border-radius:50%;font-size:44px}.retry{margin:20px auto 0}.summary-card{background:linear-gradient(145deg,#fff,#F3F8F5)}.summary-heading{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:start;gap:16px}.plan-icon{display:flex;width:56px;height:56px;align-items:center;justify-content:center;color:$brand-primary;background:$surface-tint;border-radius:16px;font-size:23px;font-weight:720}.eyebrow,.plan-title,.plan-amount,.summary-meta text,.purchase-title,.purchase-meta{display:block}.eyebrow{color:$text-secondary;font-size:20px}.plan-title{margin-top:6px;font-size:29px;font-weight:740;line-height:1.35;overflow-wrap:anywhere}.plan-amount{margin-top:28px;font-size:48px;font-weight:780;overflow-wrap:anywhere}.summary-meta{display:flex;flex-wrap:wrap;gap:10px 18px;margin-top:12px;color:$text-secondary;font-size:21px}.impact-card{cursor:pointer}.impact-arrow{color:$brand-primary;font-size:38px}.impact-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:20px 0 8px}.impact-grid view{min-width:0;padding:18px;background:$soft-surface;border-radius:15px}.impact-grid text,.impact-grid b{display:block}.impact-grid text{color:$text-secondary;font-size:20px}.impact-grid b{margin-top:8px;font-size:27px;overflow-wrap:anywhere}.purchase-title{font-size:26px;font-weight:700;overflow-wrap:anywhere}.purchase-meta{margin-top:7px;color:$text-secondary;font-size:20px;line-height:1.5}.full{width:100%;margin-top:16px}.offers-button{margin:18px auto 0}.action-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.action-grid button{width:100%}.action-wide{grid-column:1/-1}.boundary{margin-top:18px}.timeline-card{padding-top:10px;padding-bottom:10px}.timeline-row{display:grid;grid-template-columns:auto minmax(0,1fr);gap:14px;align-items:start;padding:15px 0}.timeline-row+.timeline-row{border-top:1px solid $border}.timeline-dot{box-sizing:content-box;width:12px;height:12px;margin-top:8px;background:$brand-primary;border:3px solid $surface-tint;border-radius:50%}.timeline-row text{display:block;font-size:22px}.timeline-row text+text{margin-top:5px;color:$text-secondary;font-size:19px}
@media screen and (max-width:360px){.summary-heading{grid-template-columns:auto minmax(0,1fr)}.summary-heading .status-badge{grid-column:2;justify-self:start}.plan-amount{font-size:40px}.impact-grid,.action-grid{grid-template-columns:1fr}.action-wide{grid-column:auto}}
</style>
