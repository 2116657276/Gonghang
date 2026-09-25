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
import { takeAiQuestion } from '@/lib/ai-entry';
import { api, ApiError, goLogin } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { fundingLabel, shortDate, yuan } from '@/lib/format';
import type { AgentRun, PlanningDraft } from '@/lib/types';

type Message = { id: string; role: 'user' | 'assistant'; text: string; at: string; run?: AgentRun };

const overview = useOverview();
const input = ref('');
const sending = ref(false);
const error = ref('');
const messages = ref<Message[]>([]);
const drafts = ref<Record<string, PlanningDraft>>({});
const contextOpen = ref(false);
const selectedPeriodId = ref<string | null>(null);
const pendingPeriodId = ref<string | null>(null);
const selectedItemId = ref<string | null>(null);
const selectedOn = ref<string | null>(null);
const selectedLedgerMonth = ref<string | null>(null);
let contextInitialized = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let alive = true;

const selectedPeriod = computed(() => overview.periods.value.find(item => item.period.periodId === selectedPeriodId.value) ?? null);
const selectedItem = computed(() => selectedPeriod.value?.items.find(item => item.itemId === selectedItemId.value) ?? null);
const accountLabel = (accountId: string) => {
  const account = overview.accounts.value.find(item => item.account.accountId === accountId)?.account;
  return account ? `${account.displayName} ${account.maskedIdentifier}${account.source==='demo'?' · Demo 数据':''}` : '账户信息不可用';
};
const contextLabel = computed(() => selectedPeriod.value ? `${selectedPeriod.value.period.monthStart.slice(0,7).replace('-','年')}月计划` : '不带具体计划');
const contextDetail = computed(() => selectedPeriod.value
  ? `${accountLabel(selectedPeriod.value.period.accountId)} · ${fundingLabel(selectedPeriod.value.forecast.status)}`
  : '只讨论你的问题，不绑定具体预算周期');
const shortcuts = ['我最近还能怎么安排？', '帮我做一个周末计划草稿，缺失金额和日期请留待我确认',
  '为什么本月最低余额或资金判断是未知？', '哪些可调整项目会影响本月保留目标？'];

useDidShow(async () => {
  await overview.load();
  if (overview.error.value) return;
  if (!contextInitialized) {
    selectedPeriodId.value = overview.currentPeriod.value?.period.periodId ?? null;
    pendingPeriodId.value = selectedPeriodId.value;
    contextInitialized = true;
  } else if (selectedPeriodId.value && !selectedPeriod.value) {
    selectedPeriodId.value = null;
    pendingPeriodId.value = null;
  }
  const entry = takeAiQuestion();
  if (entry) {
    if (overview.periods.value.some(period => period.period.periodId === entry.periodId)) {
      selectedPeriodId.value = entry.periodId;
      pendingPeriodId.value = entry.periodId;
      selectedItemId.value = entry.itemId ?? null;
      selectedOn.value = entry.on ?? null;
      selectedLedgerMonth.value = entry.ledgerMonth ?? null;
      input.value = entry.question;
    } else error.value = '原计划已不可用，请重新选择本人预算周期。';
  }
});
onBeforeUnmount(() => { alive = false; if (timer) clearTimeout(timer); });

function schedule(runId: string) { if (timer) clearTimeout(timer); timer = setTimeout(() => void poll(runId), 1500); }
async function loadDraftArtifacts(run: AgentRun) {
  await Promise.all(run.artifacts.filter(artifact => !drafts.value[artifact.draftId]).map(async artifact => {
    try { drafts.value[artifact.draftId] = (await api.planningDraft(artifact.draftId)).data; }
    catch { /* The detail page remains the recovery entry if a draft changed. */ }
  }));
}
async function poll(runId: string) {
  if (!alive) return;
  try {
    const result = (await api.agentRun(runId)).data;
    const message = messages.value.find(item => item.id === runId);
    if (message) { message.run = result; message.text = result.output || stateText(result.state, result.errorCode); }
    if (result.artifacts.length) await loadDraftArtifacts(result);
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
    const result = (await api.startAgent(text, selectedPeriodId.value, selectedLedgerMonth.value)).data;
    messages.value.push({ id: result.runId, role: 'assistant', text: '我正在核对计划与资金事实…', at: nowLabel() });
    await poll(result.runId);
  } catch (reason) {
    sending.value = false;
    if (reason instanceof ApiError && reason.status === 401) return goLogin();
    error.value = errorMessage(reason);
  }
}
function handleAiInput(event: Event) {
  input.value = (event as unknown as { detail: { value: string } }).detail.value;
}
function submitInput() { void send(); }
function openContext() { pendingPeriodId.value = selectedPeriodId.value; contextOpen.value = true; }
function confirmContext() { selectedPeriodId.value = pendingPeriodId.value; selectedItemId.value = null;
  selectedOn.value = null; selectedLedgerMonth.value = null; contextOpen.value = false; }
function chooseShortcut(value: string) { input.value = value; }
function draftField<T>(value: T | null, suggestion: T | null | undefined) {
  return value !== null ? { value, source: '用户提供' }
    : suggestion !== null && suggestion !== undefined ? { value: suggestion, source: '行止建议，待确认' }
      : { value: null, source: '待补充' };
}
</script>

<template>
  <PageShell title="行止 AI" subtitle="你的规划伙伴，先解释，再进入确认">
    <template #hero><button class="ai-history-button" aria-label="查看 AI 历史" @tap="Taro.navigateTo({url:'/subpackage/common/ai-history'})">◷</button></template>
    <view class="context-card" @tap="openContext">
      <view><text class="context-card__label">当前上下文</text><text class="context-card__value">{{ contextLabel }}</text><text class="context-card__detail">{{ contextDetail }}</text></view><text class="context-card__arrow">›</text>
    </view>
    <view v-if="selectedPeriod" class="basis-card">
      <text class="basis-card__title">可核对的计划依据</text>
      <text>{{ accountLabel(selectedPeriod.period.accountId) }} · {{ selectedPeriod.period.monthStart.slice(0,7).replace('-','年') }}月</text>
      <text>确认现金 {{ yuan(selectedPeriod.basis.confirmedCashMinor) }} · 预计最低 {{ yuan(selectedPeriod.basis.minimumProjectedCashMinor) }}</text>
      <text>最低缓冲／缺口 {{ yuan(selectedPeriod.basis.minimumSavingsHeadroomMinor) }} · {{ fundingLabel(selectedPeriod.forecast.status) }}</text>
      <text v-if="selectedOn">本次提问关注 {{ shortDate(selectedOn) }}</text>
      <text v-if="selectedLedgerMonth">账目汇总仅限 {{ selectedLedgerMonth.replace('-', '年') }}月</text>
      <text v-if="selectedItem">关联项目：{{ selectedItem.title }} · {{ yuan(selectedItem.userEstimatedAmountMinor) }}</text>
      <button v-if="selectedItem" class="link-button" @tap="Taro.navigateTo({url:`/pages/impact/detail?periodId=${selectedPeriodId}&itemId=${selectedItemId}`})">不使用 AI，直接核对项目影响 ›</button>
      <button v-else class="link-button" @tap="Taro.navigateTo({url:`/pages/period/detail?id=${selectedPeriodId}`})">不使用 AI，直接查看周期依据 ›</button>
    </view>
    <view v-if="input.trim()" class="question-preview"><text>待发送问题</text><text>{{ input }}</text><text>请检查内容，点击下方发送后才会启动 AI。</text></view>
    <view class="welcome"><IpAvatar size="large"/><view class="welcome__bubble">今天想让我帮你看看什么？</view></view>
    <scroll-view class="shortcut-scroll" scroll-x><button v-for="item in shortcuts" :key="item" class="shortcut" :disabled="sending" @tap="chooseShortcut(item)">{{ item }}</button></scroll-view>
    <view v-if="messages.length" class="message-list">
      <view v-for="message in messages" :key="message.id" class="message" :class="`message--${message.role}`">
        <IpAvatar v-if="message.role==='assistant'" size="small"/>
        <view class="message__content"><view class="message__bubble"><text>{{ message.text }}</text></view><text class="message__time">{{ message.at }}</text>
          <view v-for="artifact in message.run?.artifacts??[]" :key="artifact.draftId" class="result-card"><view class="row-between"><text class="result-card__title">已保存的计划草稿</text><StatusBadge label="等待你确认" tone="info"/></view><template v-if="drafts[artifact.draftId]"><view v-for="(item,index) in drafts[artifact.draftId].items" :key="index" class="draft-summary"><text>{{ item.title }}</text><text>日期：{{ shortDate(draftField(item.plannedOn,item.suggestion?.plannedOn).value) }} · {{ draftField(item.plannedOn,item.suggestion?.plannedOn).source }}</text><text>预算：{{ yuan(draftField(item.userEstimatedAmountMinor,item.suggestion?.estimatedAmountMinor).value) }} · {{ draftField(item.userEstimatedAmountMinor,item.suggestion?.estimatedAmountMinor).source }}</text><text>优先级：{{ draftField(item.priority,item.suggestion?.priority).value==='required'?'必须保留':draftField(item.priority,item.suggestion?.priority).value==='adjustable'?'可以调整':'待补充' }} · {{ draftField(item.priority,item.suggestion?.priority).source }}</text></view><text v-if="drafts[artifact.draftId].missingFields.length" class="result-card__detail">{{ drafts[artifact.draftId].missingFields.length }} 项原始字段待你补充；建议值不会自动变为已确认值。</text></template><text v-else class="result-card__detail">草稿已保存，打开详情可读取完整字段。</text><button class="link-button" @tap="Taro.navigateTo({url:`/pages/draft/detail?id=${artifact.draftId}`})">查看逐项影响与完善 ›</button></view>
        </view>
      </view>
    </view>
    <StatePanel v-else-if="!overview.loading.value" title="从一个具体问题开始" detail="行止可以读、算、解释和生成草稿，不会替你购买、支付或退款。" />
    <view v-if="error" class="notice notice--error ai-error">{{ error }}</view>
    <view class="ai-composer">
      <view class="ai-composer__question"><button class="ai-composer__add" aria-label="选择计划上下文" :disabled="sending" @tap="openContext">＋</button><input class="ai-composer__input" type="text" :value="input" :disabled="sending" :maxlength="4000" confirm-type="send" :cursor-spacing="24" placeholder="问问行止……" @input="handleAiInput" @confirm="submitInput"/></view>
      <button class="ai-send-button" :disabled="sending" @tap="submitInput">{{ sending?'正在发送…':'发送给行止' }}</button>
    </view>
  </PageShell>

  <BottomSheet above-tab-bar :model-value="contextOpen" title="选择对话上下文" description="切换只影响后续提问，不会修改任何计划。" primary-text="使用这个上下文" @update:model-value="contextOpen=$event" @primary="confirmContext">
    <view class="context-options">
      <button v-for="period in overview.periods.value" :key="period.period.periodId" class="context-option" :class="{'context-option--selected':pendingPeriodId===period.period.periodId}" @tap="pendingPeriodId=period.period.periodId"><view><text>{{ period.period.monthStart.slice(0,7).replace('-','年') }}月计划</text><text>{{ accountLabel(period.period.accountId) }} · {{ fundingLabel(period.forecast.status) }} · 最低 {{ yuan(period.basis.minimumProjectedCashMinor) }}</text></view><text>{{ pendingPeriodId===period.period.periodId?'✓':'○' }}</text></button>
      <button class="context-option" :class="{'context-option--selected':pendingPeriodId===null}" @tap="pendingPeriodId=null"><view><text>不带具体上下文</text><text>只讨论当前问题，不绑定预算周期</text></view><text>{{ pendingPeriodId===null?'✓':'○' }}</text></button>
    </view>
  </BottomSheet>

</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.ai-history-button{position:absolute;z-index:4;top:calc(40px + env(safe-area-inset-top));right:30px;display:flex;width:66px;height:66px;align-items:center;justify-content:center;padding:0;color:$brand-deep;background:rgba(255,255,255,.66);border:1px solid rgba(255,255,255,.86);border-radius:50%;font-size:32px;line-height:1;box-shadow:$shadow-card}.context-card{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:24px 26px;background:rgba(255,255,255,.78);border:1px solid rgba(255,255,255,.86);border-radius:20px;box-shadow:$shadow-card}.context-card text{display:block}.context-card__label{color:$text-secondary;font-size:24px}.context-card__value{margin-top:6px;font-size:30px;font-weight:680}.context-card__detail{margin-top:7px;color:$text-tertiary;font-size:24px}.context-card__arrow{color:$brand-primary;font-size:38px}
.welcome{display:flex;flex-direction:column;align-items:center;margin:34px 0 20px}.welcome__bubble{margin-top:-5px;padding:17px 24px;background:#fff;border:1px solid $border;border-radius:22px;font-size:28px;box-shadow:$shadow-card}.shortcut-scroll{margin-bottom:24px;white-space:nowrap;scrollbar-width:none}.shortcut-scroll::-webkit-scrollbar{display:none}.shortcut{display:inline-flex;width:auto;align-items:center;justify-content:center;margin-right:12px;padding:17px 24px;color:$brand-deep;background:$surface-tint;border-radius:999px;font-size:26px;line-height:1.2;white-space:nowrap}
.message-list{display:grid;gap:20px;margin:24px 0}.message{display:flex;align-items:flex-start;gap:12px}.message--user{justify-content:flex-end}.message__content{width:auto;max-width:88%}.message__bubble{min-height:54px;padding:20px 23px;background:#fff;border:1px solid $border;border-radius:8px 22px 22px 22px;box-shadow:0 8px 25px rgba(31,66,54,.05)}.message--user .message__bubble{color:$brand-deep;background:$surface-tint;border-color:#D5E5DC;border-radius:22px 8px 22px 22px}.message__bubble text{display:block;font-size:29px;line-height:1.65;white-space:pre-wrap}.message__time{display:block;margin:7px 8px 0;color:$text-tertiary;font-size:22px}.message--user .message__time{text-align:right}.result-card{margin-top:10px;padding:20px;background:#fff;border:1px solid #CFE0D7;border-radius:18px;box-shadow:$shadow-card}.result-card__title{font-size:29px;font-weight:680}.result-card__detail{display:block;margin:14px 0;color:$text-secondary;font-size:25px;line-height:1.6}
.ai-error{margin:18px 0}.ai-composer{position:sticky;bottom:calc(104px + env(safe-area-inset-bottom));z-index:10;display:grid;gap:12px;margin-top:24px;padding:15px;background:rgba(255,255,255,.98);border:1px solid $border;border-radius:26px;box-shadow:0 12px 40px rgba(31,66,54,.14)}.ai-composer__question{display:flex;min-width:0;align-items:center;gap:12px}.ai-composer__input{box-sizing:border-box;display:block;flex:1;min-width:0;width:1px;height:70px;padding:0 18px;color:$text-primary;background:$soft-surface;border:1px solid $border;border-radius:20px;font-size:29px;line-height:70px}.ai-composer__add{display:flex;flex:0 0 66px;width:66px;height:66px;align-items:center;justify-content:center;padding:0;color:$brand-primary;background:$surface-tint;border-radius:50%;font-size:32px;line-height:1}.ai-composer__add[disabled]{color:$text-tertiary;opacity:.65}.ai-send-button{display:flex;width:100%;height:70px;align-items:center;justify-content:center;padding:0 20px;color:#fff;background:$brand-primary;border-radius:20px;font-size:27px;font-weight:700;line-height:1}.ai-send-button[disabled]{opacity:.48}
.basis-card,.question-preview{display:grid;gap:8px;margin-top:16px;padding:20px 24px;background:$soft-surface;border:1px solid $border;border-radius:18px;font-size:25px;line-height:1.45}.basis-card__title,.question-preview text:first-child{font-size:28px;font-weight:680}.basis-card .link-button{justify-self:start;margin-top:4px}.question-preview{background:$surface-tint}.question-preview text:last-child{color:$text-secondary;font-size:23px}.draft-summary{display:grid;gap:5px;margin-top:14px;padding-top:12px;border-top:1px solid $border;font-size:24px;line-height:1.4}.draft-summary text:first-child{font-size:27px;font-weight:650}
.context-options{overflow:hidden;border:1px solid $border;border-radius:18px}.context-option{display:flex;width:100%;align-items:center;justify-content:space-between;gap:20px;padding:20px;text-align:left}.context-option+.context-option{border-top:1px solid $border}.context-option text{display:block}.context-option view text:first-child{font-size:28px;font-weight:650}.context-option view text+text{margin-top:6px;color:$text-secondary;font-size:24px}.context-option>text{color:$text-tertiary;font-size:30px}.context-option--selected{background:$surface-tint}.context-option--selected>text{color:$brand-primary}
</style>
