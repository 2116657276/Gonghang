<script setup lang="ts">
import Taro from '@tarojs/taro';
import PageShell from '@/components/PageShell.vue';
import SectionCard from '@/components/SectionCard.vue';

const items = [
  { title: '确认资金', tag: '事实', tone: 'fact', detail: '来自账户已确认快照，是规划判断的起点。未知余额不会按 0 元处理。' },
  { title: '已入账流水', tag: '事实', tone: 'fact', detail: '只记录已经发生并被服务端保存的收入或支出，撤销流水会保留原始状态。' },
  { title: '未来义务', tag: '安排', tone: 'prediction', detail: '尚未发生但已知的必要付款，与已入账支出分开展示。' },
  { title: '预计收入', tag: '预期', tone: 'prediction', detail: '用于解释未来安排，但不会提前增加当前可用资金。' },
  { title: '退款待到账', tag: '过程', tone: 'prediction', detail: '退款申请或渠道成功都不等于入账，只有账户事实确认后才增加资金。' },
  { title: '规划草稿', tag: '建议', tone: 'suggestion', detail: 'AI 或用户形成的草稿不会自动修改预算、建立订单或执行付款。' },
];
</script>

<template>
  <PageShell title="数据说明" subtitle="事实、预期和建议分别显示" compact>
    <template #hero><button class="back" @tap="Taro.navigateBack()">‹</button></template>
    <view class="notice notice--info intro">行止判断“现在能不能做”时，只使用服务端已经确认的资金事实；预计收入、待退款和 AI 建议不会被当成已经到账的钱。</view>
    <view class="list"><SectionCard v-for="item in items" :key="item.title" class="data-card" :class="`data-card--${item.tone}`"><view class="heading"><view class="heading-title"><view class="data-icon" aria-hidden="true"><view/></view><text>{{ item.title }}</text></view><text class="source-tag">{{ item.tag }}</text></view><text class="copy">{{ item.detail }}</text></SectionCard></view>
  </PageShell>
</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.back{position:absolute;z-index:4;top:calc(34px + env(safe-area-inset-top));right:28px;width:64px;height:64px;color:$brand-deep;background:rgba(255,255,255,.78);border-radius:50%;font-size:44px}.intro{margin-bottom:24px;font-size:28px;line-height:1.65}.list{display:grid;gap:20px}.data-card{border-left:7px solid transparent}.data-card--fact{background:linear-gradient(145deg,$surface-tint,#fff);border-left-color:$brand-primary}.data-card--prediction{background:linear-gradient(145deg,#EEF7FB,#fff);border-left-color:#5B9CB8}.data-card--suggestion{background:linear-gradient(145deg,$warning-surface,#fff);border-left-color:#D5A655}.heading{display:flex;align-items:center;justify-content:space-between;gap:18px}.heading-title{display:flex;min-width:0;align-items:center;gap:16px}.heading-title>text{font-size:34px;font-weight:730}.source-tag{flex:0 0 auto;padding:7px 14px;color:$brand-primary;background:rgba(255,255,255,.78);border-radius:999px;font-size:24px;font-weight:650}.data-icon{position:relative;flex:0 0 52px;width:52px;height:52px;background:#fff;border-radius:16px}.data-icon::before{position:absolute;left:13px;top:13px;width:26px;height:26px;border:3px solid currentColor;border-radius:50%;color:$brand-primary;content:''}.data-icon view{position:absolute;left:24px;top:20px;width:4px;height:12px;background:$brand-primary;border-radius:3px}.data-card--prediction .data-icon::before{color:#5B9CB8}.data-card--prediction .data-icon view{background:#5B9CB8}.data-card--suggestion .data-icon::before{color:#B98630}.data-card--suggestion .data-icon view{background:#B98630}.copy{display:block;margin-top:18px;color:$text-secondary;font-size:28px;line-height:1.65}
</style>
