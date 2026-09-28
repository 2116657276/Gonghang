<script setup lang="ts">
import { computed } from 'vue';
import Taro from '@tarojs/taro';
import { getSystemInsetStyle } from '@/lib/system-insets';

const props = withDefaults(defineProps<{
  title: string;
  subtitle?: string;
  compact?: boolean;
  layout?: 'legacy' | 'main' | 'detail' | 'conversation';
  back?: boolean;
  backFallback?: string;
}>(), { subtitle: '', compact: false, layout: 'legacy', back: false, backFallback: '/pages/home/index' });
const systemInsetStyle = getSystemInsetStyle();
const navigationLayout = computed(() => props.layout === 'legacy' && props.compact ? 'detail' : props.layout);
const showBack = computed(() => props.back || (props.layout === 'legacy' && props.compact));

async function goBack() {
  try {
    await Taro.navigateBack();
  } catch {
    await Taro.switchTab({ url: props.backFallback });
  }
}
</script>
<template>
  <view class="page-shell" :style="systemInsetStyle">
    <view v-if="navigationLayout === 'legacy'" class="hero" :class="{ 'hero--compact': props.compact }">
      <view class="hero__wash hero__wash--one" /><view class="hero__wash hero__wash--two" />
      <view class="hero__copy"><text class="hero__title">{{ props.title }}</text><text class="hero__subtitle">{{ props.subtitle }}</text></view>
      <slot name="hero" />
    </view>
    <view v-else class="nav-hero" :class="`nav-hero--${navigationLayout}`">
      <view class="hero__wash hero__wash--one" /><view class="hero__wash hero__wash--two" />
      <view class="nav-hero__bar">
        <button v-if="showBack" class="nav-hero__back" aria-label="返回" @tap="goBack"><text aria-hidden="true">‹</text></button>
        <view v-else-if="navigationLayout === 'main'" class="nav-hero__brand-mark" aria-hidden="true" />
        <text class="nav-hero__title">{{ props.title }}</text>
        <view v-if="$slots.action" class="nav-hero__action"><slot name="action" /></view>
      </view>
      <text v-if="props.subtitle" class="nav-hero__subtitle">{{ props.subtitle }}</text>
    </view>
    <view class="page-shell__content"><slot /></view>
    <view class="page-safe-bottom" />
  </view>
</template>
<style lang="scss">
@use '../styles/tokens' as *;
.page-shell { min-height:100vh; overflow-x:hidden; overflow-y:visible; background:$background; }
.hero {
  position:relative;
  min-height:224px;
  padding:var(--app-safe-top, calc(42px + env(safe-area-inset-top))) 32px 28px;
  overflow:hidden;
  background:linear-gradient(180deg,#EEF8F2 0%,#F7FAF7 100%);
}
.hero--compact { min-height:190px; }
.hero__copy { position:relative; z-index:2; padding-right:96px; }
.hero__title { display:block; color:$brand-deep; font-size:48px; font-weight:700; line-height:1.3; letter-spacing:-.035em; overflow-wrap:anywhere; }
.hero__subtitle { display:block; margin-top:12px; color:$text-secondary; font-size:28px; line-height:1.5; }
.hero__wash { position:absolute; border-radius:50%; pointer-events:none; }
.hero__wash--one { right:-110px; top:-82px; width:300px; height:230px; background:rgba(225,245,234,.8); }
.hero__wash--two { left:-150px; bottom:-120px; width:440px; height:220px; background:rgba(232,241,255,.42); }
.nav-hero {
  position:relative;
  padding-top:var(--app-status-bar-height, 0px);
  padding-bottom:24px;
  overflow:hidden;
  background:linear-gradient(180deg,#EEF8F2 0%,#F7FAF7 100%);
}
.nav-hero__bar {
  position:relative;
  z-index:2;
  display:flex;
  min-height:var(--app-nav-height, 48px);
  align-items:center;
  gap:16px;
  padding-left:32px;
  padding-right:var(--app-menu-safe-right, 16px);
}
.nav-hero__brand-mark { flex:0 0 16px; width:16px; height:32px; background:$brand-primary; border-radius:999px; }
.nav-hero__back {
  display:flex;
  flex:0 0 88px;
  width:88px;
  height:88px;
  align-items:center;
  justify-content:center;
  margin-left:-20px;
  color:$brand-deep;
  background:transparent;
  border-radius:50%;
  font-size:52px;
  line-height:1;
}
.nav-hero__title { flex:1; min-width:0; color:$brand-deep; font-size:$type-page-title; font-weight:$font-weight-bold; line-height:1.3; overflow-wrap:anywhere; }
.nav-hero--detail .nav-hero__title,
.nav-hero--conversation .nav-hero__title { color:$text-primary; font-size:$type-nav-title; font-weight:$font-weight-semibold; }
.nav-hero__action { display:flex; flex:0 0 auto; align-items:center; justify-content:center; }
.nav-hero__subtitle { position:relative; z-index:2; display:block; margin-top:4px; padding:0 32px; color:$text-secondary; font-size:$type-label; font-weight:$font-weight-regular; line-height:1.5; overflow-wrap:anywhere; }
.nav-hero--detail .nav-hero__subtitle,
.nav-hero--conversation .nav-hero__subtitle { padding-left:136px; }
.page-shell__content { position:relative; z-index:3; width:100%; max-width:1000px; margin:0 auto; padding:0 32px 48px; }
.page-shell__content .title,
.page-shell__content .card-title,
.page-shell__content .section-title,
.page-shell__content .heading,
.page-shell__content .heading-title > text { font-size:$type-section-title; font-weight:$font-weight-semibold; line-height:1.45; overflow-wrap:anywhere; }
.page-shell__content .item-title { font-size:$type-item-title; font-weight:$font-weight-semibold; line-height:1.45; overflow-wrap:anywhere; }
.page-shell__content .price { font-size:$type-amount-card; font-weight:$font-weight-bold; line-height:1.2; letter-spacing:-.02em; }
.page-shell__content .muted,
.page-shell__content .meta,
.page-shell__content .rule,
.page-shell__content .copy,
.page-shell__content .suggestion,
.page-shell__content .description { font-size:$type-label; font-weight:$font-weight-regular; line-height:1.6; }
.page-shell__content .field > text { font-size:$type-label; font-weight:$font-weight-regular; }
.page-shell__content .field input,
.page-shell__content .field textarea,
.page-shell__content .picker-value { font-size:$type-body; font-weight:$font-weight-regular; }
@media screen and (max-width:360px){.hero{min-height:216px;padding-right:24px;padding-left:24px}.hero--compact{min-height:184px}.hero__copy{padding-right:84px}.nav-hero{padding-bottom:20px}.nav-hero__bar{gap:12px;padding-left:24px}.nav-hero__subtitle{padding-right:24px;padding-left:24px}.nav-hero--detail .nav-hero__subtitle,.nav-hero--conversation .nav-hero__subtitle{padding-left:124px}.page-shell__content{padding-right:24px;padding-left:24px}}
</style>
