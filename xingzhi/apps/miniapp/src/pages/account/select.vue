<script setup lang="ts">
import { ref } from 'vue';
import Taro, { useDidShow } from '@tarojs/taro';
import FactRow from '@/components/FactRow.vue';
import PageShell from '@/components/PageShell.vue';
import SectionCard from '@/components/SectionCard.vue';
import StatePanel from '@/components/StatePanel.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { useOverview } from '@/composables/useOverview';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { yuan } from '@/lib/format';

const overview = useOverview();
const savingId = ref('');
const saveError = ref('');
useDidShow(() => void overview.load());
function open(id: string) { void Taro.navigateTo({ url: `/pages/account/detail?id=${id}` }); }
async function select(id: string) {
  if (savingId.value || id === overview.preferences.value?.defaultAccountId) return;
  savingId.value = id; saveError.value = '';
  try { await api.updatePreferences({ defaultAccountId: id }); await overview.load(); Taro.showToast({ title: '已设为默认账户', icon: 'success' }); }
  catch (reason) { saveError.value = errorMessage(reason); }
  finally { savingId.value = ''; }
}
</script>

<template>
  <PageShell title="规划账户" subtitle="查看当前可用于资金判断的账户" compact>
    <template #hero><button class="back" @tap="Taro.navigateBack()">‹</button></template>
    <StatePanel v-if="overview.loading.value" title="正在读取账户" />
    <StatePanel v-else-if="overview.error.value" title="账户暂时不可用" :detail="overview.error.value" tone="error"><button class="secondary-button retry" @tap="overview.load">重新加载</button></StatePanel>
    <template v-else>
      <view class="notice notice--info intro">已建立的预算周期始终使用创建时确认的账户；新建周期时可在创建页面重新选择，不会偷偷更换已有周期的资金依据。</view>
      <view v-if="saveError" class="notice notice--error intro">{{ saveError }}</view>
      <view v-if="overview.accounts.value.length" class="account-list">
        <SectionCard v-for="value in overview.accounts.value" :key="value.account.accountId" class="account">
          <view class="row-between"><view><text class="title">{{ value.account.displayName }}</text><text class="meta">{{ value.account.maskedIdentifier }} · {{ value.account.accountType==='debit'?'借记账户':value.account.accountType }}</text></view><StatusBadge :label="overview.preferences.value?.defaultAccountId===value.account.accountId?'默认账户':value.account.status==='linked'?'可用于规划':'已撤回'" :tone="value.account.status==='linked'?'success':'neutral'"/></view>
          <FactRow label="确认可用资金" :value="yuan(value.cashBasis.confirmedCashMinor)" emphasis />
          <view class="actions"><button class="text-button" @tap="open(value.account.accountId)">查看账户依据</button><button v-if="value.account.status==='linked'&&value.account.accountType==='debit'" class="secondary-button choose" :disabled="savingId!==''||overview.preferences.value?.defaultAccountId===value.account.accountId" @tap="select(value.account.accountId)">{{overview.preferences.value?.defaultAccountId===value.account.accountId?'当前默认':savingId===value.account.accountId?'正在保存…':'设为默认'}}</button></view>
        </SectionCard>
      </view>
      <StatePanel v-else title="还没有规划账户" detail="当前账户没有可读取的资金授权，无法建立新的预算周期。" />
      <button class="primary-button create" :disabled="!overview.accounts.value.some(v=>v.account.status==='linked')" @tap="Taro.navigateTo({url:'/pages/period/edit'})">使用可用账户新建预算</button>
    </template>
  </PageShell>
</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.back{position:absolute;z-index:4;top:calc(34px + env(safe-area-inset-top));right:28px;width:64px;height:64px;color:$brand-deep;background:rgba(255,255,255,.7);border-radius:50%;font-size:44px}.retry{margin-top:18px}.intro{margin-bottom:16px}.account-list{display:grid;gap:14px}.title,.meta{display:block}.title{font-size:27px;font-weight:700}.meta{margin-top:7px;color:$text-secondary;font-size:21px}.actions{display:flex;align-items:center;justify-content:flex-end;gap:14px;margin-top:16px}.text-button{color:$brand-primary;font-size:22px;font-weight:620}.choose{min-width:146px;padding:0 20px}.create{width:100%;margin-top:20px}
</style>
