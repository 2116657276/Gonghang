<script setup lang="ts">
import { ref, onBeforeUnmount } from 'vue';
import Taro, { useDidHide, useDidShow, useLoad } from '@tarojs/taro';
import PageShell from '@/components/PageShell.vue';
import SectionCard from '@/components/SectionCard.vue';
import StatePanel from '@/components/StatePanel.vue';
import FactRow from '@/components/FactRow.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import type { Operation } from '@/lib/types';

const id = ref('');
const orderId = ref('');
const operation = ref<Operation | null>(null);
const error = ref('');
let timer: ReturnType<typeof setTimeout> | undefined;
let visible = false;
const final = (state: string) => ['succeeded', 'failed', 'pending_review'].includes(state);
const operationLabel = (type: string) => ({ simulate_payment: '本地模拟付款', sandbox_payment_handoff: '沙箱付款交接', sandbox_payment_recheck: '付款结果核对', simulate_close: '本地模拟关单', sandbox_close: '渠道关单', simulate_refund_batch: '本地模拟退款', sandbox_refund: '渠道退款', sandbox_refund_recheck: '退款结果核对', merchant_cancellation_review: '取消申请审核' }[type] ?? type);

function stopPolling() {
  if (timer) clearTimeout(timer);
  timer = undefined;
}

async function load() {
  stopPolling();
  error.value = '';
  try {
    operation.value = await api.operation(id.value);
    if (visible && !final(operation.value.state)) timer = setTimeout(() => void load(), 1800);
  } catch (reason) {
    error.value = errorMessage(reason);
  }
}

useLoad((options) => {
  id.value = options.id ?? '';
  orderId.value = options.orderId ?? '';
});
useDidShow(() => {
  visible = true;
  if (id.value) void load();
});
useDidHide(() => {
  visible = false;
  stopPolling();
});
onBeforeUnmount(() => {
  visible = false;
  stopPolling();
});
</script>

<template>
  <PageShell title="处理进度" subtitle="只展示服务端已经确认的状态" compact>
    <template #hero><button class="back" @tap="Taro.navigateBack()">‹</button></template>
    <StatePanel v-if="!operation && !error" title="正在核对处理结果" />
    <StatePanel v-else-if="error" title="暂时无法读取进度" :detail="error" tone="error">
      <button class="secondary-button retry" @tap="load">重新加载</button>
    </StatePanel>
    <SectionCard v-else-if="operation" class="operation-card" :class="`operation-card--${operation.state}`">
      <view class="operation-heading"><view class="state-icon" aria-hidden="true"><view/></view><view><text class="eyebrow">当前状态</text><text class="title">{{operation.state==='succeeded'?'处理已完成':operation.state==='failed'?'处理失败':operation.state==='pending_review'?'等待人工复核':'服务端处理中'}}</text></view><StatusBadge :label="operation.state==='succeeded'?'已完成':operation.state==='failed'?'失败':operation.state==='pending_review'?'需要复核':'处理中'" :tone="operation.state==='succeeded'?'success':operation.state==='failed'?'danger':operation.state==='pending_review'?'warning':'info'" /></view>
      <FactRow label="操作类型" :value="operationLabel(operation.type)" />
      <FactRow label="说明" :value="operation.purpose ?? '服务端处理中'" />
      <view class="notice notice--info note">离开本页会暂停查询；重新进入订单后可继续恢复，不会重复创建操作。</view>
      <button v-if="orderId" class="primary-button full" @tap="Taro.redirectTo({url:`/pages/order/detail?id=${orderId}`})">返回订单</button>
    </SectionCard>
  </PageShell>
</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.back{position:absolute;right:28px;top:calc(34px + env(safe-area-inset-top));width:64px;height:64px;border-radius:50%;font-size:44px}.operation-card{background:linear-gradient(145deg,#EEF7FB,#fff)}.operation-card--succeeded{background:linear-gradient(145deg,$success-surface,#fff)}.operation-card--failed{background:linear-gradient(145deg,$danger-surface,#fff)}.operation-card--pending_review{background:linear-gradient(145deg,$warning-surface,#fff)}.operation-heading{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:start;gap:18px;margin-bottom:20px}.state-icon{position:relative;width:80px;height:80px;background:rgba(255,255,255,.82);border-radius:24px}.state-icon::before{position:absolute;left:23px;top:23px;width:28px;height:28px;border:4px solid $info;border-top-color:transparent;border-radius:50%;content:''}.operation-card--succeeded .state-icon::before{left:25px;top:16px;width:24px;height:38px;border:0;border-right:6px solid $success;border-bottom:6px solid $success;border-radius:0;transform:rotate(45deg)}.operation-card--failed .state-icon::before{left:24px;top:36px;width:32px;height:6px;background:$danger;border:0;border-radius:4px;transform:rotate(45deg)}.operation-card--failed .state-icon::after{position:absolute;left:24px;top:36px;width:32px;height:6px;background:$danger;border-radius:4px;content:'';transform:rotate(-45deg)}.eyebrow,.title{display:block}.eyebrow{color:$text-secondary;font-size:26px}.title{margin-top:7px;font-size:36px;font-weight:740;line-height:1.35}.note,.full{margin-top:24px}.note{font-size:28px;line-height:1.65}.full{width:100%}.retry{margin-top:24px}@media screen and (max-width:360px){.operation-heading{grid-template-columns:auto minmax(0,1fr)}.operation-heading .status-badge{grid-column:2;justify-self:start}}
</style>
