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

const iconKind = computed(() => props.item.kind === 'expected_income'
  ? 'income'
  : props.item.priority === 'required' ? 'required' : 'adjustable');
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
      <view class="plan-item__icon" :class="`plan-item__icon--${iconKind}`" aria-hidden="true"><view class="plan-item__icon-mark" /></view>
      <view class="plan-item__copy">
        <text class="plan-item__title">{{ item.title }}</text>
        <text class="plan-item__date">{{ shortDate(item.plannedOn) }} · {{ item.priority === 'required' ? '必须保留' : '可以调整' }}</text>
      </view>
      <text class="plan-item__amount amount">{{ yuan(item.userEstimatedAmountMinor) }}</text>
    </view>
    <view class="plan-item__status">
      <view class="plan-item__status-copy">
        <StatusBadge :label="groupCopy.label" :tone="groupCopy.tone" />
        <text class="plan-item__support">{{ supportingText }}</text>
      </view>
      <view class="plan-item__actions">
        <button class="link-button" @tap.stop="openAction">{{ groupCopy.action }} ›</button>
        <button v-if="group!=='ended'" class="link-button" @tap.stop="emit('ask')">问行止</button>
      </view>
    </view>
  </view>
</template>

<style lang="scss">
@use '../styles/tokens' as *;
.plan-item{padding:32px;background:$card;border:1px solid $border;border-radius:$radius-card}
.plan-item--draft{background:#FAFCFA;border-style:dashed}.plan-item--attention{border-color:rgba(133,80,26,.25)}.plan-item--ended{background:$soft-surface}
.plan-item__top{display:flex;align-items:flex-start;gap:24px}.plan-item__icon{position:relative;display:flex;flex:0 0 80px;width:80px;height:80px;align-items:center;justify-content:center;color:$brand-primary;background:$surface-tint;border-radius:24px}
.plan-item__icon-mark{position:relative;width:34px;height:30px;border:4px solid currentColor;border-radius:8px}
.plan-item__icon-mark::before,.plan-item__icon-mark::after{position:absolute;display:block;content:'';background:currentColor}
.plan-item__icon--required .plan-item__icon-mark::before{left:8px;top:-12px;width:10px;height:12px;border-radius:8px 8px 0 0}
.plan-item__icon--required .plan-item__icon-mark::after{right:5px;top:9px;width:7px;height:7px;border-radius:50%}
.plan-item__icon--adjustable{color:$warning;background:$accent-cream}.plan-item__icon--adjustable .plan-item__icon-mark{width:28px;height:34px;border-width:0 0 4px 4px;border-radius:0 0 0 18px;transform:rotate(-18deg)}
.plan-item__icon--adjustable .plan-item__icon-mark::before{left:8px;top:-5px;width:22px;height:14px;border-radius:22px 2px 22px 2px;transform:rotate(28deg)}
.plan-item__icon--adjustable .plan-item__icon-mark::after{left:-4px;top:6px;width:18px;height:12px;border-radius:2px 18px 2px 18px;transform:rotate(-28deg)}
.plan-item__icon--income{color:$info;background:$accent-blue}.plan-item__icon--income .plan-item__icon-mark{width:32px;height:32px;border:0;border-bottom:4px solid currentColor;border-radius:0}.plan-item__icon--income .plan-item__icon-mark::before{left:14px;top:0;width:4px;height:24px}.plan-item__icon--income .plan-item__icon-mark::after{left:8px;top:0;width:16px;height:16px;background:transparent;border-top:4px solid currentColor;border-right:4px solid currentColor;transform:rotate(-45deg)}
.plan-item__copy{flex:1;min-width:0}.plan-item__title,.plan-item__date{display:block}.plan-item__title{overflow-wrap:anywhere;font-size:32px;font-weight:600;line-height:1.45}.plan-item__date{margin-top:8px;color:$text-secondary;font-size:28px;line-height:1.5}
.plan-item__amount{flex:0 0 auto;font-size:36px;font-weight:700;line-height:1.3;white-space:nowrap}.plan-item__status{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-top:24px;padding-top:20px;border-top:1px solid $border}.plan-item__status-copy{flex:1;min-width:0}.plan-item__support{display:block;margin-top:10px;color:$text-secondary;font-size:28px;line-height:1.5}.plan-item__actions{display:flex;flex:0 0 auto;align-items:center;gap:8px}.plan-item__actions .link-button{white-space:nowrap}
@media screen and (max-width:360px){.plan-item{padding:28px}.plan-item__top{display:grid;grid-template-columns:72px minmax(0,1fr);gap:20px}.plan-item__icon{width:72px;height:72px}.plan-item__amount{grid-column:2;margin-top:2px}.plan-item__status{display:block}.plan-item__actions{justify-content:flex-end;margin-top:8px}}
</style>
