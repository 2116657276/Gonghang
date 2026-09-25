<script setup lang="ts">
import { computed } from 'vue';
import StatusBadge from './StatusBadge.vue';
import type { BudgetItem } from '@/lib/types';
import { fundingLabel, shortDate, yuan } from '@/lib/format';

const props = defineProps<{
  item: BudgetItem;
  group: 'active' | 'attention' | 'draft' | 'ended';
  forecastStatus: 'allowed' | 'needs_adjustment' | 'blocked' | 'unknown';
  supportingText: string;
}>();

const emit = defineEmits<{ open: []; impact: []; ask: [] }>();
function openAction() { if (props.group === 'attention') emit('impact'); else emit('open'); }

const icon = computed(() => props.item.priority === 'required' ? '必' : '愿');
const groupCopy = computed(() => props.group === 'ended'
  ? { label: props.item.status === 'cancelled' ? '已取消' : '已完成', tone: 'neutral' as const, action: '查看记录' }
  : props.group === 'draft'
  ? { label: '草稿待完善', tone: 'neutral' as const, action: '继续完善' }
  : props.group === 'attention'
    ? { label: fundingLabel(props.forecastStatus), tone: props.forecastStatus === 'unknown' ? 'info' as const : 'warning' as const, action: '看看影响' }
    : { label: props.item.status === 'committed' ? '已形成承诺' : '进行中', tone: 'success' as const, action: '查看详情' });
</script>

<template>
  <view class="plan-item" :class="`plan-item--${group}`" @tap="$emit('open')">
    <view class="plan-item__top">
      <view class="plan-item__icon">{{ icon }}</view>
      <view class="plan-item__copy">
        <text class="plan-item__title">{{ item.title }}</text>
        <text class="plan-item__date">{{ shortDate(item.plannedOn) }} · {{ item.priority === 'required' ? '必须保留' : '可以调整' }}</text>
      </view>
      <text class="plan-item__amount amount">{{ yuan(item.userEstimatedAmountMinor) }}</text>
    </view>
    <view class="plan-item__status">
      <view>
        <StatusBadge :label="groupCopy.label" :tone="groupCopy.tone" />
        <text class="plan-item__support">{{ supportingText }}</text>
      </view>
      <button class="link-button" @tap.stop="openAction">{{ groupCopy.action }} ›</button>
      <button v-if="group!=='ended'" class="link-button" @tap.stop="emit('ask')">问行止</button>
    </view>
  </view>
</template>

<style lang="scss">
@use '../styles/tokens' as *;
.plan-item{padding:26px;background:$card;border:1px solid $border;border-radius:20px;box-shadow:$shadow-card}
.plan-item--draft{background:#F9FBFA;border-style:dashed}.plan-item--attention{border-color:#E8D1AC}
.plan-item__top{display:flex;align-items:flex-start;gap:16px}.plan-item__icon{display:flex;flex:0 0 54px;height:54px;align-items:center;justify-content:center;color:$brand-primary;background:$surface-tint;border-radius:16px;font-size:24px;font-weight:700}
.plan-item__copy{flex:1;min-width:0}.plan-item__title,.plan-item__date{display:block}.plan-item__title{overflow:hidden;font-size:30px;font-weight:680;text-overflow:ellipsis;white-space:nowrap}.plan-item__date{margin-top:7px;color:$text-secondary;font-size:25px}
.plan-item__amount{flex:0 0 auto;font-size:30px;font-weight:700;white-space:nowrap}.plan-item__status{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-top:22px;padding-top:18px;border-top:1px solid $border}.plan-item__status>view{flex:1;min-width:0}.plan-item__support{display:block;margin-top:9px;color:$text-secondary;font-size:25px;line-height:1.4}.plan-item__status .link-button{flex:0 0 auto;white-space:nowrap}
@media screen and (max-width:360px){.plan-item{padding:22px}.plan-item__top{display:grid;grid-template-columns:48px minmax(0,1fr);gap:14px}.plan-item__icon{width:48px;height:48px}.plan-item__amount{grid-column:2;margin-top:2px}.plan-item__title{white-space:normal}.plan-item__status{align-items:flex-start}.plan-item__status .link-button{padding-top:3px}}
</style>
