<script setup lang="ts">
import { computed, ref } from 'vue';
import Taro, { useDidShow, useLoad } from '@tarojs/taro';
import FactRow from '@/components/FactRow.vue';
import PageShell from '@/components/PageShell.vue';
import SectionCard from '@/components/SectionCard.vue';
import StatePanel from '@/components/StatePanel.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { shortDate, yuan } from '@/lib/format';
import type { OrderAftercare } from '@/lib/types';

const orderId = ref('');
const value = ref<OrderAftercare | null>(null);
const loading = ref(true);
const checking = ref(false);
const error = ref('');
const latestCancellation = computed(() => value.value?.cancellations[0] ?? null);
const canRecheck = computed(() => value.value?.batches.some(batch => batch.environment === 'sandbox' && batch.status !== 'succeeded') ?? false);
const statusLabel = (status: string) => ({ proposed: '待确认', accepted: '已确认', expired: '已过期',
  approved: '已批准', rejected: '未通过', delayed: '待人工复核', refund_processing: '退款处理中',
  completed: '已完成', pending: '等待渠道', processing: '渠道处理中', succeeded: '渠道已成功',
  unknown: '结果待核验', pending_review: '待人工复核', failed: '处理失败' }[status] ?? status);
async function load() {
  loading.value = true; error.value = '';
  try { value.value = (await api.orderAftercare(orderId.value)).data; }
  catch (reason) { error.value = errorMessage(reason); }
  finally { loading.value = false; }
}
async function recheck() {
  if (checking.value) return;
  checking.value = true; error.value = '';
  try {
    const result = (await api.refundRecheck(orderId.value)).data;
    if (result.operationId) await Taro.navigateTo({ url: `/pages/operation/detail?id=${result.operationId}&orderId=${orderId.value}` });
    else await load();
  } catch (reason) { error.value = errorMessage(reason); }
  finally { checking.value = false; }
}
useLoad(options => { orderId.value = options.orderId ?? ''; });
useDidShow(() => { if (orderId.value) void load(); });
</script>

<template>
  <PageShell title="退款与善后" subtitle="申请、渠道处理和到账分别核对" compact>
    <template #hero><button class="back" @tap="Taro.navigateBack()">‹</button></template>
    <StatePanel v-if="loading" title="正在读取退款事实" />
    <StatePanel v-else-if="error||!value" title="退款详情暂时不可用" :detail="error" tone="error"><button class="secondary-button retry" @tap="load">重新加载</button></StatePanel>
    <template v-else>
      <SectionCard><view class="row-between"><text class="title">退款概览</text><StatusBadge :label="latestCancellation?statusLabel(latestCancellation.status):'尚未申请'" :tone="value.order.refundedMinor>0?'success':'info'"/></view><FactRow label="订单金额" :value="yuan(value.order.amountMinor)"/><FactRow label="预计退款" :value="yuan(latestCancellation?.refundMinor??0)"/><FactRow label="已核验到账" :value="yuan(value.order.refundedMinor)" emphasis/></SectionCard>
      <SectionCard v-if="latestCancellation" class="block"><text class="title">申请与处理</text><FactRow label="申请状态" :value="statusLabel(latestCancellation.status)"/><FactRow label="规则费用" :value="yuan(latestCancellation.feeMinor)"/><FactRow label="处理说明" :value="latestCancellation.decisionReason??'按订单规则处理中'"/><FactRow label="更新时间" :value="shortDate(latestCancellation.updatedAt)"/></SectionCard>
      <SectionCard v-if="value.batches.length" class="block"><text class="title">渠道退款批次</text><button v-for="batch in value.batches" :key="batch.batchId" class="batch" :disabled="!batch.operationId" @tap="batch.operationId&&Taro.navigateTo({url:`/pages/operation/detail?id=${batch.operationId}&orderId=${orderId}`})"><view><text>第 {{batch.batchNumber}} 笔 · {{yuan(batch.amountMinor)}}</text><text>{{batch.provider==='alipay'?'支付宝沙箱':'本地模拟'}} · {{shortDate(batch.updatedAt)}}</text></view><StatusBadge :label="statusLabel(batch.status)" :tone="batch.status==='succeeded'?'success':batch.status==='failed'?'danger':'info'"/></button></SectionCard>
      <button v-if="canRecheck" class="secondary-button recheck" :loading="checking" :disabled="checking" @tap="recheck">{{checking?'正在提交复核…':'主动复核支付宝退款结果'}}</button>
      <SectionCard class="block"><text class="title">账户到账核验</text><view v-if="value.moneyEvents.length" class="timeline"><view v-for="event in value.moneyEvents" :key="event.eventId" class="event"><view><text>{{event.eventType==='refund_requested'?'退款已申请':event.eventType==='refund_verified'?'渠道结果已核验':'退款已到账'}}</text><text>{{shortDate(event.occurredAt)}} · {{yuan(event.amountMinor)}}</text></view><StatusBadge :label="event.eventType==='refund_posted'?'已计入现金':event.verificationState==='verified'?'已核验':'待核验'" :tone="event.eventType==='refund_posted'?'success':'info'"/></view></view><StatePanel v-else title="尚无退款资金事件" detail="提交取消退款后，申请、渠道核验和实际到账会依次显示在这里。"/></SectionCard>
      <view class="notice notice--info note">渠道退款成功不等于账户已经到账；只有“退款已到账”事件才会增加确认可用资金。</view>
    </template>
  </PageShell>
</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.back{position:absolute;right:28px;top:calc(34px + env(safe-area-inset-top));width:64px;height:64px;border-radius:50%;font-size:42px}.retry{margin-top:18px}.title{font-size:27px;font-weight:720}.block,.note,.recheck{margin-top:18px}.recheck{width:100%}.batch,.event{display:flex;width:100%;align-items:center;justify-content:space-between;gap:18px;padding:18px 0;text-align:left}.batch+.batch,.event+.event{border-top:1px solid $border}.batch>view:first-child,.event>view:first-child{min-width:0;flex:1}.batch text,.event text{display:block;font-size:22px}.batch text+text,.event text+text{margin-top:6px;color:$text-secondary;font-size:19px}
</style>
