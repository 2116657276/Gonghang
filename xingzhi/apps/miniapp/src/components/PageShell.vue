<script setup lang="ts">
import { getSystemInsetStyle } from '@/lib/system-insets';

withDefaults(defineProps<{ title:string; subtitle:string; compact?:boolean }>(),{compact:false});
const systemInsetStyle = getSystemInsetStyle();
</script>
<template>
  <view class="page-shell" :style="systemInsetStyle">
    <view class="hero" :class="{ 'hero--compact': compact }">
      <view class="hero__wash hero__wash--one" /><view class="hero__wash hero__wash--two" />
      <view class="hero__copy"><text class="hero__title">{{ title }}</text><text class="hero__subtitle">{{ subtitle }}</text></view>
      <slot name="hero" />
    </view>
    <view class="page-shell__content"><slot /></view>
    <view class="page-safe-bottom" />
  </view>
</template>
<style lang="scss">
@use '../styles/tokens' as *;
.page-shell { min-height:100vh; overflow:hidden; background:$background; }
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
.page-shell__content { position:relative; z-index:3; width:100%; max-width:1000px; margin:0 auto; padding:0 32px 48px; }
@media screen and (max-width:360px){.hero{min-height:216px;padding-right:24px;padding-left:24px}.hero--compact{min-height:184px}.hero__copy{padding-right:84px}.page-shell__content{padding-right:24px;padding-left:24px}}
</style>
