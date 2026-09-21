<script setup lang="ts">
import Taro, { useDidShow } from '@tarojs/taro';
import PageShell from '@/components/PageShell.vue';
import SectionCard from '@/components/SectionCard.vue';
import StatePanel from '@/components/StatePanel.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { useOverview } from '@/composables/useOverview';
import { fundingLabel, yuan } from '@/lib/format';

const overview = useOverview();
useDidShow(() => void overview.load());
const statusLabel = (value: string) => value === 'active' ? '进行中' : value === 'closed' ? '已结束' : '草稿';
const statusTone = (value: string) => value === 'active' ? 'success' as const : value === 'draft' ? 'info' as const : 'neutral' as const;
</script>

<template>
  <PageShell title="历史计划" subtitle="按月份回看预算与计划变化" compact>
    <template #hero><button class="back" @tap="Taro.navigateBack()">‹</button></template>
    <StatePanel v-if="overview.loading.value" title="正在读取历史计划" />
    <StatePanel v-else-if="overview.error.value" title="历史计划暂时不可用" :detail="overview.error.value" tone="error"><button class="secondary-button retry" @tap="overview.load">重新加载</button></StatePanel>
    <template v-else>
      <view v-if="overview.periods.value.length" class="list">
        <SectionCard v-for="value in overview.periods.value" :key="value.period.periodId" @tap="Taro.navigateTo({url:`/pages/period/detail?id=${value.period.periodId}`})">
          <view class="row-between"><text class="title">{{ value.period.monthStart.slice(0,7).replace('-','年') }}月</text><StatusBadge :label="statusLabel(value.period.status)" :tone="statusTone(value.period.status)"/></view>
          <view class="metrics"><view><text>计划项目</text><b>{{ value.items.length }} 项</b></view><view><text>保留目标</text><b>{{ yuan(value.basis.savingsTargetMinor) }}</b></view><view><text>资金判断</text><b>{{ fundingLabel(value.forecast.status) }}</b></view></view>
          <text class="detail">查看周期详情 ›</text>
        </SectionCard>
      </view>
      <StatePanel v-else title="还没有历史计划" detail="创建第一个预算周期后，会在这里按月份保留记录。"><button class="primary-button empty-action" @tap="Taro.navigateTo({url:'/pages/period/edit'})">创建预算周期</button></StatePanel>
    </template>
  </PageShell>
</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.back{position:absolute;z-index:4;top:calc(34px + env(safe-area-inset-top));right:28px;width:64px;height:64px;color:$brand-deep;background:rgba(255,255,255,.7);border-radius:50%;font-size:44px}.retry,.empty-action{margin-top:18px}.list{display:grid;gap:14px}.title{font-size:29px;font-weight:720}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:22px}.metrics view{min-width:0;padding-top:14px;border-top:1px solid $border}.metrics text,.metrics b{display:block}.metrics text{color:$text-secondary;font-size:19px}.metrics b{margin-top:7px;overflow-wrap:anywhere;font-size:22px}.detail{display:block;margin-top:18px;color:$brand-primary;font-size:21px;text-align:right}@media screen and (max-width:360px){.metrics{grid-template-columns:1fr}.metrics view{display:flex;justify-content:space-between;gap:12px}.metrics b{margin-top:0}}
</style>
