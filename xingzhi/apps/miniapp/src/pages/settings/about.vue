<script setup lang="ts">
import { computed, ref } from 'vue';
import Taro, { useLoad } from '@tarojs/taro';
import FactRow from '@/components/FactRow.vue';
import IpAvatar from '@/components/IpAvatar.vue';
import PageShell from '@/components/PageShell.vue';
import SectionCard from '@/components/SectionCard.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { apiBase, isH5Runtime } from '@/lib/runtime-config';
import { api } from '@/lib/api';
import { shortDate } from '@/lib/format';
import type { RuntimeStatus } from '@/lib/types';

const environmentFirst = ref(false);
const runtime = ref<RuntimeStatus | null>(null);
const runtimeError = ref(false);
const runtimeLoading = ref(true);
const apiAddress = computed(() => isH5Runtime ? '当前网页同源' : apiBase());
const paymentLabel = computed(() => !runtime.value ? '暂时无法读取' : runtime.value.payment.mode === 'simulation'
  ? '本地模拟（无需真实付款）' : runtime.value.payment.ready ? '支付宝沙箱已就绪' : `支付宝沙箱缺少 ${runtime.value.payment.missingCount} 项配置`);
const workerLabel = computed(() => runtime.value?.worker.status === 'healthy' ? '运行正常'
  : runtime.value?.worker.status === 'delayed' ? '响应延迟' : '未检测到后台任务');
useLoad(async options => { environmentFirst.value = options.section === 'environment'; try { runtime.value = (await api.runtimeStatus()).data; } catch { runtime.value = null; runtimeError.value = true; } finally { runtimeLoading.value = false; } });
function openEnvironment() { void Taro.redirectTo({ url: '/pages/settings/about?section=environment' }); }
</script>

<template>
  <PageShell :title="environmentFirst?'运行环境':'关于行止'" subtitle="青年生活目标金融助手" compact>
    <template #hero><button class="back" @tap="Taro.navigateBack()">‹</button></template>
    <template v-if="!environmentFirst">
      <SectionCard class="brand"><IpAvatar size="large"/><text class="name">行止</text><text class="slogan">让每一段想去的路，都走得更踏实。</text></SectionCard>
      <SectionCard class="block"><text class="title">产品边界</text><text class="copy">行止帮助你理解账户事实、安排近期计划并在确认后进入订单流程。它不会把预计收入当作余额，不会替你自动购买，也不会把渠道退款成功提前算作到账。</text></SectionCard>
      <SectionCard class="block environment-entry"><view class="entry-heading"><view><text class="title">运行环境</text><text class="entry-copy">查看当前前端、服务、AI 与后台任务状态</text></view><StatusBadge :label="runtimeLoading?'正在读取':runtimeError?'服务不可达':'状态已读取'" :tone="runtimeLoading?'neutral':runtimeError?'warning':'info'"/></view><view class="status-row"><StatusBadge :label="runtime?.ai.ready?'AI 已就绪':'AI 未配置'" :tone="runtime?.ai.ready?'success':'neutral'"/><StatusBadge :label="workerLabel" :tone="runtime?.worker.status==='healthy'?'success':'neutral'"/></view><button class="secondary-button environment-button" @tap="openEnvironment">查看环境详情</button></SectionCard>
    </template>
    <template v-else>
      <SectionCard class="block"><text class="title">前端与服务</text><FactRow label="前端形态" :value="isH5Runtime?'移动网页 H5':'微信小程序'"/><FactRow label="API 地址" :value="apiAddress"/><FactRow label="服务状态" :value="runtimeError?'当前不可访问':'当前可访问'"/><FactRow label="服务版本" :value="runtime?.version??'暂时无法读取'"/><FactRow label="运行环境" :value="runtime?.environment??'未知'"/></SectionCard>
      <SectionCard class="block"><text class="title">能力状态</text><FactRow label="AI 助手" :value="runtime?.ai.ready?'模型已就绪':'模型未配置'"/><FactRow label="后台任务" :value="workerLabel"/><FactRow label="支付模式" :value="paymentLabel"/><FactRow label="支付结果" value="以订单环境和服务端核验为准"/></SectionCard>
      <SectionCard class="block"><text class="title">资金数据</text><FactRow label="数据来源" :value="runtime?.dataSource?.types.includes('bank_api')?'银行接口事实':runtime?.dataSource?.types.includes('demo')?'服务端 Demo 账户事实':'尚无账户数据'"/><FactRow label="最近数据时间" :value="shortDate(runtime?.dataSource?.latestSyncAt)"/></SectionCard>
      <view v-if="runtime?.worker.status!=='healthy'" class="notice notice--warning note">后台任务未处于正常心跳状态，模拟付款、退款等后台流程可能不会继续推进。AI 是否依赖异步处理，以服务端当前实现为准。</view>
    </template>
    <view class="notice notice--warning note">当前环境用于开发和演示，不代表已经接入真实银行账户或正式支付渠道。</view>
  </PageShell>
</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.back{position:absolute;z-index:4;top:calc(34px + env(safe-area-inset-top));right:28px;width:64px;height:64px;color:$brand-deep;background:rgba(255,255,255,.78);border-radius:50%;font-size:44px}.brand{display:flex;flex-direction:column;align-items:center;padding-top:42px;padding-bottom:42px;text-align:center;background:linear-gradient(145deg,$surface-tint,#fff)}.name{margin-top:18px;color:$brand-deep;font-size:44px;font-weight:780}.slogan{margin-top:12px;color:$text-secondary;font-size:28px;line-height:1.55}.block,.note{margin-top:24px}.title{display:block;margin-bottom:20px;font-size:36px;font-weight:740}.copy{display:block;color:$text-secondary;font-size:28px;line-height:1.7}.entry-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.entry-heading .title{margin-bottom:8px}.entry-copy{display:block;color:$text-secondary;font-size:26px;line-height:1.5}.status-row{display:flex;flex-wrap:wrap;gap:12px;margin-top:22px}.environment-button{width:100%;margin-top:24px}.note{font-size:28px;line-height:1.65}
</style>
