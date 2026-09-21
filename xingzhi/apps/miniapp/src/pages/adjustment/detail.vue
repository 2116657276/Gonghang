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
      <SectionCard>
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
      <StatePanel v-else title="没有关联订单善后" detail="本次调整不需要取消订单或等待退款。" />
    </template>
  </PageShell>
</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.back{position:absolute;right:28px;top:calc(34px + env(safe-area-inset-top));width:64px;height:64px;border-radius:50%;font-size:42px}
.title{font-size:27px;font-weight:720}.note,.block{margin-top:18px}.cancel{margin-top:14px;padding-top:10px;border-top:1px solid $border}
.actions{display:flex;justify-content:flex-end;gap:12px;margin-top:10px}.text-button{min-height:58px;padding:0 18px;font-size:20px}
</style>
