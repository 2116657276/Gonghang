<script setup lang="ts">
defineProps<{ title: string; icon: string; open: boolean }>();
defineEmits<{ toggle: [] }>();
</script>

<template>
  <view class="setting-group">
    <view class="setting-group__header">
      <view class="setting-group__icon">{{ icon }}</view>
      <text class="setting-group__title">{{ title }}</text>
      <text class="setting-group__state">已展开</text>
    </view>
    <view class="setting-group__body"><slot /></view>
  </view>
</template>

<style lang="scss">
@use '../styles/tokens' as *;
.setting-group{overflow:hidden;background:$card;border:1px solid $border;border-radius:20px;box-shadow:$shadow-card}
.setting-group+.setting-group{margin-top:14px}.setting-group__header{display:flex;width:100%;min-height:88px;align-items:center;gap:16px;padding:18px 24px;text-align:left}.setting-group__icon{display:grid;width:48px;height:48px;place-items:center;color:$brand-primary;background:$surface-tint;border-radius:14px;font-size:24px;font-weight:700}.setting-group__title{flex:1;color:$text-primary;font-size:30px;font-weight:680}.setting-group__state{color:$text-tertiary;font-size:21px}
.setting-group__body{display:block;padding:0 24px 10px;border-top:1px solid $border}
</style>
