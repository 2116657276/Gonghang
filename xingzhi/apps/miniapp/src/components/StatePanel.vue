<script setup lang="ts">withDefaults(defineProps<{ title:string; detail?:string; tone?:'plain'|'error' }>(),{detail:'',tone:'plain'});</script>
<template><view class="state-panel" :class="`state-panel--${tone}`"><text class="state-panel__title">{{ title }}</text><text v-if="detail" class="state-panel__detail">{{ detail }}</text><slot /></view></template>
<style lang="scss">
@use '../styles/tokens' as *;
.state-panel { padding:48px 32px; text-align:center; color:$text-secondary; background:rgba(255,255,255,.82); border:1px dashed $border; border-radius:$radius-card; }
.state-panel--error { color:$danger; background:$danger-surface; border-style:solid; }
.state-panel__title { display:block; color:inherit; font-size:$type-item-title; font-weight:$font-weight-semibold; line-height:1.5; }
.state-panel__detail { display:block; margin-top:12px; font-size:$type-label; font-weight:$font-weight-regular; line-height:1.55; }
</style>
