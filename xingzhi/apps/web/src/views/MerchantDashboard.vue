<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { api, apiData, dateTime, requestOperationRecheck, type ApiError, yuan } from '../lib/api';
import type { ManualTask, MerchantCancellation, MerchantCatalogItem, MerchantConsumerOrder,
  MerchantConsumerOrderDetail, RefundBatch } from '../lib/types';
import EmptyState from '../components/EmptyState.vue';
import ManualTaskList from '../components/ManualTaskList.vue';
import MerchantCancellationQueue from '../components/MerchantCancellationQueue.vue';
import MerchantRulePanel from '../components/MerchantRulePanel.vue';
import StatusPill from '../components/StatusPill.vue';

type LegacyOrder = { id: string; itemName: string; amountMinor: number; refundedMinor: number;
  paymentStatus: string; status: string; consumer: string };
const orders = ref<MerchantConsumerOrder[]>([]), legacyOrders = ref<LegacyOrder[]>([]);
const catalog = ref<MerchantCatalogItem[]>([]);
const cancellations = ref<MerchantCancellation[]>([]), legacyCancellations = ref<MerchantCancellation[]>([]);
const batches = ref<Record<string, RefundBatch[]>>({}), legacyBatches = ref<Record<string, RefundBatch[]>>({});
const tasks = ref<ManualTask[]>([]), legacyTasks = ref<ManualTask[]>([]);
const selected = ref<MerchantConsumerOrderDetail | null>(null), selectedId = ref<string | null>(null);
const detailLoading = ref(false), busy = ref(false), loading = ref(true);
const error = ref(''), notice = ref('');
let timer: number | undefined;
let loadSequence = 0, detailSequence = 0;

const hasPending = computed(() => cancellations.value.some(item =>
  ['delayed', 'approved', 'refund_processing', 'pending_review'].includes(item.status))
  || tasks.value.some(item => item.state !== 'resolved')
  || orders.value.some(item => ['pending', 'unknown'].includes(item.paymentStatus)));
function report(reason: unknown) { error.value = (reason as ApiError).message || '操作没有完成。'; notice.value = ''; }
function stopRefresh() { if (timer) window.clearTimeout(timer); timer = undefined; }
function scheduleRefresh() {
  stopRefresh();
  if (document.visibilityState === 'visible' && hasPending.value) timer = window.setTimeout(() => void load(), 5_000);
}
async function readBatches(items: MerchantCancellation[], consumer: boolean) {
  return Object.fromEntries(await Promise.all(items.map(async item => {
    const path = consumer ? `/merchant/consumer-cancellations/${item.id}/refund-batches`
      : `/merchant/cancellations/${item.id}/refund-batches`;
    const result = consumer ? await apiData<{ batches: RefundBatch[] }>(path)
      : await api<{ batches: RefundBatch[] }>(path);
    return [item.id, result.batches] as const;
  })));
}
async function load(showLoading = false) {
  const sequence = ++loadSequence;
  if (showLoading) loading.value = true;
  try {
    const [newOrders, newCancellations, newTasks, oldOrders, catalogResult, oldCancellations, oldTasks] = await Promise.all([
      apiData<{ orders: MerchantConsumerOrder[] }>('/merchant/consumer-orders'),
      apiData<{ cancellations: MerchantCancellation[] }>('/merchant/consumer-cancellations'),
      apiData<{ tasks: ManualTask[] }>('/merchant/consumer-manual-tasks'),
      api<{ orders: LegacyOrder[] }>('/merchant/orders'), api<{ items: MerchantCatalogItem[] }>('/merchant/catalog'),
      api<{ cancellations: MerchantCancellation[] }>('/merchant/cancellations'),
      api<{ tasks: ManualTask[] }>('/merchant/manual-tasks'),
    ]);
    const [newBatches, oldBatches] = await Promise.all([
      readBatches(newCancellations.cancellations, true), readBatches(oldCancellations.cancellations, false),
    ]);
    if (sequence !== loadSequence) return;
    orders.value = newOrders.orders; cancellations.value = newCancellations.cancellations; tasks.value = newTasks.tasks;
    legacyOrders.value = oldOrders.orders; catalog.value = catalogResult.items;
    legacyCancellations.value = oldCancellations.cancellations; legacyTasks.value = oldTasks.tasks;
    batches.value = newBatches; legacyBatches.value = oldBatches;
    if (selectedId.value && orders.value.some(item => item.id === selectedId.value)) await selectOrder(selectedId.value);
    error.value = '';
  } catch (reason) { if (sequence === loadSequence) report(reason); }
  finally { if (sequence === loadSequence) { loading.value = false; scheduleRefresh(); } }
}
async function selectOrder(orderId: string) {
  const sequence = ++detailSequence;
  selectedId.value = orderId; detailLoading.value = true;
  try {
    const detail = await apiData<MerchantConsumerOrderDetail>(`/merchant/consumer-orders/${orderId}`);
    if (sequence === detailSequence && selectedId.value === orderId) selected.value = detail;
  }
  catch (reason) { if (sequence === detailSequence) { selected.value = null; report(reason); } }
  finally { if (sequence === detailSequence) detailLoading.value = false; }
}
function closeSelected() { detailSequence += 1; selectedId.value = null; selected.value = null; detailLoading.value = false; }
async function perform(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true; error.value = ''; stopRefresh();
  try { await action(); } catch (reason) { report(reason); }
  finally { busy.value = false; scheduleRefresh(); }
}
const isNewCancellation = (id: string) => cancellations.value.some(item => item.id === id);
const isNewTask = (id: string) => tasks.value.some(item => item.id === id);
const isNewOperation = (id: string) => Boolean(selected.value?.operations.some(item => item.operationId === id)
  || Object.values(batches.value).flat().some(item => item.operationId === id)
  || tasks.value.some(item => item.operationId === id));
async function updateRule(itemId: string, rule: string, expectedVersion: number) {
  await perform(async () => { await api(`/merchant/catalog/${itemId}/rule`, { method: 'PUT', body: JSON.stringify({ rule, expectedVersion }) });
    notice.value = '测试取消规则已更新；既有确认仍保留原快照。'; await load(); });
}
async function decide(cancellationId: string, decision: 'approve' | 'reject') {
  await perform(async () => {
    const current = isNewCancellation(cancellationId);
    const path = `${current ? '/merchant/consumer-cancellations' : '/merchant/cancellations'}/${cancellationId}/decisions`;
    const reason = decision === 'approve' ? '商户核对原订单及消费者确认后批准。' : '商户核对原订单后拒绝，并保留拒绝原因。';
    const init = { method: 'POST' as const, body: JSON.stringify({ decision, reason }) };
    if (current) await apiData(path, init); else await api(path, init);
    notice.value = decision === 'approve' ? '申请已批准，可按原确认范围安排退款。' : '申请已拒绝，未产生退款事实。'; await load();
  });
}
async function schedule(cancellationId: string) {
  await perform(async () => {
    const current = isNewCancellation(cancellationId);
    const path = `${current ? '/merchant/consumer-cancellations' : '/merchant/cancellations'}/${cancellationId}/refund-batches`;
    if (current) await apiData(path, { method: 'POST', body: '{}' }); else await api(path, { method: 'POST', body: '{}' });
    notice.value = '固定退款批次已受理；只有明确到账事实才会增加已退款金额。'; await load();
  });
}
async function recheckOperation(operationId: string) {
  await perform(async () => { notice.value = await requestOperationRecheck(operationId,
    '商户在工作台请求复核既有交易。', isNewOperation(operationId) ? 'consumer' : 'legacy'); await load(); });
}
async function actTask(taskId: string, action: { action: 'claim' } | { action: 'record_recheck'; note: string }) {
  const current = isNewTask(taskId);
  const path = `${current ? '/merchant/consumer-manual-tasks' : '/merchant/manual-tasks'}/${taskId}/actions`;
  const init = { method: 'POST' as const, body: JSON.stringify(action) };
  if (current) await apiData(path, init); else await api(path, init);
}
async function claim(taskId: string) { await perform(async () => { await actTask(taskId, { action: 'claim' }); notice.value = '人工任务已领取。'; await load(); }); }
async function record(taskId: string, note: string) { await perform(async () => { await actTask(taskId, { action: 'record_recheck', note }); notice.value = '复核记录已保存，任务等待对应业务事实关闭。'; await load(); }); }
function visibilityChanged() { if (document.visibilityState === 'visible') void load(); else stopRefresh(); }
onMounted(() => { document.addEventListener('visibilitychange', visibilityChanged); void load(true); });
onBeforeUnmount(() => { stopRefresh(); document.removeEventListener('visibilitychange', visibilityChanged); });
</script>

<template>
  <p v-if="error" class="notice notice-error" role="alert">{{ error }} <button class="text-button" type="button" @click="load(true)">重新加载</button></p>
  <p v-else-if="notice" class="notice" role="status">{{ notice }}</p>
  <div class="scope-bar"><p>只展示当前账号在服务端拥有的订单。新订单使用建单时固化的商户归属。</p><button class="secondary-button" type="button" :disabled="busy" @click="load(true)">刷新事实</button></div>
  <div v-if="loading" class="ledger-section" role="status" aria-busy="true">正在读取商户工作区……</div>
  <div v-else class="merchant-dashboard">
    <section v-if="orders.length" class="ledger-section merchant-orders" aria-labelledby="consumer-orders-title">
      <div class="section-title"><div><p class="eyebrow">当前消费者链</p><h2 id="consumer-orders-title">新订单看板</h2></div></div>
      <div class="order-table" role="table" aria-label="本商户新订单">
        <div class="order-row table-head" role="row"><span>订单</span><span>消费者</span><span>金额 / 已退</span><span>状态</span></div>
        <button v-for="order in orders" :key="order.id" class="order-row order-row-button" type="button" role="row" @click="selectOrder(order.id)">
          <span><strong>{{ order.itemName }}</strong><small>{{ dateTime(order.createdAt) }}</small></span><span>{{ order.consumer }}</span>
          <strong>{{ yuan(order.amountMinor) }}<small>已退 {{ yuan(order.refundedMinor) }}</small></strong><span><StatusPill :value="order.paymentStatus" /></span>
        </button>
      </div>
    </section>
    <EmptyState v-else title="还没有新订单" description="消费者确认购买后，新订单会按建单时商户归属出现在这里。" />

    <section v-if="selectedId" class="ledger-section order-detail" aria-labelledby="merchant-order-detail-title">
      <div class="section-title split-title"><div><p class="eyebrow">同一业务编号</p><h2 id="merchant-order-detail-title">订单详情</h2></div><button class="text-button" type="button" @click="closeSelected">关闭</button></div>
      <p v-if="detailLoading" class="muted">正在读取订单详情……</p>
      <template v-else-if="selected">
        <div class="review-metrics"><div><small>确认金额</small><strong>{{ yuan(selected.confirmation.acceptedAmountMinor) }}</strong></div><div><small>付款状态</small><StatusPill :value="selected.order.paymentStatus" /></div><div><small>退款到账</small><strong>{{ yuan(selected.order.refundedMinor) }}</strong></div><div><small>操作记录</small><strong>{{ selected.operations.length }}</strong></div></div>
        <dl class="detail-facts"><div><dt>订单编号</dt><dd>{{ selected.order.id }}</dd></div><div><dt>购买意图</dt><dd>{{ selected.confirmation.purchaseIntentId }}</dd></div><div><dt>依据版本</dt><dd>资金 {{ selected.confirmation.financialVersion }} · 预算 {{ selected.confirmation.periodVersion }} · 报价 {{ selected.confirmation.quoteVersion }}</dd></div><div><dt>支付业务号</dt><dd>{{ selected.payment?.businessNumber ?? '尚未生成' }}</dd></div></dl>
        <ol class="review-event-list"><li v-for="event in selected.timeline" :key="`${event.type}-${event.referenceId}`"><strong>{{ event.type }} · {{ event.status }}</strong><span>{{ dateTime(event.observedAt) }}</span></li></ol>
      </template>
    </section>

    <MerchantCancellationQueue :cancellations="cancellations" :batches="batches" :busy="busy" title="新订单处理队列" eyebrow="当前取消与退款" @decide="decide" @schedule="schedule" @recheck="recheckOperation" />
    <ManualTaskList :tasks="tasks.filter(task => task.state !== 'resolved')" :busy="busy" title="新订单待复核任务" eyebrow="当前人工责任" @claim="claim" @record="record" @recheck="recheckOperation" />

    <details class="legacy-section"><summary>查看历史计划交易与测试规则</summary><div class="legacy-content">
      <MerchantRulePanel :items="catalog" :busy="busy" @update="updateRule" />
      <MerchantCancellationQueue :cancellations="legacyCancellations" :batches="legacyBatches" :busy="busy" title="历史计划处理队列" eyebrow="旧计划归档" @decide="decide" @schedule="schedule" @recheck="recheckOperation" />
      <ManualTaskList :tasks="legacyTasks.filter(task => task.state !== 'resolved')" :busy="busy" title="历史计划待办" eyebrow="旧计划归档" @claim="claim" @record="record" @recheck="recheckOperation" />
      <section v-if="legacyOrders.length" class="ledger-section"><div class="section-title"><div><p class="eyebrow">旧计划归档</p><h2>历史订单</h2></div></div><div class="order-table"><div v-for="order in legacyOrders" :key="order.id" class="order-row"><span>{{ order.itemName }}</span><span>{{ order.consumer }}</span><strong>{{ yuan(order.amountMinor) }}</strong><StatusPill :value="order.paymentStatus" /></div></div></section>
    </div></details>
  </div>
</template>
