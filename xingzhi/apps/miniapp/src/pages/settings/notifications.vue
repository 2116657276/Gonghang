<script setup lang="ts">
import { ref } from 'vue';
import Taro, { useDidShow } from '@tarojs/taro';
import PageShell from '@/components/PageShell.vue';
import SectionCard from '@/components/SectionCard.vue';
import StatePanel from '@/components/StatePanel.vue';
import { api, ApiError, goLogin } from '@/lib/api';
import { errorMessage } from '@/lib/errors';

type Preferences = { planning: boolean; orders: boolean; refunds: boolean };
const preferences = ref<Preferences>({ planning: true, orders: true, refunds: true });
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const savedNotice = ref(false);
const loaded = ref(false);
async function load() {
  loading.value = true; loaded.value = false; error.value = '';
  try { preferences.value = (await api.preferences()).data.notifications; loaded.value = true; }
  catch (reason) { if (reason instanceof ApiError && reason.status === 401) return goLogin(); error.value = errorMessage(reason); }
  finally { loading.value = false; }
}
async function toggle(key: keyof Preferences) {
  if (saving.value) return;
  const previous = { ...preferences.value };
  preferences.value = { ...preferences.value, [key]: !preferences.value[key] };
  saving.value = true; error.value = '';
  try { preferences.value = (await api.updatePreferences({ notifications: preferences.value })).data.notifications; savedNotice.value = true; setTimeout(() => { savedNotice.value = false; }, 1600); }
  catch (reason) { preferences.value = previous; error.value = errorMessage(reason); }
  finally { saving.value = false; }
}
useDidShow(() => void load());
const rows: Array<{ key: keyof Preferences; title: string; detail: string }> = [
  { key: 'planning', title: '计划提示', detail: '筛选首页的近期还款与 AI 运行摘要；逾期事项仍保留。' },
  { key: 'orders', title: '订单处理', detail: '筛选首页的购买确认、待付款和待查单摘要。' },
  { key: 'refunds', title: '退款处理', detail: '筛选首页的退款处理中摘要。' },
];
</script>

<template>
  <PageShell title="应用内提醒" subtitle="管理首页提示摘要的显示偏好" compact>
    <template #hero><button class="back" @tap="Taro.navigateBack()">‹</button></template>
    <StatePanel v-if="loading" title="正在读取通知偏好" />
    <StatePanel v-else-if="error&&!loaded" title="通知偏好暂时不可用" :detail="error" tone="error"><button class="secondary-button retry" @tap="load">重新加载</button></StatePanel>
    <template v-else><view v-if="savedNotice" class="notice notice--info saved">设置已同步到当前账号</view>
    <view v-if="error" class="notice notice--error saved">{{error}}</view>
    <SectionCard><button v-for="row in rows" :key="row.key" class="preference" :disabled="saving" @tap="toggle(row.key)"><view><text>{{ row.title }}</text><text>{{ row.detail }}</text></view><view class="switch" :class="{'switch--on':preferences[row.key]}"><view/></view></button></SectionCard>
    <view class="notice notice--warning note">这些设置只过滤首页提示摘要，不会隐藏逾期义务、待确认订单等必须处理的入口。偏好可跨设备同步；微信订阅消息尚未接入。</view></template>
  </PageShell>
</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.back{position:absolute;z-index:4;top:calc(34px + env(safe-area-inset-top));right:28px;width:64px;height:64px;color:$brand-deep;background:rgba(255,255,255,.78);border-radius:50%;font-size:44px}.retry{margin-top:24px}.saved{margin-bottom:20px;font-size:28px}.preference{display:flex;width:100%;min-height:144px;align-items:center;justify-content:space-between;gap:24px;padding:24px 0;text-align:left}.preference+.preference{border-top:1px solid $border}.preference>view:first-child{flex:1;min-width:0}.preference text{display:block}.preference text:first-child{font-size:32px;font-weight:680}.preference text+text{margin-top:10px;color:$text-secondary;font-size:26px;line-height:1.55}.switch{position:relative;flex:0 0 96px;width:96px;height:56px;padding:4px;background:#D8E0DC;border-radius:999px}.switch view{width:48px;height:48px;background:#fff;border-radius:50%;box-shadow:0 3px 10px rgba(0,0,0,.13);transition:transform .2s}.switch--on{background:$brand-primary}.switch--on view{transform:translateX(40px)}.note{margin-top:24px;font-size:28px;line-height:1.65}
</style>
