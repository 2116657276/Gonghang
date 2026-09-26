<script setup lang="ts">
import Taro, { useDidShow } from '@tarojs/taro';
import PageShell from '@/components/PageShell.vue';
import SectionCard from '@/components/SectionCard.vue';
import StatePanel from '@/components/StatePanel.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { useOverview } from '@/composables/useOverview';

const overview = useOverview();
const scopes = [
  { key: 'balance', title: '账户余额与快照' },
  { key: 'ledger', title: '已入账流水与分类' },
  { key: 'future', title: '未来义务与退款状态' },
  { key: 'plan', title: '预算周期、计划和订单' },
];
useDidShow(() => void overview.load());
function revoke(id: string) { void Taro.navigateTo({ url: `/pages/account/revoke-confirm?id=${id}` }); }
</script>

<template>
  <PageShell title="授权与隐私" subtitle="看清行止可以使用哪些数据" compact>
    <template #hero><button class="back" @tap="Taro.navigateBack()">‹</button></template>
    <StatePanel v-if="overview.loading.value" title="正在读取授权范围" />
    <StatePanel v-else-if="overview.error.value" title="授权信息暂时不可用" :detail="overview.error.value" tone="error"><button class="secondary-button retry" @tap="overview.load">重新加载</button></StatePanel>
    <template v-else>
      <SectionCard><text class="title">当前授权范围</text><text class="copy">行止只读取当前登录消费者名下、由服务端明确授权的账户事实，不会因为前端切换页面读取其他用户或其他账户的数据。</text><view class="scopes"><view v-for="scope in scopes" :key="scope.key" class="scope"><view class="scope-icon" :class="`scope-icon--${scope.key}`" aria-hidden="true"><view/></view><text>{{scope.title}}</text></view></view></SectionCard>
      <SectionCard class="block"><text class="title">账户授权状态</text><view v-for="value in overview.accounts.value" :key="value.account.accountId" class="account"><view class="account-copy"><text>{{ value.account.displayName }} {{ value.account.maskedIdentifier }}</text><text>{{ value.account.source==='demo'?'Demo 数据':value.account.source==='bank_api'?'银行接口事实':value.account.source }} · 版本 {{ value.account.financialVersion }}</text></view><StatusBadge :label="value.account.status==='linked'?'已授权':'已撤回'" :tone="value.account.status==='linked'?'success':'neutral'"/><button v-if="value.account.status==='linked'" class="secondary-button revoke-link" @tap="revoke(value.account.accountId)">查看撤回影响</button></view><StatePanel v-if="!overview.accounts.value.length" title="当前没有账户授权" /></SectionCard>
      <SectionCard class="block"><text class="title">安全边界</text><text class="copy">计划草稿不会自动购买；建立订单不代表已经支付；渠道显示退款成功也不代表资金已经到账。涉及授权、购买、付款和调整时，行止都会再次确认。</text></SectionCard>
    </template>
  </PageShell>
</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.back{position:absolute;z-index:4;top:calc(34px + env(safe-area-inset-top));right:28px;width:64px;height:64px;color:$brand-deep;background:rgba(255,255,255,.78);border-radius:50%;font-size:44px}.retry{margin-top:24px}.block{margin-top:24px}.title{display:block;font-size:36px;font-weight:740}.copy{display:block;margin-top:16px;color:$text-secondary;font-size:28px;line-height:1.7}.scopes{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:24px}.scope{display:flex;min-height:112px;align-items:center;gap:14px;padding:18px;color:$brand-deep;background:$surface-tint;border-radius:22px}.scope>text{font-size:27px;font-weight:650;line-height:1.4}.scope-icon{position:relative;flex:0 0 48px;width:48px;height:48px;background:#fff;border-radius:15px}.scope-icon::before,.scope-icon::after,.scope-icon view{position:absolute;content:''}.scope-icon::before{left:12px;top:12px;width:24px;height:20px;border:3px solid $brand-primary;border-radius:6px}.scope-icon::after{left:19px;top:8px;width:10px;height:7px;background:$brand-primary;border-radius:5px}.scope-icon--ledger view{left:14px;top:23px;width:20px;border-top:3px solid $brand-primary}.scope-icon--future::before{border-radius:50%}.scope-icon--future::after{left:23px;top:15px;width:3px;height:12px}.scope-icon--plan::before{height:24px}.scope-icon--plan view{left:17px;top:22px;width:14px;border-top:3px solid $brand-primary}.account{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:16px 18px;margin-top:24px;padding-top:24px;border-top:1px solid $border}.account-copy text{display:block;font-size:30px;font-weight:680;line-height:1.45}.account-copy text+text{margin-top:8px;color:$text-secondary;font-size:25px;font-weight:400}.revoke-link{grid-column:1/-1;width:100%;color:$danger}.account:first-of-type{margin-top:18px}@media screen and (max-width:360px){.scopes{grid-template-columns:1fr}.scope{min-height:96px}}
</style>
