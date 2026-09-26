<script setup lang="ts">
import { computed, ref } from 'vue';
import Taro, { useLoad } from '@tarojs/taro';
import FactRow from '@/components/FactRow.vue';
import PageShell from '@/components/PageShell.vue';
import SectionCard from '@/components/SectionCard.vue';
import StatePanel from '@/components/StatePanel.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import type { FinanceAccountFacts } from '@/lib/types';

const id = ref('');
const account = ref<FinanceAccountFacts | null>(null);
const loading = ref(true);
const saving = ref(false);
const acknowledged = ref(false);
const completed = ref(false);
const error = ref('');
const canSubmit = computed(() => acknowledged.value && !saving.value && account.value?.account.status === 'linked');

useLoad(async (options) => {
  id.value = options.id ?? '';
  try {
    const result = await api.accounts();
    account.value = result.data.accounts.find(item => item.account.accountId === id.value) ?? null;
  } catch (reason) {
    error.value = errorMessage(reason);
  } finally {
    loading.value = false;
  }
});

async function revoke() {
  if (!account.value || !canSubmit.value) return;
  saving.value = true;
  error.value = '';
  try {
    await api.revokeAccount(id.value, { expectedStatus: 'linked' });
    completed.value = true;
  } catch (reason) {
    error.value = errorMessage(reason);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <PageShell title="撤回账户授权" subtitle="这是高风险操作，请先看清影响" compact>
    <template #hero><button class="back" aria-label="返回" @tap="Taro.navigateBack()">‹</button></template>
    <StatePanel v-if="loading" title="正在核对账户状态" />
    <StatePanel v-else-if="error && !account" title="无法读取账户" :detail="error" tone="error" />
    <template v-else-if="completed">
      <SectionCard class="result-card"><view class="result-icon" aria-hidden="true"><view/></view><StatusBadge label="授权已撤回" tone="neutral"/><text class="result-title">后续不会再基于该账户创建新的资金安排</text><text class="result-copy">历史记录、既有订单和订单善后仍然保留，可以继续查看。</text></SectionCard>
      <button class="primary-button full" @tap="Taro.switchTab({url:'/pages/profile/index'})">返回我的</button>
      <button class="secondary-button full" @tap="Taro.navigateTo({url:'/pages/orders/index'})">查看既有订单</button>
    </template>
    <template v-else-if="account">
      <SectionCard><FactRow label="撤回账户" :value="`${account.account.displayName} ${account.account.maskedIdentifier}`"/><FactRow label="当前状态" :value="account.account.status === 'linked' ? '已连接' : '已撤回'"/></SectionCard>
      <SectionCard class="impact-card"><text class="section-title">撤回后将无法继续</text><text>创建依赖该账户的新预算</text><text>进行新的购买资金评估</text><text>创建新的购买意图或支付执行</text></SectionCard>
      <SectionCard class="keep-card"><text class="section-title">仍然可以</text><text>查看历史计划和账目</text><text>查看既有订单</text><text>处理历史订单的关闭、取消与退款善后</text></SectionCard>
      <button class="acknowledge" :class="{'acknowledge--checked':acknowledged}" @tap="acknowledged=!acknowledged"><view class="acknowledge__check" aria-hidden="true"><view/></view><text>我已了解撤回后的影响，并确认继续</text></button>
      <view v-if="error" class="notice notice--error error-box">{{error}}</view>
      <button class="primary-button revoke-button" :disabled="!canSubmit" :loading="saving" @tap="revoke">{{saving?'正在撤回…':'确认撤回授权'}}</button>
      <button class="secondary-button full" :disabled="saving" @tap="Taro.navigateBack()">保留授权</button>
    </template>
  </PageShell>
</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.back{position:absolute;z-index:4;top:calc(34px + env(safe-area-inset-top));right:28px;width:64px;height:64px;color:$brand-deep;background:rgba(255,255,255,.78);border-radius:50%;font-size:44px}.impact-card,.keep-card{margin-top:24px}.impact-card{background:$danger-surface;border-color:#E7C5C1}.keep-card{background:$success-surface;border-color:#CFE2D7}.section-title,.impact-card>text,.keep-card>text{display:block}.section-title{margin-bottom:16px;font-size:34px;font-weight:740}.impact-card>text:not(.section-title),.keep-card>text:not(.section-title){position:relative;padding:10px 0 10px 34px;color:$text-secondary;font-size:28px;line-height:1.55}.impact-card>text:not(.section-title)::before,.keep-card>text:not(.section-title)::before{position:absolute;left:3px;content:'•'}.acknowledge{display:flex;width:100%;min-height:96px;align-items:center;gap:18px;margin-top:28px;padding:22px 24px;text-align:left;background:$card;border:2px solid $border;border-radius:24px}.acknowledge__check{position:relative;flex:0 0 42px;width:42px;height:42px;border:3px solid $text-tertiary;border-radius:12px}.acknowledge__check view{display:none}.acknowledge text{font-size:29px;line-height:1.55}.acknowledge--checked{background:$surface-tint;border-color:#AFCBBB}.acknowledge--checked .acknowledge__check{background:$brand-primary;border-color:$brand-primary}.acknowledge--checked .acknowledge__check view{display:block;position:absolute;left:11px;top:5px;width:12px;height:22px;border-right:4px solid #fff;border-bottom:4px solid #fff;transform:rotate(45deg)}.revoke-button,.full{width:100%;margin-top:16px}.revoke-button{background:$danger}.error-box{margin-top:20px}.result-card{text-align:center}.result-icon{position:relative;width:88px;height:88px;margin:0 auto 24px;background:$soft-surface;border-radius:50%}.result-icon view{position:absolute;left:25px;top:18px;width:28px;height:42px;border-right:7px solid $text-secondary;border-bottom:7px solid $text-secondary;transform:rotate(45deg)}.result-title,.result-copy{display:block}.result-title{margin-top:28px;font-size:36px;font-weight:740;line-height:1.45}.result-copy{margin-top:16px;color:$text-secondary;font-size:28px;line-height:1.65}
</style>
