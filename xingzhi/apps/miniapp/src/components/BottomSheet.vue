<script setup lang="ts">
withDefaults(defineProps<{
  modelValue: boolean;
  title: string;
  description?: string;
  primaryText?: string;
  secondaryText?: string;
  aboveTabBar?: boolean;
  expanded?: boolean;
}>(), {
  description: '',
  primaryText: '',
  secondaryText: '关闭',
  aboveTabBar: false,
  expanded: false,
});

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  primary: [];
  secondary: [];
}>();

function close() {
  emit('update:modelValue', false);
}

function secondary() {
  emit('secondary');
  close();
}
</script>

<template>
  <view v-if="modelValue" class="sheet-layer" @tap="close">
    <view class="sheet" :class="{'sheet--above-tabbar':aboveTabBar,'sheet--expanded':expanded}" @tap.stop>
      <view class="sheet__handle" />
      <view class="sheet__heading">
        <view>
          <text class="sheet__title">{{ title }}</text>
          <text v-if="description" class="sheet__description">{{ description }}</text>
        </view>
        <button class="sheet__close" aria-label="关闭" @tap="close">×</button>
      </view>
      <scroll-view class="sheet__body" scroll-y>
        <slot />
      </scroll-view>
      <view class="sheet__actions">
        <button v-if="secondaryText" class="secondary-button" @tap="secondary">{{ secondaryText }}</button>
        <button v-if="primaryText" class="primary-button" @tap="$emit('primary')">{{ primaryText }}</button>
      </view>
    </view>
  </view>
</template>

<style lang="scss">
@use '../styles/tokens' as *;
.sheet-layer{position:fixed;z-index:1000;inset:0;display:flex;align-items:flex-end;background:rgba(22,35,29,.42)}
.sheet{width:100%;max-height:72vh;padding:16px 32px calc(32px + env(safe-area-inset-bottom));overflow:hidden;background:$card;border:1px solid rgba(255,255,255,.9);border-radius:48px 48px 0 0;box-shadow:$shadow-sheet}
.sheet--above-tabbar{padding-bottom:calc(60PX + env(safe-area-inset-bottom))}
.sheet__handle{width:72px;height:8px;margin:0 auto 24px;background:#C7D5CD;border-radius:999px}
.sheet__heading{display:flex;align-items:flex-start;justify-content:space-between;gap:22px}.sheet__heading>view{flex:1;min-width:0}
.sheet__title,.sheet__description{display:block}.sheet__title{color:$brand-deep;font-size:40px;font-weight:700;line-height:1.35}.sheet__description{margin-top:12px;color:$text-secondary;font-size:28px;line-height:1.55}
.sheet__close{display:flex;flex:0 0 88px;width:88px;height:88px;align-items:center;justify-content:center;color:$text-secondary;background:$soft-surface;border-radius:50%;font-size:44px;line-height:1}
.sheet__body{max-height:43vh;margin-top:24px}.sheet__actions{display:flex;gap:16px;margin-top:24px}.sheet__actions .secondary-button{flex:1}.sheet__actions .primary-button{flex:1.35}
.sheet--expanded{max-height:88vh}.sheet--expanded .sheet__body{max-height:62vh}
@media screen and (max-width:360px){.sheet{padding:12px 24px calc(24px + env(safe-area-inset-bottom));border-radius:40px 40px 0 0}.sheet--above-tabbar{padding-bottom:calc(60PX + env(safe-area-inset-bottom))}.sheet__handle{margin-bottom:20px}.sheet__body{max-height:48vh;margin-top:20px}.sheet__actions{display:grid;gap:12px;margin-top:20px}.sheet__actions button{width:100%}}
</style>
