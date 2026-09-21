<script setup lang="ts">
import { computed, ref } from 'vue';
import Taro, { useDidShow, useLoad } from '@tarojs/taro';
import FactRow from '@/components/FactRow.vue';
import PageShell from '@/components/PageShell.vue';
import SectionCard from '@/components/SectionCard.vue';
import SectionHeader from '@/components/SectionHeader.vue';
import StatePanel from '@/components/StatePanel.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { shortDate, yuan } from '@/lib/format';
import type { BudgetPeriod, FinanceAccountFacts } from '@/lib/types';

const requestedId = ref('');
const account = ref<FinanceAccountFacts | null>(null);
const period = ref<BudgetPeriod | null>(null);
const loading = ref(true);
const saving = ref(false);
const error = ref('');

useLoad((options) => { requestedId.value = options.id ?? ''; });
useDidShow(() => { void load(); });

const posted = computed(() => account.value?.ledger.filter(item => item.status === 'posted') ?? []);
const inflow = computed(() => posted.value.filter(item => item.direction === 'inflow').reduce((sum, item) => sum + item.amountMinor, 0));
const outflow = computed(() => posted.value.filter(item => item.direction === 'outflow').reduce((sum, item) => sum + item.amountMinor, 0));
const obligationTotal = computed(() => account.value?.obligations.remainingDueMinor
  ?? account.value?.obligations.items.reduce((sum, item) => sum + (item.remainingDueMinor ?? item.amountDueMinor ?? 0), 0)
  ?? null);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [accountResult, periodResult] = await Promise.all([api.accounts(), api.periods()]);
    account.value = accountResult.data.accounts.find(item => item.account.accountId === requestedId.value)
      ?? accountResult.data.accounts.find(item => item.account.status === 'linked' && item.account.accountType === 'debit')
      ?? accountResult.data.accounts[0]
      ?? null;
    period.value = periodResult.data.periods.find(item => item.period.accountId === account.value?.account.accountId && item.period.status === 'active')
      ?? periodResult.data.periods.find(item => item.period.accountId === account.value?.account.accountId)
      ?? null;
  } catch (reason) {
    error.value = errorMessage(reason);
  } finally {
    loading.value = false;
  }
}

function openImpact() {
  if (!period.value) return;
  void Taro.navigateTo({ url: `/pages/impact/detail?periodId=${period.value.period.periodId}` });
}
async function reauthorize() {
  if (!account.value || saving.value) return;
  const accepted = await Taro.showModal({ title: '重新启用 Demo 账户？',
    content: '这只会重新授权本地演示数据，不代表已连接真实银行账户。重新启用后，新的资金判断将使用当前 Demo 事实。', confirmText: '确认启用' });
  if (!accepted.confirm) return;
  saving.value = true; error.value = '';
  try { await api.reauthorizeDemoAccount(account.value.account.accountId); await load(); Taro.showToast({ title: 'Demo 账户已启用', icon: 'success' }); }
  catch (reason) { error.value = errorMessage(reason); }
  finally { saving.value = false; }
}
</script>

<template>
  <PageShell title="账户详情" subtitle="看清行止正在使用的资金依据" compact>
    <template #hero><button class="back" aria-label="返回" @tap="Taro.navigateBack()">‹</button></template>
    <StatePanel v-if="loading" title="正在核对账户事实" detail="余额、流水与未来义务分开读取。" />
    <StatePanel v-else-if="error || !account" title="账户详情暂时不可用" :detail="error || '没有找到可查看的账户。'" tone="error">
      <button class="secondary-button retry" @tap="load">重新加载</button>
    </StatePanel>
    <template v-else>
      <SectionCard class="balance-card">
        <view class="card-heading">
          <view><text class="eyebrow">当前可用于判断的现金</text><text class="account-name">{{ account.account.displayName }} {{ account.account.maskedIdentifier }}</text></view>
          <StatusBadge :label="account.account.status === 'linked' ? '已连接' : '已撤回'" :tone="account.account.status === 'linked' ? 'success' : 'neutral'" />
        </view>
        <text class="balance amount">{{ yuan(account.cashBasis.confirmedCashMinor) }}</text>
        <text class="balance-note">{{ account.cashBasis.dataStatus === 'observed' ? '来自已核验资金事实' : '当前依据不足，不会按 0 元处理' }}</text>
      </SectionCard>

      <SectionHeader title="资金依据" />
      <SectionCard>
        <FactRow label="快照时间" :value="shortDate(account.latestSnapshot?.asOf)" />
        <FactRow label="执行依据时间" :value="shortDate(account.cashBasis.asOf)" />
        <FactRow label="账户来源" :value="account.account.source || account.account.provider" />
        <FactRow label="资金版本" :value="`v${account.account.financialVersion}`" />
        <view v-if="account.cashBasis.reasonCodes.length" class="reason-list">
          <text>仍需留意</text>
          <text v-for="reason in account.cashBasis.reasonCodes" :key="reason">{{ reason }}</text>
        </view>
      </SectionCard>

      <SectionHeader title="本期资金构成" />
      <SectionCard class="facts-card">
        <view class="metric-grid">
          <view><text>已入账收入</text><b class="amount amount--in">{{ yuan(inflow) }}</b></view>
          <view><text>已入账支出</text><b class="amount">{{ yuan(outflow) }}</b></view>
        </view>
        <FactRow label="未来义务" :value="yuan(obligationTotal)" />
        <FactRow label="预计收入（不计入现金）" :value="yuan(account.displayOnly.expectedIncomeMinor)" />
        <FactRow label="待核退款（不计入现金）" :value="yuan(account.displayOnly.pendingRefundMinor)" />
        <FactRow v-if="period" label="当前保留目标" :value="yuan(period.basis.savingsTargetMinor)" emphasis />
      </SectionCard>

      <view class="page-actions">
        <button v-if="period" class="primary-button" @tap="openImpact">查看完整资金影响</button>
        <button v-if="account.account.status === 'linked'" class="secondary-button danger-action" @tap="Taro.navigateTo({url:`/pages/account/revoke-confirm?id=${account.account.accountId}`})">撤回账户授权</button>
        <button v-else-if="account.account.source==='demo'" class="primary-button" :loading="saving" :disabled="saving" @tap="reauthorize">重新启用 Demo 账户</button>
      </view>
      <view v-if="error" class="notice notice--error boundary">{{error}}</view>
      <view class="notice notice--info boundary">预计收入、待核退款与未来义务只用于解释，不会提前增加当前可用现金。</view>
    </template>
  </PageShell>
</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.back{position:absolute;z-index:4;top:calc(34px + env(safe-area-inset-top));right:28px;width:64px;height:64px;color:$brand-deep;background:rgba(255,255,255,.72);border-radius:50%;font-size:44px}.retry{margin:20px auto 0}
.balance-card{background:linear-gradient(145deg,#fff,#F2F7F4)}.card-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.eyebrow,.account-name,.balance,.balance-note{display:block}.eyebrow{color:$text-secondary;font-size:21px}.account-name{margin-top:7px;font-size:27px;font-weight:700}.balance{margin-top:30px;font-size:50px;font-weight:780;line-height:1.1}.balance-note{margin-top:10px;color:$text-tertiary;font-size:20px;line-height:1.5}
.reason-list{margin-top:18px;padding:18px 20px;background:$warning-surface;border-radius:16px}.reason-list text{display:block;color:#79562B;font-size:20px;line-height:1.55}.reason-list text:first-child{margin-bottom:6px;font-size:22px;font-weight:680}
.metric-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:10px}.metric-grid view{min-width:0;padding:18px;background:$soft-surface;border-radius:16px}.metric-grid text,.metric-grid b{display:block}.metric-grid text{color:$text-secondary;font-size:20px}.metric-grid b{margin-top:9px;font-size:28px;overflow-wrap:anywhere}.amount--in{color:$success}.page-actions{display:grid;gap:12px;margin-top:22px}.page-actions button{width:100%}.danger-action{color:$danger}.boundary{margin-top:18px}
@media screen and (max-width:360px){.card-heading{align-items:flex-start}.balance{font-size:43px}.metric-grid{grid-template-columns:1fr}.page-actions{gap:10px}}
</style>
