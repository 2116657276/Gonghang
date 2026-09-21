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
.fact-row{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;padding:18px 0;border-bottom:1px solid $border}
.fact-row:first-child{padding-top:0}.fact-row:last-child{padding-bottom:0;border-bottom:0}
.fact-row__label{flex:0 0 auto;color:$text-secondary;font-size:23px}.fact-row__value{min-width:0;max-width:62%;overflow-wrap:anywhere;font-size:24px;font-weight:620;line-height:1.45;text-align:right}.fact-row__value--emphasis{color:$brand-primary;font-size:28px}
@media screen and (max-width:360px){.fact-row{gap:14px;padding:16px 0}.fact-row__label{font-size:21px}.fact-row__value{max-width:66%;font-size:22px}.fact-row__value--emphasis{font-size:25px}}
</style>
