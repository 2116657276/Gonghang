<script setup lang="ts">defineProps<{ title: string; action?: string }>(); defineEmits<{ action: [] }>();</script>
<template><view class="section-header"><text class="section-header__title">{{ title }}</text><button v-if="action" class="section-header__action" @tap="$emit('action')">{{ action }}<text aria-hidden="true">›</text></button></view></template>
<style lang="scss">
@use '../styles/tokens' as *;
.section-header { display:flex; min-height:88px; align-items:center; justify-content:space-between; gap:24px; margin:48px 0 12px; }
.section-header__title { flex:1; min-width:0; overflow-wrap:anywhere; color:$text-primary; font-size:36px; font-weight:600; line-height:1.4; letter-spacing:-.015em; }
.section-header__action { display:inline-flex; flex:0 0 auto; min-height:88px; width:auto; align-items:center; justify-content:center; gap:8px; padding:0 4px 0 16px; color:$brand-primary; font-size:28px; font-weight:500; line-height:1.4; white-space:nowrap; }
@media screen and (max-width:360px){.section-header{gap:16px;margin-top:40px}.section-header__action{padding-left:8px}}
</style>
