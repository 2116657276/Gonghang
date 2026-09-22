<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import Taro, { useDidShow } from '@tarojs/taro';
import BottomSheet from '@/components/BottomSheet.vue';
import FactRow from '@/components/FactRow.vue';
import IpAvatar from '@/components/IpAvatar.vue';
import PageShell from '@/components/PageShell.vue';
import StatePanel from '@/components/StatePanel.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { useOverview } from '@/composables/useOverview';
import { api, ApiError, goLogin } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { fundingLabel, shortDate, yuan } from '@/lib/format';
import type { AgentRun } from '@/lib/types';

type Message = { id: string; role: 'user' | 'assistant'; text: string; at: string; run?: AgentRun };

const overview = useOverview();
const input = ref('');
const sending = ref(false);
const error = ref('');
const messages = ref<Message[]>([]);
const contextOpen = ref(false);
const selectedPeriodId = ref<string | null>(null);
const pendingPeriodId = ref<string | null>(null);
let contextInitialized = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let alive = true;

const selectedPeriod = computed(() => overview.periods.value.find(item => item.period.periodId === selectedPeriodId.value) ?? null);
const contextLabel = computed(() => selectedPeriod.value ? `${selectedPeriod.value.period.monthStart.slice(0,7).replace('-','年')}月计划` : '不带具体计划');
const contextDetail = computed(() => selectedPeriod.value
  ? `${overview.primaryAccount.value?.account.displayName ?? '未选择账户'} · ${fundingLabel(selectedPeriod.value.forecast.status)}`
  : '只讨论你的问题，不绑定具体预算周期');
const shortcuts = ['我最近还能怎么安排？', '帮我做一个周末计划', '为什么资金判断是未知？', '哪些计划需要调整？'];

useDidShow(async () => {
  await overview.load();
  if (!contextInitialized) {
    selectedPeriodId.value = overview.currentPeriod.value?.period.periodId ?? null;
    pendingPeriodId.value = selectedPeriodId.value;
    contextInitialized = true;
  }
});
onBeforeUnmount(() => { alive = false; if (timer) clearTimeout(timer); });

function schedule(runId: string) { if (timer) clearTimeout(timer); timer = setTimeout(() => void poll(runId), 1500); }
async function poll(runId: string) {
  if (!alive) return;
  try {
    const result = (await api.agentRun(runId)).data;
    const message = messages.value.find(item => item.id === runId);
    if (message) { message.run = result; message.text = result.output || stateText(result.state, result.errorCode); }
    if (result.state === 'RUNNING') schedule(runId); else sending.value = false;
  } catch (reason) { sending.value = false; error.value = errorMessage(reason); }
}
function stateText(state: string, errorCode: string | null) {
  if (state === 'RUNNING') return '我正在核对计划与资金事实…';
  if (state === 'CANCELLED') return '本次整理已停止。';
  if (state === 'FAILED') return errorCode === 'RUN_EXPIRED' ? '本次整理已超时，可以重新提问。' : '这次没有整理完成，结构化功能仍可继续使用。';
  return '本次整理已经完成。';
}
function nowLabel() { return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()); }
async function send(value?: string) {
  const text = (value ?? input.value).trim();
  if (!text || sending.value) return;
  error.value = ''; sending.value = true; input.value = '';
  messages.value.push({ id: `user-${Date.now()}`, role: 'user', text, at: nowLabel() });
  try {
    const result = (await api.startAgent(text, selectedPeriodId.value)).data;
    messages.value.push({ id: result.runId, role: 'assistant', text: '我正在核对计划与资金事实…', at: nowLabel() });
    await poll(result.runId);
  } catch (reason) {
    sending.value = false;
    if (reason instanceof ApiError && reason.status === 401) return goLogin();
    error.value = errorMessage(reason);
  }
}
function openContext() { pendingPeriodId.value = selectedPeriodId.value; contextOpen.value = true; }
function confirmContext() { selectedPeriodId.value = pendingPeriodId.value; contextOpen.value = false; }
</script>

<template>
  <PageShell title="行止 AI" subtitle="你的规划伙伴，先解释，再进入确认">
    <template #hero><button class="history-button" aria-label="查看 AI 历史" @tap="Taro.navigateTo({url:'/pages/ai/history'})">◷</button></template>
    <view class="context-card" @tap="openContext">
      <view><text class="context-card__label">当前上下文</text><text class="context-card__value">{{ contextLabel }}</text><text class="context-card__detail">{{ contextDetail }}</text></view><text class="context-card__arrow">›</text>
    </view>
    <view class="welcome"><IpAvatar size="large"/><view class="welcome__bubble">今天想让我帮你看看什么？</view></view>
    <scroll-view class="shortcut-scroll" scroll-x><button v-for="item in shortcuts" :key="item" class="shortcut" :disabled="sending" @tap="send(item)">{{ item }}</button></scroll-view>
    <view v-if="messages.length" class="message-list">
      <view v-for="message in messages" :key="message.id" class="message" :class="`message--${message.role}`">
        <IpAvatar v-if="message.role==='assistant'" size="small"/>
        <view class="message__content"><view class="message__bubble"><text>{{ message.text }}</text></view><text class="message__time">{{ message.at }}</text>
          <view v-for="artifact in message.run?.artifacts??[]" :key="artifact.draftId" class="result-card" @tap="Taro.navigateTo({url:`/pages/draft/detail?id=${artifact.draftId}`})"><view class="row-between"><text class="result-card__title">计划草稿</text><StatusBadge label="等待你确认" tone="info"/></view><text class="result-card__detail">行止已整理出结构化草稿。它不会自动改变账户、预算或执行购买。</text><button class="link-button">查看并继续完善 ›</button></view>
        </view>
      </view>
    </view>
    <StatePanel v-else-if="!overview.loading.value" title="从一个具体问题开始" detail="行止可以读、算、解释和生成草稿，不会替你购买、支付或退款。" />
    <view v-if="error" class="notice notice--error ai-error">{{ error }}</view>
    <view class="composer"><button class="composer__add" aria-label="选择计划上下文" :disabled="sending" @tap="openContext">＋</button><textarea v-model="input" :disabled="sending" :maxlength="4000" auto-height placeholder="问问行止……"/><button class="send-button" :disabled="sending||!input.trim()" @tap="send()">{{ sending?'…':'↑' }}</button></view>
  </PageShell>

  <BottomSheet above-tab-bar :model-value="contextOpen" title="选择对话上下文" description="切换只影响后续提问，不会修改任何计划。" primary-text="使用这个上下文" @update:model-value="contextOpen=$event" @primary="confirmContext">
    <view class="context-options">
      <button v-for="period in overview.periods.value" :key="period.period.periodId" class="context-option" :class="{'context-option--selected':pendingPeriodId===period.period.periodId}" @tap="pendingPeriodId=period.period.periodId"><view><text>{{ period.period.monthStart.slice(0,7).replace('-','年') }}月计划</text><text>{{ fundingLabel(period.forecast.status) }} · 最低 {{ yuan(period.basis.minimumProjectedCashMinor) }}</text></view><text>{{ pendingPeriodId===period.period.periodId?'✓':'○' }}</text></button>
      <button class="context-option" :class="{'context-option--selected':pendingPeriodId===null}" @tap="pendingPeriodId=null"><view><text>不带具体上下文</text><text>只讨论当前问题，不绑定预算周期</text></view><text>{{ pendingPeriodId===null?'✓':'○' }}</text></button>
    </view>
  </BottomSheet>

</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.history-button{position:absolute;z-index:4;top:calc(40px + env(safe-area-inset-top));right:30px;display:flex;width:66px;height:66px;align-items:center;justify-content:center;padding:0;color:$brand-deep;background:rgba(255,255,255,.66);border:1px solid rgba(255,255,255,.86);border-radius:50%;font-size:32px;line-height:1;box-shadow:$shadow-card}.context-card{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:24px 26px;background:rgba(255,255,255,.78);border:1px solid rgba(255,255,255,.86);border-radius:20px;box-shadow:$shadow-card}.context-card text{display:block}.context-card__label{color:$text-secondary;font-size:20px}.context-card__value{margin-top:6px;font-size:26px;font-weight:680}.context-card__detail{margin-top:7px;color:$text-tertiary;font-size:20px}.context-card__arrow{color:$brand-primary;font-size:38px}
.welcome{display:flex;flex-direction:column;align-items:center;margin:34px 0 20px}.welcome__bubble{margin-top:-5px;padding:17px 24px;background:#fff;border:1px solid $border;border-radius:22px;font-size:24px;box-shadow:$shadow-card}.shortcut-scroll{margin-bottom:24px;white-space:nowrap;scrollbar-width:none}.shortcut-scroll::-webkit-scrollbar{display:none}.shortcut{display:inline-flex;width:auto;align-items:center;justify-content:center;margin-right:12px;padding:17px 24px;color:$brand-deep;background:$surface-tint;border-radius:999px;font-size:22px;line-height:1.2;white-space:nowrap}
.message-list{display:grid;gap:18px;margin:22px 0}.message{display:flex;align-items:flex-start;gap:12px}.message--user{justify-content:flex-end}.message__content{max-width:78%}.message__bubble{padding:19px 22px;background:#fff;border:1px solid $border;border-radius:8px 20px 20px 20px;box-shadow:0 8px 25px rgba(31,66,54,.05)}.message--user .message__bubble{color:$brand-deep;background:$surface-tint;border-color:#D5E5DC;border-radius:20px 8px 20px 20px}.message__bubble text{font-size:24px;line-height:1.65;white-space:pre-wrap}.message__time{display:block;margin:6px 8px 0;color:$text-tertiary;font-size:18px}.message--user .message__time{text-align:right}.result-card{margin-top:10px;padding:20px;background:#fff;border:1px solid #CFE0D7;border-radius:18px;box-shadow:$shadow-card}.result-card__title{font-size:25px;font-weight:680}.result-card__detail{display:block;margin:14px 0;color:$text-secondary;font-size:21px;line-height:1.6}
.ai-error{margin:18px 0}.composer{position:sticky;bottom:calc(104px + env(safe-area-inset-bottom));z-index:10;display:flex;align-items:flex-end;gap:12px;margin-top:24px;padding:12px;background:rgba(255,255,255,.97);border:1px solid $border;border-radius:24px;box-shadow:0 12px 40px rgba(31,66,54,.14)}.composer textarea{flex:1;min-width:0;min-height:56px;max-height:180px;padding:8px 0;color:$text-primary;font-size:25px;line-height:1.55}.composer__add,.send-button{display:flex;flex:0 0 62px;width:62px;height:62px;align-items:center;justify-content:center;padding:0;border-radius:50%;font-size:30px;line-height:1}.composer__add{color:$brand-primary;background:$surface-tint}.composer__add[disabled]{color:$text-tertiary;opacity:.65}.send-button{color:#fff;background:$brand-primary}.send-button[disabled]{opacity:.45}
.context-options{overflow:hidden;border:1px solid $border;border-radius:18px}.context-option{display:flex;width:100%;align-items:center;justify-content:space-between;gap:20px;padding:20px;text-align:left}.context-option+.context-option{border-top:1px solid $border}.context-option text{display:block}.context-option view text:first-child{font-size:24px;font-weight:650}.context-option view text+text{margin-top:6px;color:$text-secondary;font-size:20px}.context-option>text{color:$text-tertiary;font-size:28px}.context-option--selected{background:$surface-tint}.context-option--selected>text{color:$brand-primary}
</style>
