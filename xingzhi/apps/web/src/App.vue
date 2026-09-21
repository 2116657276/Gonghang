<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from './lib/api';
import type { User } from './lib/types';
import AppShell from './components/AppShell.vue';
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
    <section v-if="user.role === 'consumer'" class="ledger-section">
      <p class="eyebrow">消费者入口已统一</p>
      <h2>请使用新版行止消费者端</h2>
      <p class="muted">旧计划写流程已经停用，避免绕过账户、预算周期和本人确认规则。</p>
      <a class="primary-button consumer-entry" href="http://localhost:5173">打开新版消费者端</a>
    </section>
    <MerchantDashboard v-else-if="user.role === 'merchant_admin'" />
    <ReviewerDashboard v-else />
  </AppShell>
</template>

<style scoped>
.consumer-entry { display:inline-flex; margin-top:18px; text-decoration:none; }
</style>
