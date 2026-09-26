<script setup lang="ts">
import { onMounted, ref } from 'vue';
import Taro from '@tarojs/taro';
import IpAvatar from '@/components/IpAvatar.vue';
import { useSession } from '@/composables/useSession';
import { errorMessage } from '@/lib/errors';
import { getSystemInsetStyle } from '@/lib/system-insets';

const session=useSession();
const email=ref('consumer-a@xingzhi.local');
const password=ref('');
const busy=ref(true);
const error=ref('');
const systemInsetStyle=getSystemInsetStyle();

async function enterHome(){
  try{
    await Taro.switchTab({url:'/pages/home/index'});
  }catch{
    // 某些开发者工具版本在首屏登录后会拒绝第一次 switchTab；
    // 会话已经建立时用 reLaunch 重建页面栈，避免把导航失败误报成登录失败。
    await Taro.reLaunch({url:'/pages/home/index'});
  }
}

onMounted(async()=>{
  try {
    const user=await session.restore();
    if(user.role==='consumer')await enterHome();
  } catch { /* 未登录或无法恢复会话时显示登录表单 */ }
  finally { busy.value=false; }
});

async function login(){
  if(!email.value.trim()||!password.value)return;
  busy.value=true;error.value='';
  try{
    const user=await session.signIn(email.value.trim(),password.value);
    if(user.role!=='consumer')throw new Error('小程序当前仅开放消费者工作区。');
    try{
      await enterHome();
    }catch{
      error.value='登录已经成功，但首页暂时无法打开。请在开发者工具重新编译后重试。';
    }
  }catch(reason){error.value=errorMessage(reason);}
  finally{busy.value=false;}
}
</script>

<template>
  <view class="login-page" :style="systemInsetStyle">
    <view class="login-wash" />
    <view class="login-brand"><IpAvatar class="login-mascot" size="large"/><text class="login-brand__name">行止</text><text class="login-brand__tagline">规划当下，看见更好的自己</text></view>
    <view class="login-card">
      <text class="login-card__title">欢迎回来</text>
      <text class="login-card__hint">使用本地测试消费者账号进入</text>
      <label class="field"><text>邮箱</text><input v-model="email" type="text" placeholder="请输入邮箱" /></label>
      <label class="field"><text>密码</text><input v-model="password" password placeholder="请输入本地测试密码" /></label>
      <view v-if="error" class="notice notice--error">{{ error }}</view>
      <button class="primary-button login-submit" :disabled="busy||!email.trim()||!password" @tap="login">{{ busy?'正在进入…':'进入行止' }}</button>
    </view>
    <text class="login-footnote">当前为本地开发环境，资金与交易状态以服务端事实为准。</text>
  </view>
</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.login-page { position:relative; min-height:100vh; padding:var(--app-safe-top, calc(64px + env(safe-area-inset-top))) 40px calc(40px + env(safe-area-inset-bottom)); overflow-x:hidden; overflow-y:auto; background:linear-gradient(180deg,#EEF8F2 0%,$background 45%); }
.login-wash{position:absolute;right:-180px;top:-120px;width:520px;height:360px;background:rgba(225,245,234,.9);border-radius:50%;pointer-events:none}
.login-brand { position:relative; z-index:1; display:flex; flex-direction:column; align-items:center; }
.login-brand :deep(.login-mascot){width:192px;height:192px}.login-brand__name { margin-top:20px; color:$brand-deep; font-size:56px; font-weight:700; letter-spacing:.08em; }.login-brand__tagline { margin-top:12px; color:$text-secondary; font-size:28px; }
.login-card { position:relative; z-index:1; max-width:680px; margin:48px auto 0; padding:40px; background:$card; border:1px solid $border; border-radius:$radius-feature; }
.login-card__title { display:block; font-size:40px; font-weight:700; }.login-card__hint { display:block; margin-top:8px; color:$text-secondary; font-size:28px; }
.field { display:block; margin-top:40px; color:$text-secondary; font-size:28px; }.field input { height:96px; margin-top:12px; padding:0 24px; color:$text-primary; background:$soft-surface; border:1px solid $border; border-radius:$radius-control; font-size:32px; }
.login-card .notice { margin-top:20px; }.login-submit { width:100%; margin-top:48px; }.login-footnote { position:relative;z-index:1;display:block;max-width:680px;margin:24px auto 0;color:$text-tertiary;font-size:28px;line-height:1.55;text-align:center; }
@media screen and (max-height:700px){.login-brand :deep(.login-mascot){width:144px;height:144px}.login-brand__name{margin-top:8px;font-size:48px}.login-brand__tagline{margin-top:4px}.login-card{margin-top:28px;padding:32px}.field{margin-top:28px}.login-footnote{margin-top:18px}}
@media screen and (max-width:360px){.login-page{padding-right:32px;padding-left:32px}.login-card{padding:32px 28px}}
</style>
