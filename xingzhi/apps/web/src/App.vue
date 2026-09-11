<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from './lib/api';
import type { User } from './lib/types';
import AppShell from './components/AppShell.vue';
import ConsumerDashboard from './views/ConsumerDashboard.vue';
import LoginView from './views/LoginView.vue';
import MerchantDashboard from './views/MerchantDashboard.vue';
import ReviewerDashboard from './views/ReviewerDashboard.vue';

const user = ref<User | null>(null);
const busy = ref(true);
const error = ref('');

async function loadSession() {
  try { user.value = (await api<{ user: User }>('/session')).user; } catch { user.value = null; } finally { busy.value = false; }
}

async function login(email: string, password: string) {
  busy.value = true;
  error.value = '';
  try { user.value = (await api<{ user: User }>('/sessions', { method: 'POST', body: JSON.stringify({ email, password }) })).user; }
  catch (reason) { error.value = (reason as Error).message; }
  finally { busy.value = false; }
}

async function logout() {
  try { await api('/session', { method: 'DELETE' }); } finally { user.value = null; error.value = ''; }
}

onMounted(loadSession);
</script>

<template>
  <LoginView v-if="!user" :busy="busy" :error="error" @login="login" />
  <AppShell v-else :user="user" :title="user.role === 'consumer' ? '把变化留在可控范围内' : user.role === 'merchant_admin' ? '本地测试商户' : '只读审核视图'" @logout="logout">
    <ConsumerDashboard v-if="user.role === 'consumer'" />
    <MerchantDashboard v-else-if="user.role === 'merchant_admin'" />
    <ReviewerDashboard v-else />
  </AppShell>
</template>
