<script setup lang="ts">
import { computed, ref } from 'vue';
import Taro, { useLoad } from '@tarojs/taro';
import FactRow from '@/components/FactRow.vue';
import PageShell from '@/components/PageShell.vue';
import SectionCard from '@/components/SectionCard.vue';
import StatePanel from '@/components/StatePanel.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { isH5Runtime } from '@/lib/runtime-config';
import { shortDate } from '@/lib/format';
import type { PaymentHandoff, PaymentRecheck } from '@/lib/types';

const orderId = ref('');
const handoff = ref<PaymentHandoff | null>(null);
const recheck = ref<PaymentRecheck | null>(null);
const loading = ref(true);
const checking = ref(false);
const error = ref('');
const expired = computed(() => handoff.value?.expiresAt ? Date.parse(handoff.value.expiresAt) <= Date.now() : false);

async function load() {
  if (!orderId.value) { error.value = '缺少订单信息。'; loading.value = false; return; }
  loading.value = true; error.value = '';
  try { handoff.value = await api.paymentHandoff(orderId.value); }
  catch (reason) { error.value = errorMessage(reason); }
  finally { loading.value = false; }
}
async function openCashier() {
  const url = handoff.value?.handoffUrl;
  if (!url || expired.value) return;
  if (isH5Runtime && typeof window !== 'undefined') { window.location.assign(url); return; }
  await Taro.setClipboardData({ data: url });
  await Taro.showModal({ title: '收银台地址已复制', content: '微信小程序不能直接跳转支付宝网页，请在系统浏览器中打开复制的地址。完成后回到行止主动核对结果。', showCancel: false });
}
async function verify() {
  if (checking.value) return;
  checking.value = true; error.value = '';
  try { recheck.value = await api.paymentRecheck(orderId.value); }
  catch (reason) { error.value = errorMessage(reason); }
  finally { checking.value = false; }
}
useLoad(options => { orderId.value = options.orderId ?? ''; void load(); });
</script>

<template>
  <PageShell title="付款交接" subtitle="付款动作与服务端核验分开完成" compact>
    <template #hero><button class="back" @tap="Taro.navigateBack()">‹</button></template>
    <StatePanel v-if="loading" title="正在准备付款交接" />
    <StatePanel v-else-if="error&&!handoff" title="付款交接暂时不可用" :detail="error" tone="error"><button class="secondary-button retry" @tap="load">重新尝试</button></StatePanel>
    <template v-else-if="handoff">
      <SectionCard><view class="row-between"><text class="title">{{ handoff.environment==='sandbox'?'支付宝沙箱':'本地模拟付款' }}</text><StatusBadge :label="handoff.requiresUserAction?'等待你完成':'服务端处理中'" tone="info"/></view><FactRow label="订单状态" :value="handoff.paymentStatus"/><FactRow label="交接有效期" :value="handoff.expiresAt?shortDate(handoff.expiresAt):'无需外部操作'"/><view v-if="handoff.environment==='sandbox'" class="notice notice--warning note">打开收银台不会自动记为支付成功。付款后必须回到此页主动查单，最终以服务端保存的渠道结果为准。</view><view v-else class="notice notice--info note">本地模拟由后台任务处理，不会打开真实收银台。</view></SectionCard>
      <button v-if="handoff.handoffUrl" class="primary-button full" :disabled="expired" @tap="openCashier">{{ expired?'交接已过期，请返回重试':'打开支付宝沙箱收银台' }}</button>
      <button v-if="handoff.environment==='sandbox'" class="secondary-button full" :loading="checking" @tap="verify">{{ checking?'正在核对…':'我已完成操作，主动查单' }}</button>
      <button v-else class="primary-button full" @tap="Taro.redirectTo({url:`/pages/operation/detail?id=${handoff.operationId}&orderId=${orderId}`})">查看处理进度</button>
      <SectionCard v-if="recheck" class="result"><view class="row-between"><text class="title">查单结果</text><StatusBadge :label="recheck.paymentStatus==='paid'?'已确认付款':recheck.paymentStatus==='closed'?'交易已关闭':recheck.paymentStatus==='unknown'?'结果待核对':'仍待付款'" :tone="recheck.paymentStatus==='paid'?'success':recheck.paymentStatus==='unknown'?'warning':'info'"/></view><FactRow label="结果来源" :value="recheck.source"/><FactRow v-if="recheck.providerStatus" label="渠道状态" :value="recheck.providerStatus"/><button class="primary-button full" @tap="Taro.redirectTo({url:`/pages/order/detail?id=${orderId}`})">返回订单详情</button></SectionCard>
      <view v-if="error" class="notice notice--error page-error">{{ error }}</view>
    </template>
  </PageShell>
</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.back{position:absolute;z-index:4;top:calc(34px + env(safe-area-inset-top));right:28px;width:64px;height:64px;color:$brand-deep;background:rgba(255,255,255,.7);border-radius:50%;font-size:44px}.retry{margin-top:18px}.title{font-size:27px;font-weight:720}.note{margin-top:18px}.full{width:100%;margin-top:16px}.result,.page-error{margin-top:16px}
</style>
