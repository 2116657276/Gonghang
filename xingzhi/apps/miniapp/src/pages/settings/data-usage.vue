<script setup lang="ts">
import Taro from '@tarojs/taro';
import PageShell from '@/components/PageShell.vue';
import SectionCard from '@/components/SectionCard.vue';

const items = [
  { title: '确认资金', tag: '事实', detail: '来自账户已确认快照，是规划判断的起点。未知余额不会按 0 元处理。' },
  { title: '已入账流水', tag: '事实', detail: '只记录已经发生并被服务端保存的收入或支出，撤销流水会保留原始状态。' },
  { title: '未来义务', tag: '安排', detail: '尚未发生但已知的必要付款，与已入账支出分开展示。' },
  { title: '预计收入', tag: '预期', detail: '用于解释未来安排，但不会提前增加当前可用资金。' },
  { title: '退款待到账', tag: '过程', detail: '退款申请或渠道成功都不等于入账，只有账户事实确认后才增加资金。' },
  { title: '规划草稿', tag: '建议', detail: 'AI 或用户形成的草稿不会自动修改预算、建立订单或执行付款。' },
];
</script>

<template>
  <PageShell title="数据说明" subtitle="事实、预期和建议分别显示" compact>
    <template #hero><button class="back" @tap="Taro.navigateBack()">‹</button></template>
    <view class="notice notice--info intro">行止判断“现在能不能做”时，只使用服务端已经确认的资金事实；预计收入、待退款和 AI 建议不会被当成已经到账的钱。</view>
    <view class="list"><SectionCard v-for="item in items" :key="item.title"><view class="heading"><text>{{ item.title }}</text><text>{{ item.tag }}</text></view><text class="copy">{{ item.detail }}</text></SectionCard></view>
  </PageShell>
</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.back{position:absolute;z-index:4;top:calc(34px + env(safe-area-inset-top));right:28px;width:64px;height:64px;color:$brand-deep;background:rgba(255,255,255,.7);border-radius:50%;font-size:44px}.intro{margin-bottom:16px}.list{display:grid;gap:14px}.heading{display:flex;align-items:center;justify-content:space-between;gap:16px}.heading text:first-child{font-size:27px;font-weight:710}.heading text:last-child{padding:5px 12px;color:$brand-primary;background:$surface-tint;border-radius:999px;font-size:18px}.copy{display:block;margin-top:12px;color:$text-secondary;font-size:22px;line-height:1.65}
</style>
