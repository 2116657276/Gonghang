<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ChangeProposal, Plan } from '../lib/types';
import { dateTime, yuan } from '../lib/api';

const props = defineProps<{ plan: Plan; proposal: ChangeProposal | null; confirmed?: boolean; busy?: boolean }>();
const emit = defineEmits<{ preview: [items: Array<{ planItemId: string; intent: string }>]; confirm: []; execute: []; clear: [] }>();

const selected = ref<Record<string, string>>({});
const stale=computed(()=>!props.confirmed && props.proposal && (props.plan.version!==props.proposal.version || new Date(props.proposal.expiresAt).getTime()<=Date.now()));
const intentLabel:Record<string,string>={keep:'保留',stop:'停止',close:'关单',cancel:'取消并申请退款'};

const available = computed(() => props.plan.items.map((item) => {
  const order = props.plan.orders.find((entry) => entry.planItemId === item.id);
  const choices = !order ? ['keep', 'stop'] : order.paymentStatus === 'paid' ? ['keep', 'cancel'] : order.paymentStatus === 'pending' ? ['keep', 'close'] : ['keep'];
  return { item, order, choices };
}));

watch(() => props.plan.id, () => { selected.value = {}; emit('clear'); });

function requestPreview() {
  const items = Object.entries(selected.value).filter(([, intent]) => intent !== 'keep').map(([planItemId, intent]) => ({ planItemId, intent }));
  if (items.length) emit('preview', items);
}
</script>

<template>
  <section class="ledger-section change-panel" aria-labelledby="change-title">
    <div class="section-title"><div><p class="eyebrow">计划变更</p><h2 id="change-title" tabindex="-1">保留什么，停止什么</h2></div></div>
    <template v-if="!proposal">
      <p class="muted">先暂停购买，再生成逐项影响预览。已付款项只能申请取消，待付款项才能申请关单。</p>
      <div class="change-lines">
        <label v-for="entry in available" :key="entry.item.id"><span>{{ entry.item.name }}</span>
          <select :value="selected[entry.item.id] ?? 'keep'" @change="selected[entry.item.id]=($event.target as HTMLSelectElement).value"><option value="keep">保留</option><option v-for="choice in entry.choices.filter((choice) => choice !== 'keep')" :key="choice" :value="choice">{{ choice === 'stop' ? '停止（无订单）' : choice === 'close' ? '关单（待付款）' : '取消并申请退款' }}</option></select>
        </label>
      </div>
      <button class="secondary-button" type="button" :disabled="busy" @click="requestPreview">生成变更预览</button>
    </template>
    <div v-else class="confirmation-card change-confirmation">
      <div class="confirmation-heading"><span>{{ confirmed?'变更已确认':'待确认变更' }}</span><small>有效至 {{ dateTime(proposal.expiresAt) }}</small></div>
      <ul><li v-for="item in proposal.items" :key="item.planItemId"><span>{{ item.name }} · {{ intentLabel[item.intent] ?? item.intent }}</span><b v-if="item.refundMinor">退 {{ yuan(item.refundMinor) }}</b><b v-else>—</b></li></ul>
      <div class="confirmation-total"><span>接受的取消费用</span><strong>{{ yuan(proposal.totalFeeMinor) }}</strong></div>
      <div class="confirmation-total"><span>接受的退款总额</span><strong>{{ yuan(proposal.totalRefundMinor) }}</strong></div>
      <p class="muted">确认会分别保存善后与查询授权，默认各 7 天；这不是立刻退款成功。</p>
      <p v-if="stale" class="notice notice-error" role="status">方案已过期或计划已变化，请放弃此预览并重新生成。</p>
      <p class="muted">如果助手跟进仍开启，确认后会排队继续；也可使用下方结构化按钮。商户审核和退款仍需等待实际结果。</p>
      <div class="button-row"><button class="primary-button" type="button" :disabled="busy || confirmed || Boolean(stale)" @click="emit('confirm')">{{ confirmed?'范围与金额已确认':'确认范围与金额' }}</button><button class="text-button" type="button" :disabled="busy" @click="emit('clear')">放弃预览</button></div>
      <button class="secondary-button full-width" type="button" :disabled="busy || !confirmed" @click="emit('execute')">提交善后任务</button>
    </div>
  </section>
</template>
