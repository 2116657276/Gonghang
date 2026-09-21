<script setup lang="ts">withDefaults(defineProps<{ title:string; subtitle:string; compact?:boolean }>(),{compact:false});</script>
<template>
  <view class="page-shell">
    <view class="hero" :class="{ 'hero--compact': compact }">
      <view class="hero__sun" /><view class="hero__hill hero__hill--one"/><view class="hero__hill hero__hill--two"/>
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
.hero { position:relative; min-height:250px; padding:calc(42px + env(safe-area-inset-top)) 32px 48px; overflow:hidden; background:linear-gradient(180deg,#E7EFEA 0%,#F4F7F5 100%); }
.hero--compact { min-height:205px; }
.hero__copy { position:relative; z-index:2; }
.hero__title { display:block; color:$brand-deep; font-size:42px; font-weight:760; letter-spacing:-.045em; }
.hero__subtitle { display:block; margin-top:8px; color:$text-secondary; font-size:24px; }
.hero__sun { position:absolute; right:82px; top:54px; width:68px; height:68px; border-radius:50%; background:rgba(235,193,108,.25); }
.hero__hill { position:absolute; bottom:-105px; border-radius:50%; background:rgba(139,175,132,.12); transform:rotate(-5deg); }
.hero__hill--one { left:-100px; width:620px; height:230px; }
.hero__hill--two { right:-180px; width:630px; height:250px; background:rgba(47,111,90,.08); transform:rotate(7deg); }
.page-shell__content { position:relative; z-index:3; width:100%; max-width:750px; margin:-30px auto 0; padding:0 24px 36px; }
@media screen and (max-width:360px){.hero{min-height:232px;padding-right:24px;padding-left:24px}.hero--compact{min-height:194px}.hero__title{font-size:38px}.hero__subtitle{font-size:22px}.page-shell__content{padding-right:18px;padding-left:18px}}
</style>
