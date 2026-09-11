<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { api, type ApiError, yuan } from '../lib/api';
import type { ManualTask, MerchantCancellation, MerchantCatalogItem, RefundBatch } from '../lib/types';
import EmptyState from '../components/EmptyState.vue';
import ManualTaskList from '../components/ManualTaskList.vue';
import MerchantCancellationQueue from '../components/MerchantCancellationQueue.vue';
import MerchantRulePanel from '../components/MerchantRulePanel.vue';
import StatusPill from '../components/StatusPill.vue';

type MerchantOrder = { id: string; itemName: string; amountMinor: number; refundedMinor: number; paymentStatus: string; status: string; consumer: string };
const orders = ref<MerchantOrder[]>([]);
const catalog = ref<MerchantCatalogItem[]>([]);
const cancellations = ref<MerchantCancellation[]>([]);
const batches = ref<Record<string, RefundBatch[]>>({});
const tasks = ref<ManualTask[]>([]);
const busy = ref(false);
const loading = ref(true);
const error = ref('');
const notice = ref('');
let poller: number | undefined;

function report(reason: unknown) {
  error.value = (reason as ApiError).message || '操作没有完成。';
  notice.value = '';
}

async function load() {
  const [orderResult, catalogResult, cancellationResult, taskResult] = await Promise.all([
    api<{ orders: MerchantOrder[] }>('/merchant/orders'), api<{ items: MerchantCatalogItem[] }>('/merchant/catalog'),
    api<{ cancellations: MerchantCancellation[] }>('/merchant/cancellations'), api<{ tasks: ManualTask[] }>('/merchant/manual-tasks'),
  ]);
  const batchEntries = await Promise.all(cancellationResult.cancellations.map(async (item) => {
    const result = await api<{ batches: RefundBatch[] }>(`/merchant/cancellations/${item.id}/refund-batches`);
    return [item.id, result.batches] as const;
  }));
  orders.value = orderResult.orders;
  catalog.value = catalogResult.items;
  cancellations.value = cancellationResult.cancellations;
  tasks.value = taskResult.tasks;
  batches.value = Object.fromEntries(batchEntries);
}

async function perform(action: () => Promise<void>) {
  busy.value = true;
  error.value = '';
  try { await action(); } catch (reason) { report(reason); } finally { busy.value = false; }
}

async function updateRule(itemId: string, rule: string, expectedVersion: number) {
  await perform(async () => {
    await api(`/merchant/catalog/${itemId}/rule`, { method: 'PUT', body: JSON.stringify({ rule, expectedVersion }) });
    notice.value = '测试取消规则已更新；既有确认仍保留原快照。';
    await load();
  });
}

async function decide(cancellationId: string, decision: 'approve' | 'reject') {
  await perform(async () => {
    const reason = decision === 'approve' ? '商户复核原订单及消费者确认后批准。' : '商户复核后按测试规则拒绝，并保留拒绝原因。';
    await api(`/merchant/cancellations/${cancellationId}/decisions`, { method: 'POST', body: JSON.stringify({ decision, reason }) });
    notice.value = decision === 'approve' ? '取消申请已批准，可安排规则规定的退款批次。' : '取消申请已拒绝；该结果不表示退款成功。';
    await load();
  });
}

async function schedule(cancellationId: string) {
  await perform(async () => {
    await api(`/merchant/cancellations/${cancellationId}/refund-batches`, { method: 'POST', body: JSON.stringify({}) });
    notice.value = '固定退款批次已受理；仅明确成功后才会累计已退款金额。';
    await load();
  });
}

async function claim(taskId: string) {
  await perform(async () => {
    await api(`/merchant/manual-tasks/${taskId}/actions`, { method: 'POST', body: JSON.stringify({ action: 'claim' }) });
    notice.value = '人工任务已领取。';
    await load();
  });
}

async function record(taskId: string, note: string) {
  await perform(async () => {
    await api(`/merchant/manual-tasks/${taskId}/actions`, { method: 'POST', body: JSON.stringify({ action: 'record_recheck', note }) });
    notice.value = '复核记录已保存，任务仍等待对应业务事实关闭。';
    await load();
  });
}

onMounted(async () => {
  try { await load(); } catch (reason) { report(reason); } finally { loading.value = false; }
  poller = window.setInterval(() => { if (!busy.value) load().catch(report); }, 3_000);
});
onBeforeUnmount(() => { if (poller) window.clearInterval(poller); });
</script>

<template>
  <p v-if="error" class="notice notice-error" role="alert">{{ error }}</p>
  <p v-else-if="notice" class="notice" role="status">{{ notice }}</p>
  <p class="scope-note">这里执行的规则、退款批次和复核任务均属于<strong>本地模拟环境</strong>；商户入口不提供手工填写资金成功的能力。</p>
  <div v-if="loading" class="ledger-section" role="status" aria-busy="true">正在读取商户工作区……</div>
  <div v-else class="merchant-dashboard">
    <MerchantRulePanel :items="catalog" :busy="busy" @update="updateRule" />
    <MerchantCancellationQueue :cancellations="cancellations" :batches="batches" :busy="busy" @decide="decide" @schedule="schedule" />
    <ManualTaskList :tasks="tasks.filter((task) => task.state !== 'resolved')" :busy="busy" @claim="claim" @record="record" />
    <section v-if="orders.length" class="ledger-section merchant-orders" aria-labelledby="merchant-orders-title">
      <div class="section-title"><div><p class="eyebrow">本测试商户</p><h2 id="merchant-orders-title">订单看板</h2></div></div>
      <div class="order-table" role="table" aria-label="本商户订单">
        <div class="order-row table-head" role="row"><span>订单</span><span>消费者</span><span>金额 / 已退</span><span>状态</span></div>
        <div v-for="order in orders" :key="order.id" class="order-row" role="row"><span>{{ order.itemName }}</span><span>{{ order.consumer }}</span><strong>{{ yuan(order.amountMinor) }}<small>已退 {{ yuan(order.refundedMinor) }}</small></strong><span><StatusPill :value="order.paymentStatus" /></span></div>
      </div>
    </section>
    <EmptyState v-else title="还没有本商户订单" description="消费者创建订单后，会在这里按服务端所属商户显示。" />
  </div>
</template>
