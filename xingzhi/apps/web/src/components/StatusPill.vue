<script setup lang="ts">
defineProps<{ value: string }>();

const label = (value: string) => ({
  not_ordered: '未下单',
  pending: '等待付款', paid: '已付款', unknown: '待核对', closed: '已关单', failed: '明确失败',
  created: '已建单', fulfilling: '履约中', cancelled: '已取消', cancellation_processing: '取消处理中',
  pending_review: '待处理', succeeded: '已完成', accepted: '已受理', processing: '处理中',
  active: '有效', paused: '已暂停', stopped: '已停止', kept: '保留', completed: '已完成',
  approved: '已批准', rejected: '已拒绝', delayed: '延迟复核', refund_processing: '退款处理中',
  open: '待领取', claimed: '已领取', resolved: '已关闭', revoked: '已撤回', expired: '已到期',
}[value] ?? value);
</script>

<template><span class="status-pill" :class="`status-${value}`">{{ label(value) }}</span></template>
