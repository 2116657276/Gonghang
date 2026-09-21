<script setup lang="ts">
import Taro, { useDidShow } from '@tarojs/taro';
import PageShell from '@/components/PageShell.vue';
import SectionCard from '@/components/SectionCard.vue';
import StatePanel from '@/components/StatePanel.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { useOverview } from '@/composables/useOverview';
import { yuan } from '@/lib/format';

const overview = useOverview();
useDidShow(() => void overview.load());
</script>

<template>
  <PageShell title="月度复盘" subtitle="选择一个周期查看资金与决策证据" compact>
    <template #hero><button class="back" @tap="Taro.navigateBack()">‹</button></template>
    <StatePanel v-if="overview.loading.value" title="正在读取可复盘周期" />
    <StatePanel v-else-if="overview.error.value" title="复盘列表暂时不可用" :detail="overview.error.value" tone="error"><button class="secondary-button retry" @tap="overview.load">重新加载</button></StatePanel>
    <template v-else>
      <view v-if="overview.periods.value.length" class="list">
        <SectionCard v-for="value in overview.periods.value" :key="value.period.periodId" @tap="Taro.navigateTo({url:`/pages/review/index?periodId=${value.period.periodId}`})">
          <view class="row-between"><text class="title">{{ value.period.monthStart.slice(0,7).replace('-','年') }}月复盘</text><StatusBadge :label="value.period.status==='closed'?'完整复盘':'阶段复盘'" :tone="value.period.status==='closed'?'success':'info'"/></view>
          <text class="summary">{{ value.items.length }} 项计划 · 保留目标 {{ yuan(value.basis.savingsTargetMinor) }}</text>
          <text class="detail">查看事实与事件 ›</text>
        </SectionCard>
      </view>
      <StatePanel v-else title="暂无可复盘周期" detail="建立预算周期并记录计划后，才能生成对应的月度复盘。" />
    </template>
  </PageShell>
</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.back{position:absolute;z-index:4;top:calc(34px + env(safe-area-inset-top));right:28px;width:64px;height:64px;color:$brand-deep;background:rgba(255,255,255,.7);border-radius:50%;font-size:44px}.retry{margin-top:18px}.list{display:grid;gap:14px}.title{font-size:27px;font-weight:710}.summary,.detail{display:block}.summary{margin-top:16px;color:$text-secondary;font-size:21px}.detail{margin-top:18px;color:$brand-primary;font-size:21px;text-align:right}
</style>
