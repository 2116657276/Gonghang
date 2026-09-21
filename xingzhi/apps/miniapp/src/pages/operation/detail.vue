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
    <SectionCard v-else-if="operation">
      <view class="row-between"><text class="title">业务处理</text><StatusBadge :label="operation.state==='succeeded'?'已完成':operation.state==='failed'?'失败':operation.state==='pending_review'?'需要复核':'处理中'" :tone="operation.state==='succeeded'?'success':operation.state==='failed'?'warning':'info'" /></view>
      <FactRow label="操作类型" :value="operation.type" />
      <FactRow label="说明" :value="operation.purpose ?? '服务端处理中'" />
      <view class="notice notice--info note">离开本页会暂停查询；重新进入订单后可继续恢复，不会重复创建操作。</view>
      <button v-if="orderId" class="primary-button full" @tap="Taro.redirectTo({url:`/pages/order/detail?id=${orderId}`})">返回订单</button>
    </SectionCard>
  </PageShell>
</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.back{position:absolute;right:28px;top:calc(34px + env(safe-area-inset-top));width:64px;height:64px;border-radius:50%;font-size:42px}.title{font-size:28px;font-weight:720}.note,.full{margin-top:20px}.full{width:100%}.retry{margin-top:18px}
</style>
