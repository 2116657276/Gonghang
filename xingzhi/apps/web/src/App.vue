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
  <AppShell v-else :user="user" :title="user.role === 'consumer' ? '消费者入口已统一' : user.role === 'merchant_admin' ? '商户订单与退款工作台' : '预算证据审核工作台'" @logout="logout">
    <section v-if="user.role === 'consumer'" class="ledger-section consumer-migration">
      <p class="eyebrow">消费者入口已统一</p>
      <h2>消费者入口已经统一</h2>
      <p class="muted">旧计划写流程已经停用，避免绕过账户、预算周期和本人确认规则。</p>
      <a class="primary-button consumer-entry" href="http://localhost:5173">打开新版消费者端</a>
    </section>
    <MerchantDashboard v-else-if="user.role === 'merchant_admin'" />
    <ReviewerDashboard v-else />
  </AppShell>
</template>

<style scoped>
.consumer-migration { max-width:720px; margin:0 auto; padding:36px; text-align:center; }
.consumer-migration h2 { margin:0; color:#173f45; font-size:26px; }
.consumer-migration .muted { max-width:560px; margin:14px auto 0; font-size:16px; }
.consumer-entry { display:inline-flex; align-items:center; justify-content:center; margin-top:24px; text-decoration:none; }
</style>
