<script setup lang="ts">
import Taro, { useDidShow } from '@tarojs/taro';
import PageShell from '@/components/PageShell.vue';
import SectionCard from '@/components/SectionCard.vue';
import StatePanel from '@/components/StatePanel.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { useOverview } from '@/composables/useOverview';

const overview = useOverview();
useDidShow(() => void overview.load());
function revoke(id: string) { void Taro.navigateTo({ url: `/pages/account/revoke-confirm?id=${id}` }); }
</script>

<template>
  <PageShell title="授权与隐私" subtitle="看清行止可以使用哪些数据" compact>
    <template #hero><button class="back" @tap="Taro.navigateBack()">‹</button></template>
    <StatePanel v-if="overview.loading.value" title="正在读取授权范围" />
    <StatePanel v-else-if="overview.error.value" title="授权信息暂时不可用" :detail="overview.error.value" tone="error"><button class="secondary-button retry" @tap="overview.load">重新加载</button></StatePanel>
    <template v-else>
      <SectionCard><text class="title">当前授权范围</text><text class="copy">行止只读取当前登录消费者名下、由服务端明确授权的账户事实，不会因为前端切换页面读取其他用户或其他账户的数据。</text><view class="scopes"><text>账户余额与快照</text><text>已入账流水与分类</text><text>未来义务与退款状态</text><text>预算周期、计划和订单</text></view></SectionCard>
      <SectionCard class="block"><text class="title">账户授权状态</text><view v-for="value in overview.accounts.value" :key="value.account.accountId" class="account"><view><text>{{ value.account.displayName }} {{ value.account.maskedIdentifier }}</text><text>{{ value.account.source }} · 版本 {{ value.account.financialVersion }}</text></view><StatusBadge :label="value.account.status==='linked'?'已授权':'已撤回'" :tone="value.account.status==='linked'?'success':'neutral'"/><button v-if="value.account.status==='linked'" class="link-button" @tap="revoke(value.account.accountId)">查看撤回影响 ›</button></view><StatePanel v-if="!overview.accounts.value.length" title="当前没有账户授权" /></SectionCard>
      <SectionCard class="block"><text class="title">安全边界</text><text class="copy">计划草稿不会自动购买；建立订单不代表已经支付；渠道显示退款成功也不代表资金已经到账。涉及授权、购买、付款和调整时，行止都会再次确认。</text></SectionCard>
    </template>
  </PageShell>
</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.back{position:absolute;z-index:4;top:calc(34px + env(safe-area-inset-top));right:28px;width:64px;height:64px;color:$brand-deep;background:rgba(255,255,255,.7);border-radius:50%;font-size:44px}.retry{margin-top:18px}.block{margin-top:16px}.title{display:block;font-size:28px;font-weight:720}.copy{display:block;margin-top:12px;color:$text-secondary;font-size:22px;line-height:1.7}.scopes{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:18px}.scopes text{padding:14px;color:$brand-deep;background:$surface-tint;border-radius:14px;font-size:20px;text-align:center}.account{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:8px 14px;margin-top:18px;padding-top:18px;border-top:1px solid $border}.account view text{display:block;font-size:23px;font-weight:650}.account view text+text{margin-top:6px;color:$text-secondary;font-size:19px;font-weight:400}.account .link-button{grid-column:1/-1;justify-self:end}@media screen and (max-width:360px){.scopes{grid-template-columns:1fr}}
</style>
