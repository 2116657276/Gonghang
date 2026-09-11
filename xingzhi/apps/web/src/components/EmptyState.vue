<script setup lang="ts">
defineProps<{ title: string; description: string }>();
</script>

<template>
  <section class="empty-state" role="status">
    <span class="empty-symbol" aria-hidden="true">·</span>
    <h2>{{ title }}</h2>
    <p>{{ description }}</p>
  </section>
</template>
