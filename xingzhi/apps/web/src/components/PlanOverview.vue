<script setup lang="ts">
import type { Plan } from '../lib/types';
import { yuan } from '../lib/api';
import StatusPill from './StatusPill.vue';

const props = defineProps<{ plan: Plan; plans: Array<{ id: string; purpose: string; version: number }>; busy?: boolean }>();
const emit = defineEmits<{ select: [id: string]; pause: [] }>();

const isPaused = (id: string) => props.plan.pausedItemIds.includes(id);
function selectPlan(event: Event) {
  emit('select', (event.target as HTMLSelectElement).value);
}
</script>

<template>
  <section class="ledger-section plan-overview" aria-labelledby="plan-title">
    <div class="section-title split-title">
      <div><p class="eyebrow">当前计划</p><h2 id="plan-title">{{ plan.purpose }}</h2></div>
      <label class="compact-select">切换计划
        <select :value="plan.id" :disabled="busy" @change="selectPlan">
          <option v-for="entry in plans" :key="entry.id" :value="entry.id">{{ entry.purpose }}</option>
        </select>
      </label>
    </div>
    <div class="budget-strip" aria-label="预算概览">
      <div><small>计划上限</small><strong>{{ yuan(plan.budget.limitMinor) }}</strong></div>
      <div><small>已支付净额</small><strong>{{ yuan(plan.budget.paidMinor) }}</strong></div>
      <div><small>待核对占用</small><strong>{{ yuan(plan.budget.reservedMinor) }}</strong></div>
      <div class="budget-remaining"><small>仍可安排</small><strong>{{ yuan(plan.budget.remainingMinor) }}</strong></div>
    </div>
    <div class="item-ledger" role="list" aria-label="计划项目">
      <article v-for="item in plan.items" :key="item.id" class="plan-item" role="listitem">
        <div class="trail-marker" aria-hidden="true"></div>
        <div class="item-copy"><p>{{ ({ transport:'交通',stay:'住宿',activity:'活动',unbooked:'未安排' } as Record<string,string>)[item.kind] ?? item.kind }}</p><h3>{{ item.name }}</h3><span v-if="isPaused(item.id)" class="paused-note">购买已暂停</span></div>
        <div class="item-amount"><strong>{{ item.kind === 'unbooked' ? '未购买' : yuan(item.priceMinor) }}</strong><StatusPill :value="item.hasOrder ? (plan.orders.find((order) => order.planItemId === item.id)?.paymentStatus ?? item.status) : item.status==='pending'?'not_ordered':item.status" /></div>
      </article>
    </div>
    <div class="section-actions">
      <button class="secondary-button" type="button" :disabled="busy" @click="emit('pause')">暂停新的购买</button>
      <p>暂停会立即阻止行止受控入口继续建单；已在途的模拟结果仍会保留并显示。</p>
    </div>
  </section>
</template>
