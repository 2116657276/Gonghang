<script setup lang="ts">
import { ref } from 'vue';
import Taro, { useLoad } from '@tarojs/taro';
import FactRow from '@/components/FactRow.vue';
import PageShell from '@/components/PageShell.vue';
import SectionCard from '@/components/SectionCard.vue';
import StatePanel from '@/components/StatePanel.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { shortDate, yuan } from '@/lib/format';
import type { AdjustmentDetail } from '@/lib/types';

const value = ref<AdjustmentDetail | null>(null);
const error = ref('');
const statusLabel = (status: string) => ({ proposed: '待确认', executing: '执行中', complete: '已完成',
  pending_review: '待人工复核', approved: '已批准', rejected: '未通过', refund_processing: '退款处理中',
  completed: '已完成' }[status] ?? status);

useLoad(async options => {
  try { value.value = (await api.adjustment(options.id ?? '')).data; }
  catch (reason) { error.value = errorMessage(reason); }
});
</script>

<template>
  <PageShell title="调整结果" subtitle="计划变化、订单处理和退款事实分开显示" compact>
    <template #hero><button class="back" @tap="Taro.navigateBack()">‹</button></template>
    <StatePanel v-if="!value&&!error" title="正在读取调整结果" />
    <StatePanel v-else-if="error" title="调整结果不可用" :detail="error" tone="error" />
    <template v-else-if="value">
      <SectionCard class="summary-card">
        <view class="row-between"><text class="title">{{value.reason}}</text><StatusBadge :label="statusLabel(value.status)" :tone="value.status==='complete'?'success':'info'" /></view>
        <FactRow label="意外支出" :value="yuan(value.proposedChanges.emergency.amountMinor)" />
        <FactRow label="计划日期" :value="shortDate(value.proposedChanges.emergency.plannedOn)" />
        <FactRow label="确认时间" :value="value.confirmedAt?shortDate(value.confirmedAt):'尚未确认'" />
        <view class="notice notice--info note">调整执行不等于退款到账。涉及原订单的部分请到订单详情继续查看。</view>
      </SectionCard>
      <SectionCard v-if="value.cancellations.length" class="block">
        <text class="title">订单善后</text>
        <view v-for="c in value.cancellations" :key="c.cancellationRequestId" class="cancel">
          <FactRow label="受理状态" :value="statusLabel(c.status)" />
          <FactRow label="预计退款" :value="yuan(c.acceptedRefundMinor)" />
          <FactRow label="规则费用" :value="yuan(c.acceptedFeeMinor)" />
          <FactRow label="渠道已退款" :value="yuan(c.channelRefundSucceededMinor)" />
          <view class="actions">
            <button class="text-button" @tap="Taro.navigateTo({url:`/pages/order/detail?id=${c.orderId}`})">查看订单</button>
            <button class="text-button" @tap="Taro.navigateTo({url:`/pages/refund/detail?orderId=${c.orderId}`})">查看退款</button>
          </view>
        </view>
      </SectionCard>
      <view v-else class="compact-empty">本次不涉及订单善后，不需要取消订单或等待退款。</view>
    </template>
  </PageShell>
</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.back{position:absolute;right:28px;top:calc(34px + env(safe-area-inset-top));width:64px;height:64px;border-radius:50%;font-size:44px}.summary-card{background:linear-gradient(145deg,$surface-tint,#fff)}
.title{font-size:36px;font-weight:740;line-height:1.4}.note,.block{margin-top:24px}.note{font-size:28px;line-height:1.65}.cancel{margin-top:20px;padding-top:18px;border-top:1px solid $border}
.actions{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:18px}.text-button{min-height:88px;padding:0 18px;color:$brand-primary;background:$soft-surface;border-radius:18px;font-size:27px}.compact-empty{margin-top:24px;padding:22px 24px;color:$text-secondary;background:$soft-surface;border-radius:22px;font-size:28px;line-height:1.55}@media screen and (max-width:360px){.actions{grid-template-columns:1fr}.row-between{align-items:flex-start}}
</style>
