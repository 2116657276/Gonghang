<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { api, type ApiError } from '../lib/api';
import type { AgentProposal, CatalogItem, ChangeProposal, EventItem, PaymentHandoff, Plan, PurchaseProposal } from '../lib/types';
import AgentPanel from '../components/AgentPanel.vue';
import ActivityFeed from '../components/ActivityFeed.vue';
import AftercarePanel from '../components/AftercarePanel.vue';
import ChangePanel from '../components/ChangePanel.vue';
import CreatePlan from '../components/CreatePlan.vue';
import EmptyState from '../components/EmptyState.vue';
import PlanOverview from '../components/PlanOverview.vue';
import PurchasePanel from '../components/PurchasePanel.vue';
import PaymentProgressPanel from '../components/PaymentProgressPanel.vue';

const catalog = ref<CatalogItem[]>([]);
const plans = ref<Array<{ id: string; purpose: string; version: number }>>([]);
const plan = ref<Plan | null>(null);
const events = ref<EventItem[]>([]);
const purchaseProposal = ref<PurchaseProposal | null>(null);
const purchaseConfirmationId = ref<string | null>(null);
const changeProposal = ref<ChangeProposal | null>(null);
const changeConfirmed = ref(false);
const paymentHandoffs = ref<Record<string, PaymentHandoff>>({});
const busy = ref(false);
const error = ref('');
const notice = ref('');
let poller: number | undefined;
let loadVersion=0;

const selectedPlanId = computed(() => plan.value?.id ?? plans.value[0]?.id);
const hasSandboxOrder = computed(() => plan.value?.orders.some((order) => order.environment === 'sandbox') ?? false);

function report(errorValue: unknown) {
  error.value = (errorValue as ApiError).message || '操作没有完成。';
  notice.value = '';
}

async function loadPlan(id?: string) {
  const version=++loadVersion;
  const planId = id ?? selectedPlanId.value;
  if (!planId) { plan.value = null; events.value = []; return; }
  const [snapshot, activity] = await Promise.all([
    api<Plan>(`/plans/${planId}`), api<{ events: EventItem[] }>(`/plans/${planId}/events`),
  ]);
  if(version!==loadVersion)return;
  if(plan.value?.id!==snapshot.id){clearPurchase();clearChange();}
  plan.value = snapshot;
  events.value = activity.events;
}

async function refresh(id?: string) {
  error.value = '';
  const [catalogResult, planResult] = await Promise.all([
    api<{ items: CatalogItem[] }>('/catalog'), api<{ plans: Array<{ id: string; purpose: string; version: number }> }>('/plans'),
  ]);
  catalog.value = catalogResult.items;
  plans.value = planResult.plans;
  await loadPlan(id);
}

async function perform(action: () => Promise<void>) {
  if(busy.value)return;
  busy.value = true;
  error.value = '';
  try { await action(); } catch (errorValue) { report(errorValue); } finally { busy.value = false; }
}

async function selectPlan(id:string){await perform(()=>refresh(id));}

async function createPlan(purpose: string, itemIds: string[]) {
  await perform(async () => {
    const result = await api<{ planId: string }>('/plans', { method: 'POST', body: JSON.stringify({ purpose, itemIds }) });
    notice.value = '计划已建立。接下来可生成结构化购买预览。';
    await refresh(result.planId);
  });
}

async function previewPurchase(itemIds: string[]) {
  if (!plan.value) return;
  await perform(async () => {
    purchaseProposal.value = await api<PurchaseProposal>(`/plans/${plan.value!.id}/purchase-proposals`, { method: 'POST', body: JSON.stringify({ itemIds }) });
    purchaseConfirmationId.value = null;
  });
}

async function confirmPurchase(limitMinor: number, restoreItemIds: string[]) {
  const proposal = purchaseProposal.value;
  if (!proposal) return;
  await perform(async () => {
    const result = await api<{ confirmationId: string; agentFollowupQueued: boolean }> (`/purchase-proposals/${proposal.proposalId}/confirm`, {
      method: 'POST', body: JSON.stringify({ expectedVersion: proposal.version, acceptedItemIds: proposal.items.map((item) => item.planItemId), purchaseLimitMinor: limitMinor, restoreItemIds }),
    });
    purchaseConfirmationId.value = result.confirmationId;
    notice.value = result.agentFollowupQueued
      ? '购买范围已确认；助手跟进已排队，会按有效授权继续处理，请以交易进度中的订单为准。'
      : '购买范围已确认；助手跟进未排队，请使用“按已确认范围创建订单”按钮继续。';
    await refresh();
  });
}

async function createOrders() {
  const proposal = purchaseProposal.value;
  if (!proposal || !purchaseConfirmationId.value) return;
  await perform(async () => {
    for (const item of proposal.items) {
      await api('/orders', { method: 'POST', body: JSON.stringify({ confirmationId: purchaseConfirmationId.value, planItemId: item.planItemId }) });
    }
    purchaseProposal.value = null;
    purchaseConfirmationId.value = null;
    notice.value = '订单已受理。模拟订单由后台核对；沙箱订单请在付款进度中完成官方付款。';
    await refresh();
  });
}

async function pause() {
  if (!plan.value) return;
  await perform(async () => {
    await api(`/plans/${plan.value!.id}/pause`, { method: 'POST', body: JSON.stringify({ expectedVersion: plan.value!.version, itemIds: [], reason: '用户在工作台明确暂停新的购买。' }) });
    purchaseProposal.value = null;
    purchaseConfirmationId.value = null;
    notice.value = '新的购买已暂停；已有任务会继续展示实际状态。';
    await refresh();
  });
}

async function previewChange(items: Array<{ planItemId: string; intent: string }>) {
  if (!plan.value) return;
  await perform(async () => {
    changeProposal.value = await api<ChangeProposal>(`/plans/${plan.value!.id}/change-proposals`, { method: 'POST', body: JSON.stringify({ items }) });
    changeConfirmed.value = false;
  });
}

async function confirmChange() {
  const proposal = changeProposal.value;
  if (!proposal) return;
  await perform(async () => {
    const orderIds = proposal.items.filter((item) => ['close', 'cancel'].includes(item.intent) && item.orderId).map((item) => item.orderId);
    const result = await api<{ agentFollowupQueued: boolean }>(`/change-proposals/${proposal.proposalId}/confirm`, { method: 'POST', body: JSON.stringify({
      expectedVersion: proposal.version, acceptedFeeMinor: proposal.totalFeeMinor, acceptedRefundMinor: proposal.totalRefundMinor,
      aftercareOrderIds: orderIds, queryOrderIds: orderIds,
    }) });
    changeConfirmed.value = true;
    notice.value = result.agentFollowupQueued
      ? '变更范围、费用和两类授权已确认；助手跟进已排队，会继续按授权处理，退款以渠道核验结果为准。'
      : '变更范围、费用和两类授权已确认；助手跟进未排队，请使用“提交善后任务”按钮继续。';
    await refresh();
  });
}

async function executeChange() {
  const proposal = changeProposal.value;
  if (!proposal || !changeConfirmed.value) return;
  await perform(async () => {
    await api(`/change-proposals/${proposal.proposalId}/execute`, { method: 'POST', body: JSON.stringify({}) });
    changeProposal.value = null;
    changeConfirmed.value = false;
    notice.value = '善后任务已受理，结果将在行迹中更新。';
    await refresh();
  });
}

async function requestPaymentHandoff(orderId: string) {
  await perform(async () => {
    const result = await api<PaymentHandoff>(`/orders/${orderId}/payment-handoffs`, { method: 'POST', body: JSON.stringify({}) });
    paymentHandoffs.value = { ...paymentHandoffs.value, [orderId]: result };
    notice.value = '官方付款交接已生成；完成付款后请回到这里主动查单。';
  });
}

async function recheckPayment(orderId: string) {
  await perform(async () => {
    await api(`/orders/${orderId}/payment-rechecks`, { method: 'POST', body: JSON.stringify({}) });
    notice.value = '已请求服务端核对付款事实，页面会刷新最新结果。';
    await refresh();
  });
}

async function revokeAftercareAndQuery() {
  if (!plan.value) return;
  await perform(async () => {
    await api(`/plans/${plan.value!.id}/aftercare-query-revocations`, {
      method: 'POST', body: JSON.stringify({ reason: '用户在工作台明确撤回善后与查询受托权限。' }),
    });
    notice.value = '已停止新增受托动作；既有事实和商户已受理责任仍会保留。';
    await refresh();
  });
}

async function renewQuery(orderIds: string[]) {
  if (!plan.value || !orderIds.length) return;
  await perform(async () => {
    await api(`/plans/${plan.value!.id}/query-authorizations`, {
      method: 'POST', body: JSON.stringify({ expectedVersion: plan.value!.version, orderIds }),
    });
    notice.value = '查询授权已单独续期 7 天；没有重新发起取消或退款。';
    await refresh();
  });
}

function clearPurchase() { purchaseProposal.value = null; purchaseConfirmationId.value = null; }
function clearChange() { changeProposal.value = null; changeConfirmed.value = false; }

async function reviewAgentProposal(proposal:AgentProposal,planId:string){
  if(plan.value?.id!==planId)return;
  if(proposal.type==='purchase'){
    purchaseProposal.value=proposal;purchaseConfirmationId.value=proposal.confirmationId;
  }else{
    changeProposal.value=proposal;changeConfirmed.value=proposal.status==='confirmed';
  }
  await nextTick();
  document.getElementById(proposal.type==='purchase'?'purchase-title':'change-title')?.focus();
}

onMounted(async () => {
  await perform(async () => refresh());
  poller = window.setInterval(() => { if (!busy.value && selectedPlanId.value) loadPlan().catch(report); }, 3_000);
});
onBeforeUnmount(() => { if (poller) window.clearInterval(poller); });
</script>

<template>
  <p v-if="error" class="notice notice-error" role="alert">{{ error }}</p>
  <p v-else-if="notice" class="notice" role="status">{{ notice }}</p>
  <p v-if="hasSandboxOrder" class="scope-note">当前计划包含<strong>支付宝沙箱订单</strong>；打开官方收银台不会自动记为成功，必须回到这里由服务端主动查单或接收已配置的通知。</p>
  <p v-else class="scope-note">此处所有付款、关单和退款结果均来自<strong>本地模拟适配器</strong>，不能视为官方沙箱交易证据。</p>
  <div v-if="plan" class="dashboard-grid">
    <div class="main-column">
      <PlanOverview :plan="plan" :plans="plans" :busy="busy" @select="selectPlan" @pause="pause" />
      <AgentPanel :key="plan.id" :plan-id="plan.id" :plan-version="plan.version" :busy="busy" @review="reviewAgentProposal" />
      <PaymentProgressPanel :plan="plan" :handoffs="paymentHandoffs" :busy="busy" @handoff="requestPaymentHandoff" @recheck="recheckPayment" />
      <ChangePanel :plan="plan" :proposal="changeProposal" :confirmed="changeConfirmed" :busy="busy" @preview="previewChange" @confirm="confirmChange" @execute="executeChange" @clear="clearChange" />
      <AftercarePanel :plan="plan" :busy="busy" @revoke="revokeAftercareAndQuery" @renew="renewQuery" />
    </div>
    <aside class="side-column">
      <PurchasePanel :plan="plan" :proposal="purchaseProposal" :confirmed="Boolean(purchaseConfirmationId)" :busy="busy" @preview="previewPurchase" @confirm="confirmPurchase" @create-orders="createOrders" @clear="clearPurchase" />
      <ActivityFeed :events="events" />
    </aside>
  </div>
  <CreatePlan v-else-if="catalog.length" :catalog="catalog" :busy="busy" @create="createPlan" />
  <EmptyState v-else title="正在读取本地目录" description="若一直无法加载，请确认本地 API、数据库迁移和种子数据均已启动。" />
</template>
