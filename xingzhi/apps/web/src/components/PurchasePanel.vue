<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Plan, PurchaseProposal } from '../lib/types';
import { dateTime, yuan } from '../lib/api';

const props = defineProps<{ plan: Plan; proposal: PurchaseProposal | null; confirmed?: boolean; busy?: boolean }>();
const emit = defineEmits<{
  preview: [itemIds: string[]];
  confirm: [limitMinor: number, restoreItemIds: string[]];
  createOrders: [];
  clear: [];
}>();

const selected = ref<string[]>([]);
const limitYuan = ref('3000');
const purchasable = computed(() => props.plan.items.filter((item) => !item.hasOrder && item.kind !== 'unbooked' && item.status !== 'stopped'));
const stale = computed(()=>!props.confirmed && props.proposal && (props.plan.version!==props.proposal.version || new Date(props.proposal.expiresAt).getTime()<=Date.now()));
const amountMinor = computed(()=>{
  if(!/^\d+(\.\d{1,2})?$/.test(limitYuan.value))return null;
  const amount=Math.round(Number(limitYuan.value)*100);
  return Number.isSafeInteger(amount) && amount>0 && amount<=1_000_000?amount:null;
});

watch(() => props.plan.id, () => { selected.value = []; emit('clear'); });

function toggle(id: string) {
  selected.value = selected.value.includes(id) ? selected.value.filter((itemId) => itemId !== id) : [...selected.value, id];
}

function confirm() {
  const amount = amountMinor.value;
  if (amount !== null && !stale.value && !props.confirmed) {
    emit('confirm', amount, props.proposal?.items.filter((item) => props.plan.pausedItemIds.includes(item.planItemId)).map((item) => item.planItemId) ?? []);
  }
}
</script>

<template>
  <section class="ledger-section purchase-panel" aria-labelledby="purchase-title">
    <div class="section-title"><div><p class="eyebrow">结构化购买</p><h2 id="purchase-title" tabindex="-1">确认前先看清范围</h2></div></div>
    <div v-if="!proposal">
      <p class="muted">选择尚未建单的项目，系统只会生成预览；此时不会占用预算。</p>
      <div class="mini-options">
        <label v-for="item in purchasable" :key="item.id"><input type="checkbox" :checked="selected.includes(item.id)" @change="toggle(item.id)" /> {{ item.name }} <b>{{ yuan(item.priceMinor) }}</b></label>
      </div>
      <button class="primary-button" type="button" :disabled="busy || !selected.length" @click="emit('preview', selected)">生成购买预览</button>
    </div>
    <div v-else class="confirmation-card">
      <div class="confirmation-heading"><span>{{ confirmed?'范围已确认':'待确认' }}</span><small>有效至 {{ dateTime(proposal.expiresAt) }}</small></div>
      <ul><li v-for="item in proposal.items" :key="item.planItemId"><span>{{ item.name }}</span><b>{{ yuan(item.priceMinor) }}</b></li></ul>
      <div class="confirmation-total"><span>本次金额</span><strong>{{ yuan(proposal.totalMinor) }}</strong></div>
      <label>计划购买总上限（元）<input v-model="limitYuan" inputmode="decimal" aria-describedby="purchase-limit-help" /></label>
      <p id="purchase-limit-help" class="muted">若本次是暂停后的恢复，确认会明确恢复本次选择范围，历史账本不会重置。</p>
      <p v-if="stale" class="notice notice-error" role="status">方案已过期或计划已变化，请放弃此预览并重新生成。</p>
      <p v-if="amountMinor===null" class="muted">请输入不超过 10000 元、最多两位小数的正金额。</p>
      <p class="muted">如果助手跟进仍开启，确认后会排队继续；也可使用下方结构化按钮。沙箱付款仍需你在官方收银台完成。</p>
      <div class="button-row"><button class="primary-button" type="button" :disabled="busy || confirmed || Boolean(stale) || amountMinor===null" @click="confirm">{{ confirmed?'购买范围已确认':'确认购买范围' }}</button><button class="text-button" type="button" :disabled="busy" @click="emit('clear')">放弃预览</button></div>
      <button class="secondary-button full-width" type="button" :disabled="busy || !confirmed" @click="emit('createOrders')">按已确认范围创建订单</button>
    </div>
  </section>
</template>
