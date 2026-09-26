<script setup lang="ts">
defineProps<{ title: string; icon: string; open: boolean }>();
defineEmits<{ toggle: [] }>();
</script>

<template>
  <view class="setting-group">
    <view class="setting-group__header">
      <view class="setting-group__icon" :class="`setting-group__icon--${icon}`" aria-hidden="true"><view class="setting-group__icon-mark" /></view>
      <text class="setting-group__title">{{ title }}</text>
    </view>
    <view class="setting-group__body"><slot /></view>
  </view>
</template>

<style lang="scss">
@use '../styles/tokens' as *;
.setting-group{overflow:hidden;background:$card;border:1px solid $border;border-radius:$radius-card}
.setting-group+.setting-group{margin-top:32px}.setting-group__header{display:flex;width:100%;min-height:112px;align-items:center;gap:24px;padding:20px 32px;text-align:left}.setting-group__icon{display:flex;flex:0 0 56px;width:56px;height:56px;align-items:center;justify-content:center;color:$brand-primary;background:$surface-tint;border-radius:18px}.setting-group__icon-mark{position:relative;width:28px;height:28px;border:4px solid currentColor;border-radius:7px}.setting-group__icon-mark::before,.setting-group__icon-mark::after{position:absolute;display:block;background:currentColor;content:''}.setting-group__icon--planning .setting-group__icon-mark::before{left:3px;right:3px;top:5px;height:4px}.setting-group__icon--planning .setting-group__icon-mark::after{left:5px;top:-8px;width:4px;height:10px;border-radius:4px;box-shadow:11px 0 0 currentColor}.setting-group__icon--data .setting-group__icon-mark{border-radius:14px 14px 18px 18px;transform:scaleX(.86)}.setting-group__icon--data .setting-group__icon-mark::before{left:8px;top:5px;width:8px;height:12px;background:transparent;border-bottom:4px solid currentColor;border-right:4px solid currentColor;transform:rotate(45deg)}.setting-group__icon--app .setting-group__icon-mark{border:0}.setting-group__icon--app .setting-group__icon-mark::before{left:1px;top:5px;width:26px;height:4px;border-radius:4px;box-shadow:0 8px 0 currentColor,0 16px 0 currentColor}.setting-group__icon--app .setting-group__icon-mark::after{left:7px;top:1px;width:8px;height:8px;border:3px solid $surface-tint;border-radius:50%;box-shadow:9px 8px 0 -1px currentColor,-3px 16px 0 -1px currentColor}.setting-group__icon--history .setting-group__icon-mark{border-radius:50%}.setting-group__icon--history .setting-group__icon-mark::before{left:10px;top:4px;width:4px;height:10px;border-radius:4px}.setting-group__icon--history .setting-group__icon-mark::after{left:10px;top:12px;width:9px;height:4px;border-radius:4px;transform:rotate(30deg);transform-origin:left center}.setting-group__icon--account .setting-group__icon-mark{height:22px;margin-top:3px}.setting-group__icon--account .setting-group__icon-mark::before{left:-4px;right:-4px;top:5px;height:4px}.setting-group__icon--account .setting-group__icon-mark::after{right:3px;bottom:3px;width:6px;height:6px;border-radius:50%}.setting-group__title{flex:1;color:$text-primary;font-size:36px;font-weight:600;line-height:1.4}
.setting-group__body{display:block;padding:0 32px 12px;border-top:1px solid $border}
</style>
