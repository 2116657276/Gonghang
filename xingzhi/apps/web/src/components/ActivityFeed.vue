<script setup lang="ts">
import type { EventItem } from '../lib/types';
import { dateTime } from '../lib/api';

defineProps<{ events: EventItem[] }>();
const readable = (type: string) => ({
  'plan.created': '计划已建立', 'purchase_proposal.created': '已生成购买预览', 'purchase.confirmed': '购买范围已确认',
  'order.created': '订单已创建并占用预算', 'plan.paused': '购买入口已暂停',
  'change_proposal.created': '已生成变更预览', 'change.confirmed': '善后与查询授权已确认',
  'change.execution_accepted': '变更任务已受理', 'simulation.payment_confirmed': '模拟付款已核对',
  'simulation.payment_pending': '模拟付款仍待核对', 'simulation.close_confirmed': '模拟关单已核对',
  'simulation.refund_confirmed': '模拟退款已核对', 'aftercare_query.revoked': '受托权限已撤回',
  'query_authorization.renewed': '查询授权已续期',
}[type] ?? type);
</script>

<template>
  <section class="ledger-section activity-section" aria-labelledby="activity-title">
    <div class="section-title"><div><p class="eyebrow">可追溯记录</p><h2 id="activity-title">行迹</h2></div></div>
    <ol v-if="events.length" class="event-list">
      <li v-for="event in events" :key="event.id">
        <span class="event-dot" aria-hidden="true"></span>
        <div><strong>{{ readable(event.type) }}</strong><p>{{ dateTime(event.observedAt) }}</p></div>
      </li>
    </ol>
    <p v-else class="muted">还没有可显示的业务记录。</p>
  </section>
</template>
