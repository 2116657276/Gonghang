<script setup lang="ts">
import type { PaymentHandoff, Plan } from '../lib/types';
import { dateTime, yuan } from '../lib/api';
import StatusPill from './StatusPill.vue';

const props = defineProps<{
  plan: Plan;
  handoffs: Record<string, PaymentHandoff>;
  busy?: boolean;
}>();
const emit = defineEmits<{
  handoff: [orderId: string];
  recheck: [orderId: string];
}>();

const awaiting = (status: string) => ['pending', 'unknown'].includes(status);
</script>

<template>
  <section class="ledger-section payment-progress" aria-labelledby="payment-progress-title">
    <div class="section-title"><div><p class="eyebrow">交易进度</p><h2 id="payment-progress-title">付款与核验</h2></div></div>
    <p class="muted">页面只展示服务端已经保存的订单事实。官方收银台的付款结果必须由服务端查单或通知核验，不能因为打开链接就直接标记成功。</p>
    <div v-if="!plan.orders.length" class="muted payment-empty">订单创建后，付款进度会在这里出现。</div>
    <div v-else class="payment-list">
      <article v-for="order in plan.orders" :key="order.id" class="payment-card">
        <header>
          <div><p>{{ order.environment === 'sandbox' ? '支付宝沙箱' : '本地模拟适配器' }}</p><h3>{{ order.itemName }}</h3></div>
          <StatusPill :value="order.paymentStatus" />
        </header>
        <dl class="payment-facts">
          <div><dt>订单金额</dt><dd>{{ yuan(order.amountMinor) }}</dd></div>
          <div><dt>已退金额</dt><dd>{{ yuan(order.refundedMinor) }}</dd></div>
          <div><dt>渠道</dt><dd>{{ order.provider }}</dd></div>
        </dl>
        <div v-if="order.environment === 'sandbox' && awaiting(order.paymentStatus)" class="payment-actions">
          <p>沙箱付款需要你在官方页面完成账号确认；回到这里后再主动查单。</p>
          <div class="button-row">
            <button class="primary-button" type="button" :disabled="busy" @click="emit('handoff', order.id)">获取沙箱收银台</button>
            <a v-if="props.handoffs[order.id]" class="secondary-button export-link" :href="props.handoffs[order.id].handoffUrl" target="_blank" rel="noreferrer">打开收银台</a>
            <button class="secondary-button" type="button" :disabled="busy" @click="emit('recheck', order.id)">我已付款，主动查单</button>
          </div>
          <small v-if="props.handoffs[order.id]">入口有效至 {{ dateTime(props.handoffs[order.id].expiresAt) }}；打开入口本身不代表付款成功。</small>
        </div>
        <p v-else class="payment-note">{{ order.environment === 'simulation' ? '本地模拟结果由后台执行者核对；这里不会出现官方收银台。' : '当前订单已离开待付款状态，后续以服务端保存的实际核验结果为准。' }}</p>
      </article>
    </div>
  </section>
</template>
