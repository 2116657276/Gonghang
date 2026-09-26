<script setup lang="ts">
import { computed, ref } from 'vue';
import Taro, { useLoad } from '@tarojs/taro';
import FactRow from '@/components/FactRow.vue';
import PageShell from '@/components/PageShell.vue';
import SectionCard from '@/components/SectionCard.vue';
import SectionHeader from '@/components/SectionHeader.vue';
import StatePanel from '@/components/StatePanel.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { fundingLabel, shortDate, yuan } from '@/lib/format';
import type { BudgetItem, BudgetItemImpact, BudgetPeriod } from '@/lib/types';

const periodId = ref('');
const itemId = ref('');
const period = ref<BudgetPeriod | null>(null);
const itemImpact = ref<BudgetItemImpact | null>(null);
const loading = ref(true);
const error = ref('');

const item = computed<BudgetItem | null>(() => period.value?.items.find(value => value.itemId === itemId.value) ?? null);
const status = computed(() => period.value?.forecast.status ?? 'unknown');
const surplus = computed(() => period.value?.basis.minimumSavingsHeadroomMinor ?? null);
const itemHeadroomImpact = computed(() => {
  const withItem = itemImpact.value?.withItem.minimumSavingsHeadroomMinor;
  const withoutItem = itemImpact.value?.withoutItem.minimumSavingsHeadroomMinor;
  return withItem === null || withItem === undefined || withoutItem === null || withoutItem === undefined
    ? null : withItem - withoutItem;
});
const minimumDay = computed(() => period.value?.forecast.daily.find(
  day => day.on === period.value?.forecast.minimumCashOn,
) ?? null);
const eventLabel = (kind: string) => ({ planned_expense: '计划支出', repayment: '还款义务',
  committed_order: '已承诺订单', confirmed_future_cash: '已确认入账' }[kind] ?? '资金事项');
const statusCopy = computed(() => ({
  allowed: { title: '符合当前资金约束', detail: '按现有账户事实和计划安排，预计不会低于保留目标。', tone: 'success' as const },
  needs_adjustment: { title: '需要调整后再继续', detail: '当前安排预计会产生缺口，可以调整金额、日期或其他可调计划。', tone: 'warning' as const },
  blocked: { title: '当前不建议继续', detail: '现有资金约束无法覆盖这项安排，请先处理缺口。', tone: 'danger' as const },
  unknown: { title: '目前还无法判断', detail: '资金事实、计划日期或必要支出信息尚不足，不能把未知当作可执行。', tone: 'info' as const },
}[status.value]));

const reasonLabels: Record<string, string> = {
  CASH_BASIS_UNKNOWN: '当前现金依据不足或已经过期',
  SNAPSHOT_STALE: '账户快照需要更新',
  MINIMUM_CASH_BELOW_TARGET: '预计最低余额低于保留目标',
  INSUFFICIENT_CONFIRMED_CASH: '已确认现金不足以覆盖当前安排',
  PERIOD_FACTS_INCOMPLETE: '本周期必要信息还没有填写完整',
  QUOTE_STALE: '候选报价已经变化，需要重新获取',
};

useLoad(async (options) => {
  periodId.value = options.periodId ?? '';
  itemId.value = options.itemId ?? '';
  try {
    period.value = (await api.period(periodId.value)).data;
    if (item.value?.status === 'planned') {
      const preview = (await api.budgetItemImpact(periodId.value, itemId.value)).data;
      if (preview.financialVersion !== period.value.basis.financialVersion
        || preview.periodVersion !== period.value.basis.periodVersion) {
        throw new Error('资金或计划依据已经变化，请返回后重新查看。');
      }
      itemImpact.value = preview;
    }
  } catch (reason) {
    error.value = errorMessage(reason);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <PageShell title="资金影响" :subtitle="item ? `正在查看：${item.title}` : '把复杂结果拆成可以核对的事实'" compact>
    <template #hero><button class="back" aria-label="返回" @tap="Taro.navigateBack()">‹</button></template>
    <StatePanel v-if="loading" title="正在计算当前资金影响" />
    <StatePanel v-else-if="error || !period" title="资金影响暂时不可用" :detail="error || '没有找到对应计划。'" tone="error" />
    <template v-else>
      <SectionCard class="result-card" :class="`result-card--${status}`">
        <view class="result-heading"><view><text class="eyebrow">当前结论</text><text class="result-title">{{statusCopy.title}}</text></view><StatusBadge :label="fundingLabel(status)" :tone="statusCopy.tone"/></view>
        <text class="result-detail">{{statusCopy.detail}}</text>
        <view class="result-number">
          <text>{{status==='allowed'?'保留目标以上余量':status==='unknown'?'当前结果':'预计缺口'}}</text>
          <b class="amount">{{status==='allowed'?yuan(surplus):status==='unknown'?'依据不足':yuan(period.forecast.shortfallMinor)}}</b>
        </view>
      </SectionCard>

      <SectionHeader title="关键影响" />
      <SectionCard>
        <FactRow label="预计最低余额" :value="yuan(period.basis.minimumProjectedCashMinor)" emphasis/>
        <FactRow label="保留目标" :value="yuan(period.basis.savingsTargetMinor)"/>
        <FactRow label="关键日期" :value="shortDate(period.basis.minimumCashOn)"/>
        <FactRow v-if="item" label="当前计划" :value="`${item.title} · ${yuan(item.userEstimatedAmountMinor)}`"/>
        <FactRow v-if="item" label="该项对最低余量的影响" :value="itemHeadroomImpact===null?'依据不足':yuan(itemHeadroomImpact)"/>
        <view v-if="minimumDay?.events.length" class="date-list"><text>最低日资金事项</text><text v-for="event in minimumDay.events" :key="`${event.kind}-${event.referenceId}`">{{eventLabel(event.kind)}} {{event.deltaMinor>0?'+':''}}{{yuan(event.deltaMinor)}}</text></view>
        <view v-if="period.forecast.affectedDates.length" class="date-list"><text>其他受影响日期</text><text>{{period.forecast.affectedDates.map(shortDate).join('、')}}</text></view>
      </SectionCard>

      <SectionHeader title="预算拆分" />
      <view class="breakdown-grid">
        <SectionCard><text>确认现金</text><b class="amount">{{yuan(period.basis.confirmedCashMinor)}}</b></SectionCard>
        <SectionCard><text>必要安排</text><b class="amount">{{yuan(period.basis.essentialRemainingMinor)}}</b></SectionCard>
        <SectionCard><text>可调计划</text><b class="amount">{{yuan(period.basis.adjustablePlannedMinor)}}</b></SectionCard>
        <SectionCard><text>已承诺订单</text><b class="amount">{{yuan(period.basis.committedOrdersMinor)}}</b></SectionCard>
      </view>

      <SectionHeader title="为什么会得到这个结论" />
      <SectionCard>
        <view v-if="period.forecast.reasonCodes.length" class="reason-list"><view v-for="reason in period.forecast.reasonCodes" :key="reason"><text class="reason-dot"/><text>{{reasonLabels[reason]??reason}}</text></view></view>
        <StatePanel v-else title="当前没有额外风险原因" detail="结论仍会随账户事实和计划变化而重新计算。"/>
      </SectionCard>

      <view class="page-actions">
        <button v-if="item" class="primary-button" @tap="Taro.navigateTo({url:`/pages/item/detail?periodId=${periodId}&itemId=${itemId}`})">返回计划详情</button>
        <button class="secondary-button" @tap="Taro.switchTab({url:'/pages/ai/index'})">问问行止如何调整</button>
      </view>
      <view class="notice notice--info boundary">周期结论反映本月全部安排；单项影响比较同一资金依据下包含和移除该未承诺项目的结果。本页不会修改计划或执行资金动作。</view>
    </template>
  </PageShell>
</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.back{position:absolute;z-index:4;top:calc(34px + env(safe-area-inset-top));right:28px;width:64px;height:64px;color:$brand-deep;background:rgba(255,255,255,.78);border-radius:50%;font-size:44px}.result-card{overflow:hidden;background:linear-gradient(145deg,$surface-tint,#fff)}.result-card--needs_adjustment,.result-card--blocked{background:linear-gradient(145deg,$warning-surface,#fff)}.result-card--unknown{background:linear-gradient(145deg,$soft-surface,#fff)}.result-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:22px}.eyebrow,.result-title,.result-detail,.result-number text,.result-number b{display:block}.eyebrow{color:$text-secondary;font-size:27px}.result-title{margin-top:9px;font-size:40px;font-weight:780;line-height:1.3}.result-detail{margin-top:22px;color:$text-secondary;font-size:28px;line-height:1.65}.result-number{margin-top:30px;padding-top:24px;border-top:1px solid $border}.result-number text{color:$text-secondary;font-size:28px}.result-number b{margin-top:10px;font-size:58px;overflow-wrap:anywhere}.date-list{margin-top:22px;padding:22px;background:$soft-surface;border-radius:20px}.date-list text{display:block;font-size:28px}.date-list text+text{margin-top:9px;color:$text-secondary;line-height:1.55}.breakdown-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.breakdown-grid .section-card{min-width:0;padding:24px}.breakdown-grid text,.breakdown-grid b{display:block}.breakdown-grid text{color:$text-secondary;font-size:26px}.breakdown-grid b{margin-top:10px;font-size:34px;overflow-wrap:anywhere}.reason-list{display:grid;gap:20px}.reason-list view{display:flex;align-items:flex-start;gap:16px}.reason-list view>text:last-child{flex:1;font-size:28px;line-height:1.6}.reason-dot{flex:0 0 14px;width:14px;height:14px;margin-top:13px;background:$warning;border-radius:50%}.page-actions{display:grid;gap:16px;margin-top:30px}.page-actions button{width:100%}.boundary{margin-top:24px;font-size:28px;line-height:1.65}
@media screen and (max-width:360px){.result-heading{display:grid}.result-heading .status-badge{justify-self:start}.result-title{font-size:36px}.result-number b{font-size:50px}.breakdown-grid{grid-template-columns:1fr}}
</style>
