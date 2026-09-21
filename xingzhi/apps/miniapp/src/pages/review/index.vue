<script setup lang="ts">
import { ref } from 'vue';
import Taro, { useLoad } from '@tarojs/taro';
import FactRow from '@/components/FactRow.vue';
import PageShell from '@/components/PageShell.vue';
import SectionCard from '@/components/SectionCard.vue';
import StatePanel from '@/components/StatePanel.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { shortDate, yuan } from '@/lib/format';
import type { PeriodReview } from '@/lib/types';

type PeriodEvent = { id: string; type: string; data: Record<string, unknown>; observedAt: string };
const review = ref<PeriodReview | null>(null);
const events = ref<PeriodEvent[]>([]);
const error = ref('');
const eventLabel = (type: string) => ({ budget_period_created: '预算周期已创建', budget_period_activated: '预算周期已激活',
  budget_period_closed: '预算周期已归档', budget_item_created: '新增计划项目', budget_item_updated: '计划项目已修改',
  budget_item_cancelled: '计划项目已取消', savings_target_changed: '保留目标已调整', purchase_intent_proposed: '生成购买确认',
  order_aftercare_accepted: '订单善后已确认', payment_handoff_requested: '已发起付款交接',
  budget_adjustment_confirmed: '意外支出调整已确认', finance_account_revoked: '账户授权已撤回',
  finance_demo_account_reauthorized: 'Demo 账户已重新授权' }[type] ?? type.replaceAll('_', ' '));
const issueLabel = (issue: string) => ({ TARGET_AUDIT_MISMATCH: '保留目标变更记录需要核对', PROVIDER_RESULT_UNKNOWN: '渠道结果仍未明确',
  REFUND_CHANNEL_RESULT_UNKNOWN: '退款渠道结果仍待核验', ORDER_PAYMENT_NOT_FINAL: '仍有订单付款未结束',
  REFUND_NOT_ACCOUNT_POSTED: '退款尚未核验到账', CURRENT_CASH_BASIS_UNKNOWN: '当前账户资金依据不完整',
  CLOSING_SNAPSHOT_MISSING: '缺少月末时点的账户快照' }[issue] ?? issue);
function relatedUrl(event: PeriodEvent) {
  const orderId = typeof event.data.orderId === 'string' ? event.data.orderId : null;
  const itemId = typeof event.data.itemId === 'string' ? event.data.itemId : typeof event.data.budgetItemId === 'string' ? event.data.budgetItemId : null;
  const adjustmentId = typeof event.data.adjustmentId === 'string' ? event.data.adjustmentId : null;
  if (orderId) return `/pages/order/detail?id=${orderId}`;
  if (adjustmentId) return `/pages/adjustment/detail?id=${adjustmentId}`;
  if (itemId && review.value) return `/pages/item/detail?periodId=${review.value.periodId}&itemId=${itemId}`;
  return null;
}
function openEvent(event: PeriodEvent) { const url = relatedUrl(event); if (url) void Taro.navigateTo({ url }); }
useLoad(async options => {
  try {
    const [reviewResult, eventResult] = await Promise.all([api.periodReview(options.periodId ?? ''), api.periodEvents(options.periodId ?? '')]);
    review.value = reviewResult.data; events.value = eventResult.data.events;
  } catch (reason) { error.value = errorMessage(reason); }
});
</script>

<template>
  <PageShell title="月度复盘" subtitle="计划、订单和到账证据按事实回看" compact>
    <template #hero><button class="back" @tap="Taro.navigateBack()">‹</button></template>
    <StatePanel v-if="!review&&!error" title="正在生成复盘"/>
    <StatePanel v-else-if="error" title="复盘暂时不可用" :detail="error" tone="error"/>
    <template v-else-if="review">
      <SectionCard><view class="row-between"><text class="title">本周期概览</text><StatusBadge :label="review.reviewStatus==='complete'?'已完成':review.reviewStatus==='provisional'?'阶段性':'依据不足'" :tone="review.reviewStatus==='complete'?'success':'info'"/></view><FactRow label="当前保留目标" :value="yuan(review.currentSavingsTargetMinor)"/><FactRow label="已确认支出" :value="yuan(review.confirmedPeriodOutflowMinor)"/><FactRow label="已确认收入" :value="yuan(review.confirmedPeriodInflowMinor)"/><FactRow label="订单付款" :value="yuan(review.confirmedOrderPaymentsMinor)"/><FactRow label="退款已到账" :value="yuan(review.confirmedRefundReceivedMinor)"/><FactRow label="退款待到账" :value="yuan(review.refundAwaitingArrivalMinor)"/></SectionCard>
      <SectionCard v-if="review.unknownIssues.length" class="block"><text class="title">仍需核对</text><text v-for="issue in review.unknownIssues" :key="issue" class="issue">{{issueLabel(issue)}}</text></SectionCard>
      <view class="timeline"><text class="title">周期事件</text><button v-for="event in events" :key="event.id" class="event" :disabled="!relatedUrl(event)" @tap="openEvent(event)"><view class="dot"/><view><text>{{eventLabel(event.type)}}</text><text>{{shortDate(event.observedAt)}}{{relatedUrl(event)?' · 查看详情 ›':''}}</text></view></button><StatePanel v-if="!events.length" title="暂无周期事件"/></view>
    </template>
  </PageShell>
</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.back{position:absolute;right:28px;top:calc(34px + env(safe-area-inset-top));width:64px;height:64px;border-radius:50%;font-size:42px}.title{font-size:27px;font-weight:720}.block,.timeline{margin-top:18px}.issue{position:relative;display:block;margin-top:10px;padding-left:22px;color:$text-secondary;font-size:20px;line-height:1.5}.issue::before{position:absolute;left:2px;content:'•';color:$warning}.event{display:flex;width:100%;gap:14px;padding:18px 4px;text-align:left;border-bottom:1px solid $border}.dot{flex:0 0 12px;width:12px;height:12px;margin-top:8px;background:$brand-primary;border-radius:50%}.event>view:last-child{min-width:0;flex:1}.event text{display:block;font-size:22px}.event text+text{margin-top:5px;color:$text-tertiary;font-size:19px}.event:disabled{opacity:1}
</style>
