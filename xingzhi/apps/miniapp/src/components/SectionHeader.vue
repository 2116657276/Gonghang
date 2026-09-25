<script setup lang="ts">defineProps<{ title: string; action?: string }>(); defineEmits<{ action: [] }>();</script>
<template><view class="section-header"><text class="section-header__title">{{ title }}</text><button v-if="action" class="section-header__action" @tap="$emit('action')">{{ action }} ›</button></view></template>
<style lang="scss">
@use '../styles/tokens' as *;
.section-header { display:flex; min-height:40px; align-items:center; justify-content:space-between; gap:24px; margin:34px 4px 18px; }
.section-header__title { flex:1; min-width:0; overflow-wrap:anywhere; font-size:34px; font-weight:700; line-height:1.25; letter-spacing:-.02em; }
.section-header__action { display:inline-flex; flex:0 0 auto; width:auto; align-items:center; justify-content:center; padding:4px 0 4px 16px; color:$text-secondary; font-size:27px; line-height:1.25; white-space:nowrap; }
@media screen and (max-width:360px){.section-header{gap:14px;margin:28px 2px 14px}}
</style>
