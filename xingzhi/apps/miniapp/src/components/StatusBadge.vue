<script setup lang="ts">
const props=withDefaults(defineProps<{ label:string; tone?:'success'|'warning'|'info'|'neutral'|'danger' }>(),{tone:'neutral'});
</script>
<template><text class="status-badge" :class="`status-badge--${props.tone}`">{{ label }}</text></template>
<style lang="scss">
@use '../styles/tokens' as *;
.status-badge { display:inline-flex; align-items:center; justify-content:center; padding:8px 16px; border-radius:999px; font-size:24px; line-height:1.2; white-space:nowrap; }
.status-badge--success { color:$success; background:$success-surface; }
.status-badge--warning { color:#946423; background:$warning-surface; }
.status-badge--info { color:$info; background:$info-surface; }
.status-badge--danger { color:$danger; background:$danger-surface; }
.status-badge--neutral { color:$text-secondary; background:#F0F3F1; }
</style>
