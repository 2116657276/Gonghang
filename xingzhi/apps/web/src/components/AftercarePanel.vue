<script setup lang="ts">
import { computed } from 'vue';
import type { Plan } from '../lib/types';
import { dateTime, yuan } from '../lib/api';
import StatusPill from './StatusPill.vue';

const props = defineProps<{ plan: Plan; busy?: boolean }>();
const emit = defineEmits<{ revoke: []; renew: [orderIds: string[]] }>();

const currentAuthorizations = computed(() => props.plan.authorizations.filter((item) => ['aftercare', 'query'].includes(item.type)));
const renewableOrderIds = computed(() => [...new Set(props.plan.cancellations.map((item) => item.orderId))]);
const itemName = (orderId: string) => props.plan.orders.find((order) => order.id === orderId)?.itemName ?? '订单';
const authorizationLabel = (type: string) => type === 'aftercare' ? '善后授权' : '查询授权';
</script>

<template>
  <section class="ledger-section aftercare-panel" aria-labelledby="aftercare-title">
    <div class="section-title">
      <div><p class="eyebrow">交易进度与帮助</p><h2 id="aftercare-title">善后事实与责任</h2></div>
    </div>

    <div v-if="currentAuthorizations.length" class="authorization-list" aria-label="善后与查询授权">
      <div v-for="authorization in currentAuthorizations" :key="authorization.id" class="authorization-row">
        <span><strong>{{ authorizationLabel(authorization.type) }}</strong><small>至 {{ dateTime(authorization.expiresAt) }}</small></span>
        <StatusPill :value="authorization.status" />
      </div>
    </div>

    <div v-if="plan.cancellations.length" class="aftercare-list">
      <article v-for="cancellation in plan.cancellations" :key="cancellation.id" class="aftercare-card">
        <header>
          <div><p>{{ itemName(cancellation.orderId) }}</p><strong>退款确认 {{ yuan(cancellation.acceptedRefundMinor) }}</strong></div>
          <StatusPill :value="cancellation.status" />
        </header>
        <dl class="amount-facts">
          <div><dt>取消费用</dt><dd>{{ yuan(cancellation.acceptedFeeMinor) }}</dd></div>
          <div><dt>已明确退回</dt><dd>{{ yuan(cancellation.refundedMinor) }}</dd></div>
          <div><dt>待核对批次</dt><dd>{{ yuan(cancellation.pendingRefundMinor) }}</dd></div>
        </dl>
        <p v-if="cancellation.decisionReason" class="muted">商户结论：{{ cancellation.decisionReason }}</p>
        <ol v-if="cancellation.batches.length" class="batch-list" aria-label="退款批次">
          <li v-for="batch in cancellation.batches" :key="batch.id">
            <span>第 {{ batch.batchNumber }} 批 · {{ yuan(batch.amountMinor) }}</span>
            <StatusPill :value="batch.status" />
          </li>
        </ol>
        <div v-for="task in cancellation.manualTasks.filter((item) => item.state !== 'resolved')" :key="task.id" class="responsibility-note">
          <strong>当前由商户人工跟进</strong>
          <p>{{ task.reason }}</p>
          <small>下一步：{{ task.nextAction }} · {{ dateTime(task.nextReviewAt) }}复核</small>
        </div>
      </article>
    </div>
    <p v-else class="muted">当前没有取消申请。已付款不等于已退款，只有明确成功的退款批次才计入已退金额。</p>

    <div v-if="currentAuthorizations.length" class="section-actions authorization-actions">
      <button class="secondary-button" type="button" :disabled="busy" @click="emit('revoke')">撤回善后与查询授权</button>
      <button class="text-button" type="button" :disabled="busy || !renewableOrderIds.length" @click="emit('renew', renewableOrderIds)">仅续期查询 7 天</button>
    </div>
  </section>
</template>
