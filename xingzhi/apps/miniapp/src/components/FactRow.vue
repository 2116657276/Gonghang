<script setup lang="ts">
withDefaults(defineProps<{ label: string; value: string; emphasis?: boolean }>(), { emphasis: false });
</script>

<template>
  <view class="fact-row">
    <text class="fact-row__label">{{ label }}</text>
    <text class="fact-row__value" :class="{ 'fact-row__value--emphasis': emphasis }">{{ value }}</text>
  </view>
</template>

<style lang="scss">
@use '../styles/tokens' as *;
.fact-row{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;padding:24px 0;border-bottom:1px solid $border}
.fact-row:first-child{padding-top:0}.fact-row:last-child{padding-bottom:0;border-bottom:0}
.fact-row__label{flex:0 0 38%;min-width:0;color:$text-secondary;font-size:$type-label;font-weight:$font-weight-regular;line-height:1.5}.fact-row__value{flex:1;min-width:0;overflow-wrap:anywhere;color:$text-primary;font-size:$type-body;font-weight:$font-weight-medium;line-height:1.5;text-align:right}.fact-row__value--emphasis{color:$brand-primary;font-size:$type-amount-inline;font-weight:$font-weight-semibold;font-variant-numeric:tabular-nums}
@media screen and (max-width:360px){.fact-row{gap:16px}.fact-row__label{flex-basis:40%}}
</style>
