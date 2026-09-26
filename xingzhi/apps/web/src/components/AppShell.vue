<script setup lang="ts">
import type { User } from '../lib/types';

defineProps<{ user: User; title: string }>();
const emit = defineEmits<{ logout: [] }>();

const roleLabel = (role: User['role']) => ({ consumer: '消费者', merchant_admin: '商户管理员', reviewer: '只读审核者' })[role];
</script>

<template>
  <header class="site-header">
    <a class="brand" href="/" aria-label="行止首页">
      <span class="brand-mark" aria-hidden="true">行</span>
      <span><strong>行止</strong><small>计划行迹</small></span>
    </a>
    <div class="header-context">
      <span class="environment-tag">本地模拟环境</span>
      <span class="identity"><b>{{ user.displayName }}</b> · {{ roleLabel(user.role) }}</span>
      <button class="text-button" type="button" @click="emit('logout')">退出</button>
    </div>
  </header>
  <main class="app-main">
    <div class="page-heading">
      <p class="eyebrow">{{ roleLabel(user.role) }}工作区</p>
      <h1>{{ title }}</h1>
    </div>
    <slot />
  </main>
</template>
