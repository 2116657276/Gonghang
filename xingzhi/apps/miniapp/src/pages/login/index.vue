<script setup lang="ts">
import { onMounted, ref } from 'vue';
import Taro from '@tarojs/taro';
import IpAvatar from '@/components/IpAvatar.vue';
import { useSession } from '@/composables/useSession';
import { errorMessage } from '@/lib/errors';

const session=useSession();
const email=ref('consumer-a@xingzhi.local');
const password=ref('');
const busy=ref(true);
const error=ref('');

onMounted(async()=>{
  try { const user=await session.restore(); if(user.role==='consumer')return Taro.switchTab({url:'/pages/home/index'}); }
  catch { /* 未登录时显示登录表单 */ }
  finally { busy.value=false; }
});

async function login(){
  if(!email.value.trim()||!password.value)return;
  busy.value=true;error.value='';
  try{
    const user=await session.signIn(email.value.trim(),password.value);
    if(user.role!=='consumer')throw new Error('小程序当前仅开放消费者工作区。');
    await Taro.switchTab({url:'/pages/home/index'});
  }catch(reason){error.value=errorMessage(reason);}
  finally{busy.value=false;}
}
</script>

<template>
  <view class="login-page">
    <view class="login-orbit login-orbit--one"/><view class="login-orbit login-orbit--two"/>
    <view class="login-brand"><IpAvatar size="large"/><text class="login-brand__name">行止</text><text class="login-brand__tagline">规划当下，看见更好的自己</text></view>
    <view class="login-card">
      <text class="login-card__title">欢迎回来</text>
      <text class="login-card__hint">使用本地测试消费者账号进入</text>
      <label class="field"><text>邮箱</text><input v-model="email" type="text" placeholder="请输入邮箱" /></label>
      <label class="field"><text>密码</text><input v-model="password" password placeholder="请输入本地测试密码" /></label>
      <view v-if="error" class="notice notice--error">{{ error }}</view>
      <button class="primary-button login-submit" :disabled="busy||!email.trim()||!password" @tap="login">{{ busy?'正在进入…':'进入行止' }}</button>
      <text class="login-footnote">本页面展示的是本地开发环境；资金与交易状态以服务端事实为准。</text>
    </view>
  </view>
</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.login-page { position:relative; min-height:100vh; padding:calc(64px + env(safe-area-inset-top)) 34px calc(40px + env(safe-area-inset-bottom)); overflow-x:hidden; overflow-y:auto; background:linear-gradient(180deg,#E6EFEA 0%,#F4F7F5 60%); }
.login-orbit { position:absolute; border-radius:50%; background:rgba(47,111,90,.07); }.login-orbit--one{width:720px;height:360px;left:-300px;top:160px;transform:rotate(-12deg)}.login-orbit--two{width:660px;height:300px;right:-360px;top:40px;transform:rotate(12deg)}
.login-brand { position:relative; z-index:1; display:flex; flex-direction:column; align-items:center; }
.login-brand__name { margin-top:22px; color:$brand-deep; font-size:52px; font-weight:780; letter-spacing:.08em; }
.login-brand__tagline { margin-top:10px; color:$text-secondary; font-size:24px; }
.login-card { position:relative; z-index:1; margin:36px auto 0; padding:38px 30px; background:rgba(255,255,255,.88); border:1px solid rgba(255,255,255,.7); border-radius:24px; box-shadow:0 22px 60px rgba(31,66,54,.1); }
.login-card__title { display:block; font-size:34px; font-weight:720; }.login-card__hint { display:block; margin-top:8px; color:$text-secondary; font-size:23px; }
.field { display:block; margin-top:28px; color:$text-secondary; font-size:22px; }.field input { height:88px; margin-top:10px; padding:0 24px; color:$text-primary; background:$soft-surface; border:1px solid $border; border-radius:18px; font-size:26px; }
.login-card .notice { margin-top:22px; }.login-submit { width:100%; margin-top:30px; }.login-footnote { display:block; margin-top:24px; color:$text-tertiary; font-size:21px; line-height:1.55; text-align:center; }
@media screen and (max-height:700px){.login-page{padding-top:calc(30px + env(safe-area-inset-top))}.login-brand :deep(.ip-avatar--large){transform:scale(.78);margin-block:-18px}.login-brand__name{margin-top:8px;font-size:44px}.login-brand__tagline{margin-top:4px;font-size:21px}.login-card{margin-top:22px;padding:28px 26px}.field{margin-top:20px}.field input{height:76px}.login-footnote{margin-top:18px}}
</style>
