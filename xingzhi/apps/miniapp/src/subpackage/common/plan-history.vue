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
const statusLabel = (value: string) => value === 'active' ? '进行中' : value === 'closed' ? '已归档' : '草稿';
const statusTone = (value: string) => value === 'active' ? 'success' as const : value === 'draft' ? 'info' as const : 'neutral' as const;
const accountName = (id: string) => overview.accounts.value.find(value => value.account.accountId === id)?.account.displayName ?? '原规划账户';
</script>

<template>
  <PageShell title="历史计划" subtitle="按月份回看预算与计划变化" compact>
    <template #hero><button class="back" @tap="Taro.navigateBack()">‹</button></template>
    <StatePanel v-if="overview.loading.value" title="正在读取历史计划" />
    <StatePanel v-else-if="overview.error.value" title="历史计划暂时不可用" :detail="overview.error.value" tone="error"><button class="secondary-button retry" @tap="overview.load">重新加载</button></StatePanel>
    <template v-else>
      <view v-if="overview.periods.value.length" class="list">
        <SectionCard v-for="value in overview.periods.value" :key="value.period.periodId" class="history-card" @tap="Taro.navigateTo({url:`/pages/period/detail?id=${value.period.periodId}`})">
          <view class="row-between"><view><text class="title">{{ value.period.monthStart.slice(0,7).replace('-','年') }}月</text><text class="account-name">{{accountName(value.period.accountId)}}</text></view><StatusBadge :label="statusLabel(value.period.status)" :tone="statusTone(value.period.status)"/></view>
          <view class="metrics"><view><text>计划项目</text><b>{{ value.items.length }} 项</b></view><view><text>保留目标</text><b>{{ yuan(value.basis.savingsTargetMinor) }}</b></view><view class="funding"><text>资金判断</text><b>{{ fundingLabel(value.forecast.status) }}</b></view></view>
          <text class="detail">查看周期详情</text>
        </SectionCard>
      </view>
      <StatePanel v-else title="还没有历史计划" detail="创建第一个预算周期后，会在这里按月份保留记录。"><button class="primary-button empty-action" @tap="Taro.navigateTo({url:'/pages/period/edit'})">创建预算周期</button></StatePanel>
    </template>
  </PageShell>
</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.back{position:absolute;z-index:4;top:calc(34px + env(safe-area-inset-top));right:28px;width:64px;height:64px;color:$brand-deep;background:rgba(255,255,255,.78);border-radius:50%;font-size:44px}.retry,.empty-action{margin-top:24px}.list{display:grid;gap:20px}.history-card{overflow:hidden}.title,.account-name{display:block}.title{font-size:36px;font-weight:740}.account-name{margin-top:8px;color:$text-secondary;font-size:26px}.metrics{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:26px}.metrics view{min-width:0;padding:20px;background:$soft-surface;border-radius:20px}.metrics .funding{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;gap:16px;background:$surface-tint}.metrics text,.metrics b{display:block}.metrics text{color:$text-secondary;font-size:26px}.metrics b{margin-top:8px;overflow-wrap:anywhere;font-size:32px}.metrics .funding b{margin-top:0;color:$brand-deep}.detail{display:block;margin-top:22px;color:$brand-primary;font-size:28px;font-weight:650;text-align:right}@media screen and (max-width:360px){.metrics{grid-template-columns:1fr}.metrics .funding{grid-column:auto}.row-between{align-items:flex-start}}
</style>
