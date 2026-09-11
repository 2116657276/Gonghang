<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, dateTime, type ApiError, yuan } from '../lib/api';
import type { EvidenceExport, EventItem, Plan } from '../lib/types';
import EmptyState from '../components/EmptyState.vue';
import StatusPill from '../components/StatusPill.vue';

const plans = ref<Array<{ id: string; purpose: string; version: number; updatedAt: string }>>([]);
const selectedPlanId = ref<string | null>(null);
const plan = ref<Plan | null>(null);
const events = ref<EventItem[]>([]);
const jsonExport = ref<EvidenceExport | null>(null);
const htmlExport = ref<EvidenceExport | null>(null);
const busy = ref(false);
const loading = ref(true);
const error = ref('');
const notice = ref('');

function report(reason: unknown) {
  error.value = (reason as ApiError).message || '操作没有完成。';
  notice.value = '';
}

async function selectPlan(planId: string) {
  selectedPlanId.value = planId;
  error.value = '';
  notice.value = '';
  const [snapshot, activity] = await Promise.all([
    api<Plan>(`/plans/${planId}`),
    api<{ events: EventItem[] }>(`/plans/${planId}/events`),
  ]);
  plan.value = snapshot;
  events.value = activity.events;
  jsonExport.value = null;
  htmlExport.value = null;
}

async function load() {
  const result = await api<{ plans: typeof plans.value }>('/plans');
  plans.value = result.plans;
  const current = selectedPlanId.value && result.plans.some((item) => item.id === selectedPlanId.value)
    ? selectedPlanId.value
    : result.plans[0]?.id;
  if (current) await selectPlan(current);
  else { selectedPlanId.value = null; plan.value = null; events.value = []; }
}

async function createExport(format: 'json' | 'html') {
  if (!selectedPlanId.value) return;
  busy.value = true;
  error.value = '';
  try {
    const result = await api<EvidenceExport>(`/plans/${selectedPlanId.value}/evidence-exports`, {
      method: 'POST',
      body: JSON.stringify({ format, sections: ['summary', 'orders', 'authorizations', 'aftercare', 'events', 'operations'] }),
    });
    if (format === 'json') jsonExport.value = result;
    else htmlExport.value = result;
    notice.value = `${format.toUpperCase()} 脱敏证据已生成，有效期 24 小时。`;
  } catch (reason) { report(reason); }
  finally { busy.value = false; }
}

onMounted(async () => {
  try { await load(); } catch (reason) { report(reason); } finally { loading.value = false; }
});
</script>

<template>
  <p v-if="error" class="notice notice-error" role="alert">{{ error }}</p>
  <p v-else-if="notice" class="notice" role="status">{{ notice }}</p>
  <div v-if="loading" class="ledger-section" role="status" aria-busy="true">正在读取审核范围……</div>
  <EmptyState v-else-if="!plans.length" title="尚未分配审核范围" description="审核者只会看到服务端明确分配的脱敏计划，不会因前端切换身份获得消费者数据。" />
  <div v-else class="reviewer-layout">
    <aside class="ledger-section reviewer-index" aria-labelledby="review-index-title">
      <div class="section-title"><div><p class="eyebrow">服务端分配范围</p><h2 id="review-index-title">可审阅计划</h2></div></div>
      <ul class="review-list">
        <li v-for="item in plans" :key="item.id" :class="{ 'review-list-active': item.id === selectedPlanId }">
          <button type="button" class="review-plan-button" @click="selectPlan(item.id)">
            <strong>{{ item.purpose }}</strong>
            <span>版本 {{ item.version }} · {{ dateTime(item.updatedAt) }}</span>
          </button>
        </li>
      </ul>
    </aside>

    <main v-if="plan" class="reviewer-detail">
      <section class="ledger-section" aria-labelledby="review-plan-title">
        <div class="section-title split-title">
          <div><p class="eyebrow">脱敏计划事实</p><h2 id="review-plan-title">{{ plan.purpose }}</h2></div>
          <span class="status-pill">版本 {{ plan.version }}</span>
        </div>
        <div class="review-metrics">
          <div><small>计划上限</small><strong>{{ yuan(plan.budget.limitMinor) }}</strong></div>
          <div><small>已支付净额</small><strong>{{ yuan(plan.budget.paidMinor) }}</strong></div>
          <div><small>待核对占用</small><strong>{{ yuan(plan.budget.reservedMinor) }}</strong></div>
          <div><small>待处理操作</small><strong>{{ plan.pending.length }}</strong></div>
        </div>
        <div class="section-actions reviewer-actions">
          <div>
            <p class="eyebrow">受控导出</p>
            <p>只生成本计划的脱敏业务事实，不包含密钥、签名原文或付款凭据。</p>
          </div>
          <div class="button-row">
            <button class="secondary-button" type="button" :disabled="busy" @click="createExport('json')">生成 JSON</button>
            <a v-if="jsonExport" class="secondary-button export-link" :href="jsonExport.downloadUrl" target="_blank" rel="noreferrer">下载 JSON</a>
            <button class="secondary-button" type="button" :disabled="busy" @click="createExport('html')">生成 HTML</button>
            <a v-if="htmlExport" class="secondary-button export-link" :href="htmlExport.downloadUrl" target="_blank" rel="noreferrer">下载 HTML</a>
          </div>
        </div>
      </section>

      <section class="ledger-section" aria-labelledby="review-orders-title">
        <div class="section-title"><div><p class="eyebrow">订单与金额</p><h2 id="review-orders-title">可核对订单</h2></div></div>
        <div v-if="plan.orders.length" class="review-table" role="table" aria-label="计划订单">
          <div class="review-table-row review-table-head" role="row"><span>服务</span><span>金额 / 已退</span><span>付款</span><span>订单状态</span></div>
          <div v-for="order in plan.orders" :key="order.id" class="review-table-row" role="row">
            <span><strong>{{ order.itemName }}</strong><small>{{ order.environment }} · {{ order.provider }}</small></span>
            <span><strong>{{ yuan(order.amountMinor) }}</strong><small>已退 {{ yuan(order.refundedMinor) }}</small></span>
            <StatusPill :value="order.paymentStatus" />
            <StatusPill :value="order.status" />
          </div>
        </div>
        <p v-else class="muted">该计划还没有订单，只有计划项和预算事实。</p>
      </section>

      <section class="ledger-section" aria-labelledby="review-events-title">
        <div class="section-title"><div><p class="eyebrow">事件顺序</p><h2 id="review-events-title">行迹时间线</h2></div></div>
        <ol v-if="events.length" class="review-event-list">
          <li v-for="event in events" :key="event.id"><strong>{{ event.type }}</strong><span>{{ dateTime(event.observedAt) }}</span></li>
        </ol>
        <p v-else class="muted">该计划还没有业务事件。</p>
      </section>
    </main>
  </div>
</template>
