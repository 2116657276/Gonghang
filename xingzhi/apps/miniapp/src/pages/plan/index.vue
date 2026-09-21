<script setup lang="ts">
import { computed, ref } from 'vue';
import Taro, { useDidShow } from '@tarojs/taro';
import BottomSheet from '@/components/BottomSheet.vue';
import FactRow from '@/components/FactRow.vue';
import PageShell from '@/components/PageShell.vue';
import PlanItemCard from '@/components/PlanItemCard.vue';
import SectionCard from '@/components/SectionCard.vue';
import SectionHeader from '@/components/SectionHeader.vue';
import StatePanel from '@/components/StatePanel.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { useOverview } from '@/composables/useOverview';
import { fundingLabel, shortDate, yuan } from '@/lib/format';
import type { BudgetItem, BudgetPeriod } from '@/lib/types';

type PlanGroup = 'active' | 'attention' | 'draft';
type PlanViewItem = { item: BudgetItem; period: BudgetPeriod; group: PlanGroup };

const overview = useOverview();
const filter = ref<'all' | PlanGroup>('all');
const impactOpen = ref(false);
const selected = ref<PlanViewItem | null>(null);
useDidShow(() => { void overview.load(); });

const currentStatus = computed(() => overview.currentPeriod.value?.forecast.status ?? 'unknown');
const tone = (status: string) => status === 'allowed' ? 'success' : status === 'unknown' ? 'info' : 'warning';

const viewItems = computed<PlanViewItem[]>(() => overview.periods.value.flatMap(period => period.items
  .filter(item => item.status !== 'cancelled' && item.status !== 'settled')
  .map(item => ({
    item,
    period,
    group: period.period.status === 'draft'
      ? 'draft' as const
      : period.forecast.status === 'allowed'
        ? 'active' as const
        : 'attention' as const,
  }))));

const grouped = computed(() => ({
  active: viewItems.value.filter(item => item.group === 'active'),
  attention: viewItems.value.filter(item => item.group === 'attention'),
  draft: viewItems.value.filter(item => item.group === 'draft'),
}));

const visibleGroups = computed(() => {
  const all = [
    { key: 'active' as const, title: '进行中', items: grouped.value.active },
    { key: 'attention' as const, title: '需留意', items: grouped.value.attention },
    { key: 'draft' as const, title: '草稿', items: grouped.value.draft },
  ];
  return filter.value === 'all' ? all.filter(group => group.items.length) : all.filter(group => group.key === filter.value);
});

function supportingText(view: PlanViewItem) {
  if (view.group === 'draft') return '还未改变正式资金安排';
  if (view.group === 'attention' && view.period.forecast.shortfallMinor) return `本周期预计缺口 ${yuan(view.period.forecast.shortfallMinor)}`;
  if (view.group === 'attention') return `本周期${fundingLabel(view.period.forecast.status)}`;
  return `本周期预计最低 ${yuan(view.period.basis.minimumProjectedCashMinor)}`;
}

function openItem(view: PlanViewItem) { selected.value = view; }
function openSelectedDetail() { if(!selected.value)return;const value=selected.value;selected.value=null;void Taro.navigateTo({url:`/pages/item/detail?periodId=${value.period.period.periodId}&itemId=${value.item.itemId}`}); }
function openCurrentPeriod() { const id=overview.currentPeriod.value?.period.periodId;if(id)void Taro.navigateTo({url:`/pages/period/detail?id=${id}`});else void Taro.navigateTo({url:'/pages/period/edit'}); }
function askAi() { void Taro.switchTab({ url: '/pages/ai/index' }); }
</script>

<template>
  <PageShell title="我的计划" subtitle="把想做的事，放进可执行的安排里">
    <StatePanel v-if="overview.loading.value" title="正在整理计划" detail="计划与已发生账目会分开显示。" />
    <StatePanel v-else-if="overview.error.value" title="计划暂时不可用" :detail="overview.error.value" tone="error"><button class="secondary-button retry" @tap="overview.load">重新加载</button></StatePanel>
    <template v-else>
      <SectionCard class="period-overview" @tap="impactOpen=true">
        <view class="row-between">
          <view><text class="period-overview__eyebrow">本月计划概览</text><text class="period-overview__title">{{ overview.currentPeriod.value?.period.monthStart.slice(0,7).replace('-','年')+'月' || '尚未建立预算周期' }}</text></view>
          <button class="round-add" aria-label="新建计划" @tap.stop="Taro.navigateTo({url:'/pages/period/edit'})">＋</button>
        </view>
        <view class="metrics"><view><text>保留目标</text><b>{{ yuan(overview.currentPeriod.value?.basis.savingsTargetMinor) }}</b></view><view><text>必要安排</text><b>{{ yuan(overview.currentPeriod.value?.basis.essentialRemainingMinor) }}</b></view><view><text>可调计划</text><b>{{ yuan(overview.currentPeriod.value?.basis.adjustablePlannedMinor) }}</b></view></view>
        <view class="overview-status"><StatusBadge :label="fundingLabel(currentStatus)" :tone="tone(currentStatus)"/><text>预计最低 {{ yuan(overview.currentPeriod.value?.basis.minimumProjectedCashMinor) }} ›</text></view>
      </SectionCard>

      <scroll-view class="chips" scroll-x>
        <button v-for="item in [{k:'all',n:'全部'},{k:'active',n:'进行中'},{k:'attention',n:'需留意'},{k:'draft',n:'草稿'}]" :key="item.k" class="chip" :class="[`chip--${item.k}`,{'chip--active':filter===item.k}]" @tap="filter=item.k as typeof filter">{{ item.n }}</button>
      </scroll-view>

      <template v-if="visibleGroups.some(group=>group.items.length)">
        <view v-for="group in visibleGroups" :key="group.key" class="plan-section">
          <SectionHeader :title="group.title" />
          <view class="plan-list"><PlanItemCard v-for="view in group.items" :key="view.item.itemId" :item="view.item" :group="view.group" :forecast-status="view.period.forecast.status" :supporting-text="supportingText(view)" @open="openItem(view)"/></view>
        </view>
      </template>
      <StatePanel v-else title="当前筛选下没有计划" detail="可以新建草稿，正式改变资金安排时仍需单独确认。" />

      <view class="ai-tip" @tap="askAi"><view><text class="ai-tip__title">不知道怎么安排？</text><text class="ai-tip__detail">把想法告诉行止，先形成草稿，再由你决定。</text></view><text class="ai-tip__arrow">›</text></view>
      <button class="secondary-button review-button" :disabled="!overview.currentPeriod.value" @tap="overview.currentPeriod.value&&Taro.navigateTo({url:`/pages/review/index?periodId=${overview.currentPeriod.value.period.periodId}`})">查看本月复盘</button>
    </template>
  </PageShell>

  <BottomSheet :model-value="impactOpen" title="本月资金影响" description="摘要来自当前周期的服务端事实。" primary-text="查看完整分析" @update:model-value="impactOpen=$event" @primary="impactOpen=false;openCurrentPeriod()">
    <FactRow label="保留目标" :value="yuan(overview.currentPeriod.value?.basis.savingsTargetMinor)"/>
    <FactRow label="必要安排" :value="yuan(overview.currentPeriod.value?.basis.essentialRemainingMinor)"/>
    <FactRow label="可调计划" :value="yuan(overview.currentPeriod.value?.basis.adjustablePlannedMinor)"/>
    <FactRow label="预计最低余额" :value="yuan(overview.currentPeriod.value?.basis.minimumProjectedCashMinor)" emphasis/>
    <FactRow label="关键日期" :value="shortDate(overview.currentPeriod.value?.basis.minimumCashOn)"/>
    <FactRow label="当前结论" :value="fundingLabel(currentStatus)"/>
  </BottomSheet>

  <BottomSheet :model-value="selected!==null" :title="selected?.item.title??'计划详情'" description="这是当前计划与周期资金状态的快速摘要。" primary-text="查看计划详情" @update:model-value="value=>{if(!value)selected=null}" @primary="openSelectedDetail">
    <template v-if="selected"><FactRow label="计划金额" :value="yuan(selected.item.userEstimatedAmountMinor)" emphasis/><FactRow label="计划日期" :value="shortDate(selected.item.plannedOn)"/><FactRow label="安排属性" :value="selected.item.priority==='required'?'必须保留':'可以调整'"/><FactRow label="计划状态" :value="selected.item.status==='committed'?'已形成承诺':selected.group==='draft'?'草稿':'计划中'"/><FactRow label="周期资金结论" :value="fundingLabel(selected.period.forecast.status)"/></template>
  </BottomSheet>
</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.retry{margin:24px auto 0}.period-overview__eyebrow,.period-overview__title{display:block}.period-overview__eyebrow{color:$text-secondary;font-size:21px}.period-overview__title{margin-top:8px;font-size:32px;font-weight:720}.round-add{display:flex;flex:0 0 66px;width:66px;height:66px;align-items:center;justify-content:center;padding:0;color:#fff;background:$brand-primary;border-radius:50%;font-size:36px;line-height:1}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:28px}.metrics view{min-width:0;padding-top:18px;border-top:1px solid $border}.metrics text,.metrics b{display:block}.metrics text{color:$text-secondary;font-size:20px;line-height:1.35}.metrics b{margin-top:8px;font-size:26px;line-height:1.2;white-space:nowrap}.overview-status{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:24px;padding-top:20px;border-top:1px solid $border;color:$text-secondary;font-size:21px}
.chips{margin:22px 0 2px;white-space:nowrap}.chip{display:inline-flex;width:auto;align-items:center;justify-content:center;margin-right:12px;padding:16px 28px;color:$text-secondary;background:#EDF2EF;border-radius:999px;font-size:23px;line-height:1.2;white-space:nowrap}.chip--active{color:$brand-primary;background:$surface-tint}.chip--attention.chip--active{color:#8A5B1F;background:$warning-surface}.chip--draft.chip--active{color:$text-secondary;background:#E8ECEA}.plan-section+.plan-section{margin-top:4px}.plan-list{display:grid;gap:14px}.ai-tip{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-top:30px;padding:24px 26px;background:linear-gradient(135deg,#EDF5F0,#F8FAF9);border:1px solid $border;border-radius:20px}.ai-tip text{display:block}.ai-tip__title{color:$brand-deep;font-size:26px;font-weight:680}.ai-tip__detail{margin-top:7px;color:$text-secondary;font-size:21px}.ai-tip__arrow{color:$brand-primary;font-size:40px}.review-button{width:100%;margin-top:16px}
@media screen and (max-width:360px){.metrics{grid-template-columns:1fr;gap:0}.metrics view{display:flex;align-items:center;justify-content:space-between;gap:14px}.metrics b{margin-top:0;white-space:normal}.overview-status{align-items:flex-start}.ai-tip{gap:14px;padding:20px 22px}.round-add{flex-basis:58px;width:58px;height:58px}}
</style>
