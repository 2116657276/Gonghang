<script setup lang="ts">
import type { MerchantCancellation, RefundBatch } from '../lib/types';
import { dateTime, yuan } from '../lib/api';
import StatusPill from './StatusPill.vue';

const props = defineProps<{ cancellations: MerchantCancellation[]; batches: Record<string, RefundBatch[]>; busy?: boolean }>();
const emit = defineEmits<{ decide: [id: string, decision: 'approve' | 'reject']; schedule: [id: string] }>();

function remaining(item: MerchantCancellation) {
  return Math.max(0, item.acceptedRefundMinor - item.refundedMinor - item.pendingRefundMinor);
}

function expectedDecision(item: MerchantCancellation) {
  if (item.rulePreset === 'reject') return 'reject';
  if (item.rulePreset === 'delay') return null;
  return 'approve';
}
</script>

<template>
  <section class="ledger-section" aria-labelledby="cancellation-title">
    <div class="section-title"><div><p class="eyebrow">取消与退款</p><h2 id="cancellation-title">处理队列</h2></div></div>
    <div v-if="cancellations.length" class="cancellation-list">
      <article v-for="item in cancellations" :key="item.id" class="cancellation-card">
        <header>
          <div><p>{{ item.consumer }} · {{ item.itemName }}</p><strong>{{ yuan(item.amountMinor) }}</strong></div>
          <StatusPill :value="item.status" />
        </header>
        <dl class="amount-facts">
          <div><dt>消费者接受费用</dt><dd>{{ yuan(item.acceptedFeeMinor) }}</dd></div>
          <div><dt>确认退款总额</dt><dd>{{ yuan(item.acceptedRefundMinor) }}</dd></div>
          <div><dt>已退 / 待核对</dt><dd>{{ yuan(item.refundedMinor) }} / {{ yuan(item.pendingRefundMinor) }}</dd></div>
        </dl>
        <p class="muted">规则快照：{{ item.rulePreset }}（版本 {{ item.ruleVersion }}）<template v-if="item.decisionReason">；{{ item.decisionReason }}</template></p>
        <ol v-if="batches[item.id]?.length" class="batch-list" aria-label="已安排退款批次">
          <li v-for="batch in batches[item.id]" :key="batch.id"><span>第 {{ batch.batchNumber }} 批 · {{ yuan(batch.amountMinor) }}<small>{{ dateTime(batch.updatedAt) }}</small></span><StatusPill :value="batch.status" /></li>
        </ol>
        <div class="button-row">
          <template v-if="item.status === 'delayed'">
            <button class="primary-button" type="button" :disabled="busy" @click="emit('decide', item.id, 'approve')">复核后批准</button>
            <button class="secondary-button" type="button" :disabled="busy" @click="emit('decide', item.id, 'reject')">复核后拒绝</button>
          </template>
          <button v-else-if="item.status === 'submitted' && expectedDecision(item)" class="primary-button" type="button" :disabled="busy" @click="emit('decide', item.id, expectedDecision(item) as 'approve' | 'reject')">按规则受理</button>
          <button v-if="['approved', 'refund_processing'].includes(item.status) && remaining(item) > 0" class="primary-button" type="button" :disabled="busy || item.pendingRefundMinor > 0" @click="emit('schedule', item.id)">安排下一固定退款批次</button>
        </div>
      </article>
    </div>
    <p v-else class="muted">目前没有消费者提交的取消申请。</p>
  </section>
</template>
