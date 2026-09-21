<script setup lang="ts">
import { ref } from 'vue';
import Taro, { useDidShow } from '@tarojs/taro';
import BottomSheet from '@/components/BottomSheet.vue';
import PageShell from '@/components/PageShell.vue';
import SectionCard from '@/components/SectionCard.vue';
import StatePanel from '@/components/StatePanel.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { shortDate } from '@/lib/format';
import type { AgentRun, AgentRunSummary } from '@/lib/types';

const items = ref<AgentRunSummary[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(true);
const loadingMore = ref(false);
const error = ref('');
const selected = ref<AgentRun | null>(null);
const detailLoading = ref(false);
const cancelling = ref(false);

const stateLabel = (value: string) => value === 'RUNNING' ? '整理中' : value === 'SUCCEEDED' ? '已完成' : value === 'CANCELLED' ? '已停止' : '未完成';
const stateTone = (value: string) => value === 'SUCCEEDED' ? 'success' as const : value === 'RUNNING' ? 'info' as const : value === 'FAILED' ? 'warning' as const : 'neutral' as const;

async function load(reset = true) {
  if (reset) { loading.value = true; error.value = ''; }
  else loadingMore.value = true;
  try {
    const result = await api.agentRuns(reset ? undefined : nextCursor.value ?? undefined);
    items.value = reset ? result.data.items : [...items.value, ...result.data.items];
    nextCursor.value = result.data.nextCursor;
  } catch (reason) { error.value = errorMessage(reason); }
  finally { loading.value = false; loadingMore.value = false; }
}
async function open(value: AgentRunSummary) {
  detailLoading.value = true; selected.value = null; error.value = '';
  try { selected.value = (await api.agentRun(value.id)).data; }
  catch (reason) { error.value = errorMessage(reason); }
  finally { detailLoading.value = false; }
}
async function cancel() {
  if (!selected.value || cancelling.value) return;
  cancelling.value = true;
  try { selected.value = (await api.cancelAgentRun(selected.value.id)).data; await load(); }
  catch (reason) { error.value = errorMessage(reason); }
  finally { cancelling.value = false; }
}
useDidShow(() => void load());
</script>

<template>
  <PageShell title="AI 历史" subtitle="恢复过去的整理结果与规划草稿" compact>
    <template #hero><button class="back" @tap="Taro.navigateBack()">‹</button></template>
    <StatePanel v-if="loading" title="正在读取 AI 历史" />
    <StatePanel v-else-if="error&&!items.length" title="AI 历史暂时不可用" :detail="error" tone="error"><button class="secondary-button retry" @tap="load()">重新加载</button></StatePanel>
    <template v-else>
      <view v-if="items.length" class="list"><SectionCard v-for="value in items" :key="value.id" @tap="open(value)"><view class="row-between"><text class="title">{{ value.budgetPeriodId?'关联预算周期':'未绑定具体周期' }}</text><StatusBadge :label="stateLabel(value.state)" :tone="stateTone(value.state)"/></view><text class="meta">{{ shortDate(value.createdAt) }} · 查看输出和草稿 ›</text></SectionCard></view>
      <StatePanel v-else title="还没有 AI 历史" detail="向行止发送第一条问题后，运行结果会保存在这里。" />
      <button v-if="nextCursor" class="secondary-button more" :loading="loadingMore" @tap="load(false)">{{ loadingMore?'正在加载…':'加载更多' }}</button>
      <view v-if="error" class="notice notice--error page-error">{{ error }}</view>
    </template>
  </PageShell>

  <BottomSheet :model-value="detailLoading||selected!==null" title="AI 整理结果" :description="selected?`${stateLabel(selected.state)} · ${selected.createdAt?shortDate(selected.createdAt):''}`:'正在读取完整结果'" :secondary-text="selected?.state==='RUNNING'?'关闭':'返回'" @update:model-value="value=>{if(!value&&!detailLoading)selected=null}">
    <StatePanel v-if="detailLoading" title="正在读取完整结果" />
    <template v-else-if="selected"><view class="output">{{ selected.output || (selected.state==='RUNNING'?'行止仍在整理，请稍后刷新。':'本次运行没有生成文字结果。') }}</view><view v-if="selected.artifacts.length" class="artifacts"><button v-for="artifact in selected.artifacts" :key="artifact.draftId" class="secondary-button" @tap="Taro.navigateTo({url:`/pages/draft/detail?id=${artifact.draftId}`})">查看规划草稿</button></view><button v-if="selected.state==='RUNNING'" class="secondary-button cancel" :loading="cancelling" @tap="cancel">停止本次整理</button></template>
  </BottomSheet>
</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.back{position:absolute;z-index:4;top:calc(34px + env(safe-area-inset-top));right:28px;width:64px;height:64px;color:$brand-deep;background:rgba(255,255,255,.7);border-radius:50%;font-size:44px}.retry{margin-top:18px}.list{display:grid;gap:14px}.title{font-size:25px;font-weight:680}.meta{display:block;margin-top:14px;color:$text-secondary;font-size:20px}.more{width:100%;margin-top:18px}.page-error{margin-top:14px}.output{padding:18px;color:$text-primary;background:$soft-surface;border-radius:16px;font-size:22px;line-height:1.65;white-space:pre-wrap}.artifacts{display:grid;gap:10px;margin-top:16px}.artifacts button,.cancel{width:100%}.cancel{margin-top:16px;color:$danger}
</style>
