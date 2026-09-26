<script setup lang="ts">
const props=withDefaults(defineProps<{ label:string; tone?:'success'|'warning'|'info'|'neutral'|'danger' }>(),{tone:'neutral'});
</script>
<template><text class="status-badge" :class="`status-badge--${props.tone}`">{{ label }}</text></template>
<style lang="scss">
@use '../styles/tokens' as *;
.status-badge { display:inline-flex; min-height:56px; align-items:center; justify-content:center; padding:8px 16px; border-radius:999px; font-size:28px; font-weight:500; line-height:1.35; white-space:normal; text-align:center; }
.status-badge--success { color:$success; background:$success-surface; }
.status-badge--warning { color:$warning; background:$warning-surface; }
.status-badge--info { color:$info; background:$info-surface; }
.status-badge--danger { color:$danger; background:$danger-surface; }
.status-badge--neutral { color:$text-secondary; background:$soft-surface; }
</style>
