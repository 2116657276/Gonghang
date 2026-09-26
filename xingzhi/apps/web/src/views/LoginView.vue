<script setup lang="ts">
import { ref } from 'vue';

defineProps<{ busy?: boolean; error?: string }>();
const emit = defineEmits<{ login: [email: string, password: string] }>();
const email = ref('consumer-a@xingzhi.local');
const password = ref('');

function submit() {
  emit('login', email.value.trim(), password.value);
}
</script>

<template>
  <main class="login-page">
    <section class="login-aside" aria-hidden="true"><p class="eyebrow">行止工作台</p><h1>看清事实，<em>稳稳处理</em>每一步。</h1><div class="route-illustration"><span></span><span></span><span></span><span></span></div><p>商户处理订单与退款，审核者核对预算和业务证据。每项操作都以服务端权限和当前事实为准。</p></section>
    <section class="login-panel" aria-labelledby="login-title"><div class="brand login-brand"><span class="brand-mark" aria-hidden="true">行</span><span><strong>行止</strong><small>商户与审核工作台</small></span></div><p class="eyebrow">本地开发入口</p><h2 id="login-title">登录工作台</h2><p>角色由服务端账号确定，前端不会提供越权切换。</p><form @submit.prevent="submit"><label>邮箱<input v-model="email" type="email" autocomplete="username" required /></label><label>密码<input v-model="password" type="password" autocomplete="current-password" required /></label><button class="primary-button" type="submit" :disabled="busy">进入工作台</button></form><p v-if="error" class="notice notice-error" role="alert">{{ error }}</p><details><summary>查看本地测试账号</summary><p>消费者：consumer-a@xingzhi.local<br />商户：merchant@xingzhi.local<br />审核者：reviewer@xingzhi.local</p><p>密码来自本机 <code>.env</code> 的 <code>SEED_DEMO_PASSWORD</code>。</p></details></section>
  </main>
</template>
