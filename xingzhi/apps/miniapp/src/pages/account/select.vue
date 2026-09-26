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
        <SectionCard v-for="value in overview.accounts.value" :key="value.account.accountId" class="account" :class="{'account--selected':overview.preferences.value?.defaultAccountId===value.account.accountId,'account--disabled':value.account.status!=='linked'||value.account.accountType!=='debit'}">
          <view class="row-between"><view class="account-identity"><view class="wallet-icon" aria-hidden="true"><view class="wallet-icon__clasp"/></view><view><text class="title">{{ value.account.displayName }}</text><text class="meta">{{ value.account.maskedIdentifier }} · {{ value.account.accountType==='debit'?'借记账户':value.account.accountType }} · {{ value.account.source==='demo'?'Demo 数据':(value.account.source||value.account.provider) }}</text></view></view><StatusBadge :label="value.account.status==='revoked'?'已撤回':value.account.accountType!=='debit'?'不可作主账户':overview.preferences.value?.defaultAccountId===value.account.accountId?'默认账户':'可用于规划'" :tone="value.account.status==='linked'&&value.account.accountType==='debit'?'success':'neutral'"/></view>
          <FactRow label="确认可用资金" :value="yuan(value.cashBasis.confirmedCashMinor)" emphasis />
          <view class="actions"><button class="secondary-button view-action" @tap="open(value.account.accountId)">查看账户依据</button><button v-if="value.account.status==='linked'&&value.account.accountType==='debit'" class="secondary-button choose" :disabled="savingId!==''||overview.preferences.value?.defaultAccountId===value.account.accountId" @tap="select(value.account.accountId)">{{overview.preferences.value?.defaultAccountId===value.account.accountId?'当前默认':savingId===value.account.accountId?'正在保存…':'设为默认'}}</button></view>
        </SectionCard>
      </view>
      <StatePanel v-else title="还没有规划账户" detail="当前账户没有可读取的资金授权，无法建立新的预算周期。" />
      <button class="primary-button create" :disabled="!overview.accounts.value.some(v=>v.account.status==='linked'&&v.account.accountType==='debit')" @tap="Taro.navigateTo({url:'/pages/period/edit'})">使用可用账户新建预算</button>
    </template>
  </PageShell>
</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.back{position:absolute;z-index:4;top:calc(34px + env(safe-area-inset-top));right:28px;width:64px;height:64px;color:$brand-deep;background:rgba(255,255,255,.78);border-radius:50%;font-size:44px}.retry{margin-top:24px}.intro{margin-bottom:24px;font-size:28px;line-height:1.6}.account-list{display:grid;gap:20px}.account{border:2px solid transparent}.account--selected{background:linear-gradient(145deg,$surface-tint,#fff);border-color:rgba(38,125,98,.36)}.account--disabled{background:$soft-surface}.account-identity{display:flex;min-width:0;align-items:center;gap:18px}.wallet-icon{position:relative;flex:0 0 64px;width:64px;height:52px;background:$surface-tint;border:2px solid rgba(38,125,98,.3);border-radius:14px}.wallet-icon::before{position:absolute;inset:10px 8px;border-top:3px solid $brand-primary;content:''}.wallet-icon__clasp{position:absolute;right:-2px;top:18px;width:24px;height:20px;background:$brand-primary;border-radius:10px 0 0 10px}.title,.meta{display:block}.title{font-size:34px;font-weight:730;line-height:1.35}.meta{margin-top:8px;color:$text-secondary;font-size:26px;line-height:1.5}.actions{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:24px}.actions button{width:100%;min-width:0}.view-action,.choose{padding:0 18px}.create{width:100%;margin-top:28px}
@media screen and (max-width:360px){.row-between{align-items:flex-start}.account-identity{align-items:flex-start}.actions{grid-template-columns:1fr}.wallet-icon{flex-basis:56px;width:56px;height:48px}}
</style>
