<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api, apiData, dateTime, type ApiError, yuan } from '../lib/api';
import type { BudgetEvidenceExport, BudgetReviewEvidence, BudgetReviewSummary,
  EvidenceExport, EventItem, Plan } from '../lib/types';
import EmptyState from '../components/EmptyState.vue';
import StatusPill from '../components/StatusPill.vue';

const periods = ref<BudgetReviewSummary[]>([]), selectedPeriodId = ref<string | null>(null);
const evidence = ref<BudgetReviewEvidence | null>(null);
const currentExports = ref<Partial<Record<'json' | 'html', BudgetEvidenceExport>>>({});
const plans = ref<Array<{ id: string; purpose: string; version: number; updatedAt: string }>>([]);
const selectedPlanId = ref<string | null>(null), plan = ref<Plan | null>(null), events = ref<EventItem[]>([]);
const legacyExports = ref<Partial<Record<'json' | 'html', EvidenceExport>>>({});
const busy = ref(false), loading = ref(true), detailLoading = ref(false);
const error = ref(''), notice = ref('');
let periodSequence = 0, planSequence = 0;

function report(reason: unknown) { error.value = (reason as ApiError).message || '操作没有完成。'; notice.value = ''; }
async function selectPeriod(periodId: string) {
  const sequence = ++periodSequence;
  selectedPeriodId.value = periodId; detailLoading.value = true; error.value = ''; notice.value = '';
  try {
    const result = await apiData<BudgetReviewEvidence>(`/reviewer/budget-periods/${periodId}`);
    if (sequence === periodSequence && selectedPeriodId.value === periodId) { evidence.value = result; currentExports.value = {}; }
  }
  catch (reason) { if (sequence === periodSequence) { evidence.value = null; report(reason); } }
  finally { if (sequence === periodSequence) detailLoading.value = false; }
}
async function selectPlan(planId: string) {
  const sequence = ++planSequence;
  selectedPlanId.value = planId; error.value = '';
  try {
    const [nextPlan, nextEvents] = await Promise.all([api<Plan>(`/plans/${planId}`),
      api<{ events: EventItem[] }>(`/plans/${planId}/events`).then(result => result.events)]);
    if (sequence === planSequence && selectedPlanId.value === planId) {
      plan.value = nextPlan; events.value = nextEvents; legacyExports.value = {};
    }
  } catch (reason) { if (sequence === planSequence) { plan.value = null; events.value = []; report(reason); } }
}
async function load() {
  loading.value = true;
  try {
    const [current, history] = await Promise.all([
      apiData<{ periods: BudgetReviewSummary[] }>('/reviewer/budget-periods'),
      api<{ plans: typeof plans.value }>('/plans'),
    ]);
    periods.value = current.periods; plans.value = history.plans;
    if (periods.value.length) await selectPeriod(periods.value[0]!.periodId);
    else if (plans.value.length) await selectPlan(plans.value[0]!.id);
    error.value = '';
  } catch (reason) { report(reason); }
  finally { loading.value = false; }
}
async function createCurrentExport(format: 'json' | 'html') {
  if (!selectedPeriodId.value || busy.value) return;
  busy.value = true; error.value = '';
  try {
    currentExports.value[format] = await apiData<BudgetEvidenceExport>(
      `/reviewer/budget-periods/${selectedPeriodId.value}/evidence-exports`,
      { method: 'POST', body: JSON.stringify({ format }) });
    notice.value = `${format.toUpperCase()} 预算证据已生成，有效期 24 小时。`;
  } catch (reason) { report(reason); } finally { busy.value = false; }
}
async function createLegacyExport(format: 'json' | 'html') {
  if (!selectedPlanId.value || busy.value) return;
  busy.value = true; error.value = '';
  try {
    legacyExports.value[format] = await api<EvidenceExport>(`/plans/${selectedPlanId.value}/evidence-exports`, {
      method: 'POST', body: JSON.stringify({ format,
        sections: ['summary', 'orders', 'authorizations', 'aftercare', 'events', 'operations'] }),
    });
    notice.value = `${format.toUpperCase()} 历史计划证据已生成，有效期 24 小时。`;
  } catch (reason) { report(reason); } finally { busy.value = false; }
}
const eventLabel = (type: string) => ({ payment_posted: '付款已入账', refund_requested: '退款已申请',
  refund_verified: '渠道退款已核验', refund_posted: '退款已到账' }[type] ?? type);
onMounted(load);
</script>

<template>
  <p v-if="error" class="notice notice-error" role="alert">{{ error }} <button class="text-button" type="button" @click="load">重新加载</button></p>
  <p v-else-if="notice" class="notice" role="status">{{ notice }}</p>
  <div v-if="loading" class="ledger-section" role="status" aria-busy="true">正在读取审核范围……</div>
  <EmptyState v-else-if="!periods.length && !plans.length" title="尚未分配审核范围" description="审核者只能读取服务端明确分配的预算周期或历史计划。" />
  <div v-else class="reviewer-dashboard">
    <div v-if="periods.length" class="reviewer-layout">
      <aside class="ledger-section reviewer-index" aria-labelledby="period-index-title">
        <div class="section-title"><div><p class="eyebrow">当前预算事实</p><h2 id="period-index-title">可审阅周期</h2></div></div>
        <ul class="review-list"><li v-for="item in periods" :key="item.periodId" :class="{'review-list-active':item.periodId===selectedPeriodId}">
          <button type="button" class="review-plan-button" @click="selectPeriod(item.periodId)"><strong>{{ item.monthStart.slice(0,7) }} 月度计划</strong><span>版本 {{ item.periodVersion }} · {{ item.accountStatus==='revoked'?'账户已撤回':'账户已连接' }}</span></button>
        </li></ul>
      </aside>

      <main class="reviewer-detail">
        <section v-if="detailLoading" class="ledger-section" role="status" aria-busy="true">正在读取预算证据……</section>
        <template v-else-if="evidence">
          <section class="ledger-section" aria-labelledby="budget-review-title">
            <div class="section-title split-title"><div><p class="eyebrow">脱敏预算事实</p><h2 id="budget-review-title">{{ evidence.period.monthStart }} 至 {{ evidence.period.monthEnd }}</h2></div><StatusPill :value="evidence.period.status" /></div>
            <div class="review-metrics"><div><small>保留目标</small><strong>{{ yuan(evidence.period.savingsTargetMinor) }}</strong></div><div><small>预算版本</small><strong>{{ evidence.period.periodVersion }}</strong></div><div><small>资金来源</small><strong>{{ evidence.period.accountSource==='demo'?'演示数据':'银行接口' }}</strong></div><div><small>账户授权</small><strong>{{ evidence.period.accountStatus==='revoked'?'已撤回':'已连接' }}</strong></div></div>
            <div class="section-actions reviewer-actions"><div><p class="eyebrow">受控导出</p><p>页面与导出使用同一审核范围，不包含账户号、密钥或原始幂等键。</p></div><div class="button-row">
              <button class="secondary-button" type="button" :disabled="busy" @click="createCurrentExport('json')">生成 JSON</button><a v-if="currentExports.json" class="secondary-button export-link" :href="currentExports.json.downloadUrl" target="_blank" rel="noreferrer">下载 JSON</a>
              <button class="secondary-button" type="button" :disabled="busy" @click="createCurrentExport('html')">生成 HTML</button><a v-if="currentExports.html" class="secondary-button export-link" :href="currentExports.html.downloadUrl" target="_blank" rel="noreferrer">下载 HTML</a>
            </div></div>
            <ul v-if="evidence.missingEvidence.length" class="evidence-warnings"><li v-for="item in evidence.missingEvidence" :key="item">{{ item }}</li></ul>
          </section>

          <section class="ledger-section"><div class="section-title"><div><p class="eyebrow">订单与原确认</p><h2>可核对订单</h2></div></div>
            <div v-if="evidence.orders.length" class="review-table"><div class="review-table-row review-table-head"><span>业务编号</span><span>金额 / 已退</span><span>付款</span><span>订单状态</span></div>
              <div v-for="order in evidence.orders" :key="order.orderId" class="review-table-row"><span><strong>{{ order.orderId.slice(0,8) }}…</strong><small>资金 {{order.financialVersion}} · 预算 {{order.periodVersion}} · 报价 {{order.quoteVersion}}</small></span><span><strong>{{ yuan(order.amountMinor) }}</strong><small>已退 {{ yuan(order.refundedMinor) }}</small></span><StatusPill :value="order.paymentStatus"/><StatusPill :value="order.status"/></div>
            </div><p v-else class="muted">该预算周期还没有已确认订单。</p>
          </section>

          <section class="ledger-section"><div class="section-title"><div><p class="eyebrow">资金与操作证据</p><h2>支付、退款与恢复</h2></div></div>
            <div class="evidence-columns"><div><h3>资金事件</h3><ol v-if="evidence.moneyEvents.length" class="review-event-list"><li v-for="event in evidence.moneyEvents" :key="event.eventId"><strong>{{ eventLabel(event.eventType) }} · {{ yuan(event.amountMinor) }}</strong><span>{{ dateTime(event.observedAt) }} · {{ event.verificationState }}</span></li></ol><p v-else class="muted">暂无资金事件。</p></div>
              <div><h3>后台操作</h3><ol v-if="evidence.operations.length" class="review-event-list"><li v-for="operation in evidence.operations" :key="operation.operationId"><strong>{{ operation.type }} · {{ operation.state }}</strong><span>{{ operation.businessNumberRef??'无业务号摘要' }} · 尝试 {{ operation.attemptCount }} 次</span></li></ol><p v-else class="muted">暂无后台操作。</p></div></div>
          </section>

          <section class="ledger-section"><div class="section-title"><div><p class="eyebrow">事件顺序</p><h2>预算时间线</h2></div></div><ol v-if="evidence.timeline.length" class="review-event-list"><li v-for="event in evidence.timeline" :key="`${event.referenceId}-${event.type}`"><strong>{{ event.type }}</strong><span>{{ dateTime(event.observedAt) }} · {{ event.actorRole }}</span></li></ol><p v-else class="muted">该周期还没有业务事件。</p></section>
        </template>
      </main>
    </div>

    <details v-if="plans.length" class="legacy-section"><summary>查看历史计划审核入口</summary><div class="legacy-content reviewer-layout">
      <aside class="ledger-section reviewer-index"><div class="section-title"><div><p class="eyebrow">旧计划归档</p><h2>可审阅计划</h2></div></div><ul class="review-list"><li v-for="item in plans" :key="item.id" :class="{'review-list-active':item.id===selectedPlanId}"><button class="review-plan-button" type="button" @click="selectPlan(item.id)"><strong>{{item.purpose}}</strong><span>版本 {{item.version}} · {{dateTime(item.updatedAt)}}</span></button></li></ul></aside>
      <main v-if="plan" class="reviewer-detail"><section class="ledger-section"><div class="section-title split-title"><div><p class="eyebrow">历史计划事实</p><h2>{{plan.purpose}}</h2></div><span class="status-pill">版本 {{plan.version}}</span></div><div class="review-metrics"><div><small>计划上限</small><strong>{{yuan(plan.budget.limitMinor)}}</strong></div><div><small>已支付净额</small><strong>{{yuan(plan.budget.paidMinor)}}</strong></div><div><small>待核对占用</small><strong>{{yuan(plan.budget.reservedMinor)}}</strong></div><div><small>历史事件</small><strong>{{events.length}}</strong></div></div><div class="button-row legacy-export"><button class="secondary-button" :disabled="busy" @click="createLegacyExport('json')">生成 JSON</button><a v-if="legacyExports.json" class="secondary-button export-link" :href="legacyExports.json.downloadUrl" target="_blank">下载 JSON</a><button class="secondary-button" :disabled="busy" @click="createLegacyExport('html')">生成 HTML</button><a v-if="legacyExports.html" class="secondary-button export-link" :href="legacyExports.html.downloadUrl" target="_blank">下载 HTML</a></div></section></main>
    </div></details>
  </div>
</template>
