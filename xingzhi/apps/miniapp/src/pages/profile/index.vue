<script setup lang="ts">
import { computed, ref } from 'vue';
import Taro, { useDidShow } from '@tarojs/taro';
import BottomSheet from '@/components/BottomSheet.vue';
import IpAvatar from '@/components/IpAvatar.vue';
import PageShell from '@/components/PageShell.vue';
import SectionCard from '@/components/SectionCard.vue';
import SettingGroup from '@/components/SettingGroup.vue';
import StatePanel from '@/components/StatePanel.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { useOverview } from '@/composables/useOverview';
import { useAmountVisibility } from '@/composables/useAmountVisibility';
import { useSession } from '@/composables/useSession';
import { goLogin } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { clockTime, shortDate, yuan } from '@/lib/format';

const overview = useOverview();
const { balanceVisible, toggleBalanceVisibility, resetBalanceVisibility } = useAmountVisibility();
const session = useSession();
const logoutOpen = ref(false);
const revokeOpen = ref(false);
const loggingOut = ref(false);
const logoutError = ref('');
useDidShow(() => { void overview.load(); });

const revokedAccount = computed(() => overview.accounts.value.find(value =>
  value.account.accountType === 'debit' && value.account.status === 'revoked') ?? null);
const displayAccount = computed(() => overview.primaryAccount.value ?? revokedAccount.value);
const accountStatus = computed(() => overview.primaryAccount.value ? '已连接'
  : revokedAccount.value ? '已撤回' : '无可用账户');
const accountUpdated = computed(() => {
  const current = overview.primaryAccount.value;
  const value = current?.cashBasis.asOf ?? displayAccount.value?.latestSnapshot?.asOf;
  if (!value) return '数据时间未知';
  return `${current?.cashBasis.asOf ? '资金依据' : '最近历史快照'} ${shortDate(value)} ${clockTime(value)}`;
});
const defaultAccountCopy = computed(() => {
  const selected = overview.primaryAccount.value;
  if (!selected) return revokedAccount.value ? '需重新授权' : '未选择';
  return selected.account.accountId === overview.preferences.value?.defaultAccountId
    ? selected.account.displayName : `自动选用 ${selected.account.displayName}`;
});
async function logout() {
  loggingOut.value = true; logoutError.value = '';
  try { await session.signOut(); resetBalanceVisibility(); goLogin(); }
  catch (reason) { logoutError.value = errorMessage(reason); loggingOut.value = false; }
}
function showRevokeRules() { const id=overview.primaryAccount.value?.account.accountId;revokeOpen.value=false;if(id)Taro.navigateTo({url:`/pages/account/revoke-confirm?id=${id}`}); }
function openAccount() { const id=displayAccount.value?.account.accountId;Taro.navigateTo({url:id?`/pages/account/detail?id=${id}`:'/pages/account/select'}); }
function editReserveTarget() { if(!overview.primaryAccount.value){void Taro.navigateTo({url:'/pages/account/select'});return;}const id=overview.currentPeriod.value?.period.periodId;if(id)Taro.navigateTo({url:`/pages/period/edit?id=${id}`});else Taro.navigateTo({url:'/pages/period/edit'}); }
</script>

<template>
  <PageShell title="我的" subtitle="管理账户、授权和行止设置">
    <StatePanel v-if="overview.loading.value" title="正在读取账户设置" />
    <StatePanel v-else-if="overview.error.value" title="账户设置暂时不可用" :detail="overview.error.value" tone="error"><button class="secondary-button retry" @tap="overview.load">重新加载</button></StatePanel>
    <template v-else>
      <SectionCard class="identity-card" @tap="Taro.navigateTo({url:'/subpackage/common/profile-info'})"><IpAvatar size="medium"/><view class="identity-card__copy"><text>{{ overview.user.value?.displayName }}</text><text>{{ overview.user.value?.email }}</text></view><StatusBadge label="查看资料" tone="success"/></SectionCard>
      <SectionCard class="account-card" @tap="openAccount"><view class="row-between"><view><text class="account-card__title">我的主账户</text><text class="account-card__name">{{ displayAccount?.account.displayName??'尚未连接账户' }} {{ displayAccount?.account.maskedIdentifier??'' }}</text></view><StatusBadge :label="accountStatus" :tone="overview.primaryAccount.value?'success':'neutral'"/></view><view class="account-card__balance"><text class="account-card__amount amount">{{ !overview.primaryAccount.value?'—':balanceVisible?yuan(overview.primaryAccount.value.cashBasis.confirmedCashMinor):'••••' }}</text><button v-if="overview.primaryAccount.value" class="visibility-button" :aria-label="balanceVisible?'隐藏主账户金额':'显示主账户金额'" @tap.stop="toggleBalanceVisibility">{{balanceVisible?'隐藏':'显示'}}</button></view><view class="account-card__foot"><text>{{ accountUpdated }}</text><text>{{displayAccount?'查看依据':'选择账户'}} ›</text></view></SectionCard>

      <view class="setting-list">
        <SettingGroup title="规划设置" icon="规" :open="true">
          <button class="setting-row" @tap="editReserveTarget"><text>保留目标</text><view><text>{{ yuan(overview.currentPeriod.value?.basis.savingsTargetMinor) }}</text><text>›</text></view></button>
          <button class="setting-row" @tap="Taro.navigateTo({url:'/pages/account/select'})"><text>默认规划账户</text><view><text>{{ defaultAccountCopy }}</text><text>›</text></view></button>
          <button class="setting-row" @tap="openAccount"><text>数据更新时间</text><view><text>{{ accountUpdated }}</text><text>›</text></view></button>
        </SettingGroup>
        <SettingGroup title="数据与授权" icon="权" :open="true">
          <button class="setting-row" @tap="Taro.navigateTo({url:'/pages/settings/privacy'})"><text>授权范围</text><view><text>本人账户</text><text>›</text></view></button>
          <button class="setting-row" @tap="Taro.navigateTo({url:'/pages/settings/data-usage'})"><text>数据说明</text><view><text>查看</text><text>›</text></view></button>
          <button class="setting-row" @tap="Taro.navigateTo({url:'/pages/settings/privacy'})"><text>隐私与安全</text><view><text>查看</text><text>›</text></view></button>
        </SettingGroup>
        <SettingGroup title="应用设置" icon="设" :open="true">
          <button class="setting-row" @tap="Taro.navigateTo({url:'/pages/settings/notifications'})"><text>应用内提醒</text><view><text>首页提示偏好</text><text>›</text></view></button>
          <button class="setting-row" @tap="Taro.navigateTo({url:'/pages/settings/about?section=environment'})"><text>演示环境</text><view><text>查看运行状态</text><text>›</text></view></button>
          <button class="setting-row" @tap="Taro.navigateTo({url:'/pages/settings/about'})"><text>关于行止</text><view><text>查看</text><text>›</text></view></button>
        </SettingGroup>
        <SettingGroup title="历史与复盘" icon="史" :open="true">
          <button class="setting-row" @tap="Taro.navigateTo({url:'/pages/orders/index'})"><text>订单与确认</text><view><text>恢复状态</text><text>›</text></view></button>
          <button class="setting-row" @tap="Taro.navigateTo({url:'/subpackage/common/plan-history'})"><text>历史计划</text><view><text>{{ overview.periods.value.length }} 个周期</text><text>›</text></view></button>
          <button class="setting-row" @tap="Taro.navigateTo({url:'/pages/review/list'})"><text>月度复盘</text><view><text>{{overview.periods.value.length?'查看':'暂无周期'}}</text><text>›</text></view></button>
        </SettingGroup>
        <SettingGroup title="账户管理" icon="户" :open="true">
          <button v-if="overview.primaryAccount.value" class="setting-row setting-row--danger" @tap="revokeOpen=true"><text>撤回账户授权</text><view><text>查看影响</text><text>›</text></view></button>
          <button v-else class="setting-row" @tap="Taro.navigateTo({url:'/pages/account/select'})"><text>{{revokedAccount?'查看已撤回账户':'选择规划账户'}}</text><view><text>查看状态</text><text>›</text></view></button>
        </SettingGroup>
      </view>
      <button class="secondary-button logout-button" @tap="logoutOpen=true">退出登录</button>
    </template>
  </PageShell>

  <BottomSheet above-tab-bar :model-value="logoutOpen" title="退出登录" description="退出后将回到登录页，本地会话缓存会被清理。" secondary-text="取消" :primary-text="loggingOut?'正在退出…':'确认退出'" @update:model-value="logoutOpen=$event" @primary="logout"><view v-if="logoutError" class="notice notice--error">{{ logoutError }}</view><view v-else class="confirm-note">账户、计划和账目数据不会因退出登录而删除。</view></BottomSheet>
  <BottomSheet above-tab-bar :model-value="revokeOpen" title="撤回账户授权" description="撤回后，行止将无法继续基于当前账户判断新的资金影响和计划结果。" secondary-text="再想想" primary-text="查看撤回规则" @update:model-value="revokeOpen=$event" @primary="showRevokeRules"><view class="confirm-note confirm-note--warning">既有账户历史和相关业务事实仍会保留。真正撤回前需要在独立页面再次确认，本页不会直接执行。</view></BottomSheet>
</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.retry{margin:24px auto 0}.identity-card{display:flex;align-items:center;gap:20px}.identity-card__copy{flex:1;min-width:0}.identity-card__copy text{display:block;overflow:hidden;font-size:29px;font-weight:700;text-overflow:ellipsis;white-space:nowrap}.identity-card__copy text+text{margin-top:6px;color:$text-secondary;font-size:20px;font-weight:400}.account-card{margin-top:16px}.account-card__title,.account-card__name,.account-card__amount{display:block}.account-card__title{font-size:28px;font-weight:700}.account-card__name{margin-top:8px;color:$text-secondary;font-size:22px}.account-card__balance{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:24px}.account-card__amount{font-size:44px;font-weight:760}.visibility-button{width:auto;flex:0 0 auto;padding:7px 12px;color:$text-secondary;background:$soft-surface;border-radius:999px;font-size:19px}.account-card__foot{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:8px;color:$text-tertiary;font-size:20px}.account-card__foot text:last-child{color:$brand-primary;font-weight:600}.setting-list{margin-top:16px}.setting-row{display:flex;width:100%;min-height:78px;align-items:center;justify-content:space-between;gap:20px;padding:18px 2px;text-align:left}.setting-row+.setting-row{border-top:1px solid $border}.setting-row>text{font-size:24px;font-weight:600}.setting-row view{display:flex;align-items:center;justify-content:flex-end;gap:10px;min-width:0}.setting-row view text:first-child{overflow:hidden;max-width:280px;color:$text-secondary;font-size:21px;text-overflow:ellipsis;white-space:nowrap}.setting-row view text:last-child{color:$text-tertiary;font-size:29px}.setting-row--danger>text{color:$danger}.setting-row--danger view text:first-child{color:$danger}.logout-button{width:100%;margin-top:20px;color:$danger}.confirm-note{padding:20px 22px;color:$text-secondary;background:$soft-surface;border-radius:16px;font-size:22px;line-height:1.6}.confirm-note--warning{color:#785528;background:$warning-surface}
@media screen and (max-width:360px){.identity-card{align-items:flex-start;gap:14px}.identity-card__copy text{white-space:normal}.account-card__amount{font-size:38px}.account-card__foot{align-items:flex-start}.setting-row{gap:14px}.setting-row>text{flex:0 0 auto}.setting-row view{flex:1}.setting-row view text:first-child{max-width:100%;white-space:normal;text-align:right}}
</style>
