<script setup lang="ts">
import { computed, ref } from 'vue';
import Taro, { useLoad, useDidShow } from '@tarojs/taro';
import BottomSheet from '@/components/BottomSheet.vue';
import FactRow from '@/components/FactRow.vue';
import PageShell from '@/components/PageShell.vue';
import SectionCard from '@/components/SectionCard.vue';
import StatePanel from '@/components/StatePanel.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { fundingLabel, shortDate, yuan } from '@/lib/format';
import type { BudgetItemChangePreview, BudgetItemInput, BudgetPeriod, PlanningDraft } from '@/lib/types';

const id = ref('');
const draft = ref<PlanningDraft | null>(null);
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const impact = ref<BudgetItemChangePreview | null>(null);
const impactIndex = ref<number | null>(null);
const impactOpen = ref(false);
const impactLoading = ref<number | null>(null);
const impactError = ref('');

const periods = ref<BudgetPeriod[]>([]);
const selectedPeriodId = ref('');
const selectedPeriod = computed(() => periods.value.find(p => p.period.periodId === selectedPeriodId.value) ?? null);
const periodLabels = ref<string[]>([]);
const periodOpen = ref(false);
const periodIndex = computed(() => periods.value.findIndex(p => p.period.periodId === selectedPeriodId.value));
const basisNotice = ref('');
let initialLoad: Promise<void> | null = null;

async function load() {
  loading.value = true; error.value = ''; impact.value = null; impactOpen.value = false;
  try {
    const [draftResult, periodResult, accountResult] = await Promise.all([
      api.planningDraft(id.value), api.periods(), api.accounts(),
    ]);
    draft.value = draftResult.data;
    periods.value = periodResult.data.periods.filter(p => p.period.status !== 'closed'
      && accountResult.data.accounts.some(a => a.account.accountId === p.period.accountId && a.account.status === 'linked'));
    periodLabels.value = periods.value.map(p => `${p.period.monthStart.slice(0, 7)} · ${accountResult.data.accounts.find(a => a.account.accountId === p.period.accountId)?.account.displayName ?? '本人账户'} · ${p.period.status === 'active' ? '执行中' : '草稿周期'}`);
    if (draft.value.periodId) selectedPeriodId.value = draft.value.periodId;
    else if (!periods.value.some(p => p.period.periodId === selectedPeriodId.value)) selectedPeriodId.value = '';
  } catch (reason) { error.value = errorMessage(reason); }
  finally { loading.value = false; }
}
useLoad(options => { id.value = options.id ?? ''; initialLoad = load(); });
useDidShow(async () => {
  if (initialLoad) { await initialLoad; initialLoad = null; return; }
  if (id.value) await load();
});
function choosePeriod(index: number) {
  selectedPeriodId.value = periods.value[index]?.period.periodId ?? '';
  periodOpen.value = false;
  impact.value = null; impactOpen.value = false; impactError.value = ''; basisNotice.value = '';
}
function adopt(index: number) {
  if (!selectedPeriod.value || !draft.value || !['draft', 'accepted'].includes(draft.value.status)) return;
  void Taro.navigateTo({ url: `/pages/item/edit?periodId=${selectedPeriodId.value}&draftId=${draft.value.draftId}&index=${index}` });
}

function field<T>(value: T | null, suggestion: T | null | undefined) {
  return value !== null ? { value, source: '用户提供' }
    : suggestion !== null && suggestion !== undefined ? { value: suggestion, source: '行止建议，待确认' }
      : { value: null, source: '待补充' };
}
function complete(index: number) {
  const item = draft.value?.items[index];
  return Boolean(item?.plannedOn && item.userEstimatedAmountMinor && item.priority);
}
async function showImpact(index: number) {
  const value = draft.value;
  const item = value?.items[index];
  if (!value || !selectedPeriod.value || !item || impactLoading.value !== null) return;
  if (!complete(index)) { adopt(index); return; }
  if (!item.plannedOn || !item.userEstimatedAmountMinor || !item.priority) return;
  impactLoading.value = index; impactError.value = ''; basisNotice.value = '';
  impact.value = null; impactOpen.value = false;
  try {
    const current = (await api.period(selectedPeriodId.value)).data;
    if (current.period.status === 'closed') throw new Error('该周期已结束，请返回选择其他周期。');
    if (item.plannedOn < current.period.monthStart || item.plannedOn > current.period.monthEnd) {
      impactError.value = '草稿日期不在所选月份，请通过“由我确认后加入正式计划”调整日期，再查看影响。';
      return;
    }
    basisNotice.value = value.periodId !== current.period.periodId ? '按你选择的周期重新计算；原草稿及历史评估保留。'
      : value.basisFinancialVersion !== current.basis.financialVersion || value.basisPeriodVersion !== current.period.periodVersion
        ? '资金或计划已经变化，本次按最新依据重新评估；原草稿评估仅为历史记录。' : '本次已读取最新资金和计划依据。';
    const input: BudgetItemInput = {
      periodId: current.period.periodId, itemId: null,
      expectedFinancialVersion: current.basis.financialVersion,
      expectedPeriodVersion: current.period.periodVersion,
      kind: item.priority === 'required' ? 'essential_expense' : 'planned_spend',
      title: item.title, categoryCode: null, plannedOn: item.plannedOn,
      userEstimatedAmountMinor: item.userEstimatedAmountMinor,
      priority: item.priority, changeReason: '查看规划草稿影响',
    };
    impact.value = (await api.budgetItemChangePreview(current.period.periodId, input)).data;
    impactIndex.value = index; impactOpen.value = true;
  } catch (reason) { impactError.value = `${errorMessage(reason)} 可再次点击查看影响以读取最新依据。`; }
  finally { impactLoading.value = null; }
}

async function transition(target: 'accepted' | 'discarded') {
  if (!draft.value || draft.value.status !== 'draft' || saving.value) return;
  const copy = target === 'accepted'
    ? '采纳只会保存你对这份草稿的选择，不会自动写入预算。项目仍需逐项确认。'
    : '放弃后这份草稿将保留为历史记录，但不能再采纳。';
  const confirmed = await Taro.showModal({
    title: target === 'accepted' ? '确认采纳草稿？' : '确认放弃草稿？',
    content: copy,
    confirmText: target === 'accepted' ? '确认采纳' : '确认放弃',
  });
  if (!confirmed.confirm) return;
  saving.value = true;
  try {
    draft.value = (target === 'accepted'
      ? await api.acceptPlanningDraft(id.value)
      : await api.discardPlanningDraft(id.value)).data;
    Taro.showToast({ title: target === 'accepted' ? '已采纳' : '已放弃', icon: 'success' });
  } catch (reason) {
    Taro.showToast({ title: errorMessage(reason), icon: 'none' });
  } finally { saving.value = false; }
}

function statusLabel(status: PlanningDraft['status']) {
  return ({ draft: '待处理', accepted: '已采纳', discarded: '已放弃', stale: '已失效' } as const)[status];
}
</script>

<template><PageShell title="行止规划草稿" subtitle="草稿不会自动改变预算" compact><template #hero><button class="back" @tap="Taro.navigateBack()">‹</button></template><StatePanel v-if="loading" title="正在读取规划草稿"/><StatePanel v-else-if="error||!draft" title="草稿暂时不可用" :detail="error" tone="error"><button class="secondary-button" @tap="load">重新加载</button></StatePanel><template v-else><SectionCard><view class="row-between"><text class="card-title">草稿保存时的判断</text><StatusBadge :label="statusLabel(draft.status)" :tone="draft.status==='accepted'?'success':draft.status==='draft'?'info':'warning'"/></view><view class="assessment"><StatusBadge :label="draft.assessment?fundingLabel(draft.assessment.status):'尚未绑定资金依据'" :tone="draft.assessment?.status==='allowed'?'success':'info'"/></view><template v-if="draft.assessment"><FactRow label="预计缺口" :value="draft.assessment.shortfallMinor===null?'依据不足':yuan(draft.assessment.shortfallMinor)"/><FactRow label="缺口或未知日期" :value="draft.assessment.affectedDates.length?draft.assessment.affectedDates.map(shortDate).join('、'):'暂无'"/></template><view v-if="draft.missingFields.length" class="notice notice--warning missing">还有 {{draft.missingFields.length}} 个用户字段待补充；建议值不会自动成为已确认金额或日期。</view></SectionCard><SectionCard v-if="!draft.periodId" class="missing"><text class="card-title">选择要加入的预算周期</text><text class="suggestion">选择只用于后续预览和确认，不会自动加入计划或改写原草稿。</text><button v-if="periods.length" class="secondary-button period-picker" @tap="periodOpen=true">{{periodIndex >= 0 ? periodLabels[periodIndex] : '请选择本人预算周期'}} ›</button><text v-else class="suggestion">还没有可用周期。创建后返回这里，再选择周期继续。</text><button class="link-button" @tap="Taro.navigateTo({url:'/pages/period/edit'})">新建预算周期 ›</button></SectionCard><view v-else-if="!selectedPeriod" class="notice notice--warning missing">原周期已结束或账户不可用，请到计划页查看原记录。</view><view v-if="basisNotice" class="notice notice--info missing">{{basisNotice}}</view><view v-if="impactError" class="notice notice--error missing">{{impactError}}</view><view class="draft-list"><SectionCard v-for="(item,index) in draft.items" :key="`${item.title}-${index}`"><view class="row-between"><text class="item-title">{{item.title}}</text><StatusBadge :label="complete(index)?'用户字段完整':'需要补充'" :tone="complete(index)?'success':'info'"/></view><FactRow label="日期" :value="`${shortDate(field(item.plannedOn,item.suggestion?.plannedOn).value)} · ${field(item.plannedOn,item.suggestion?.plannedOn).source}`"/><FactRow label="估算金额" :value="`${yuan(field(item.userEstimatedAmountMinor,item.suggestion?.estimatedAmountMinor).value)} · ${field(item.userEstimatedAmountMinor,item.suggestion?.estimatedAmountMinor).source}`"/><FactRow label="安排属性" :value="`${field(item.priority,item.suggestion?.priority).value==='required'?'必须保留':field(item.priority,item.suggestion?.priority).value==='adjustable'?'可以调整':'待确认'} · ${field(item.priority,item.suggestion?.priority).source}`"/><text v-if="item.suggestion?.reason" class="suggestion">行止建议：{{item.suggestion.reason}}</text><button class="secondary-button adopt" :disabled="!selectedPeriod||impactLoading!==null||(!complete(index)&&!['draft','accepted'].includes(draft.status))" @tap="showImpact(index)">{{impactLoading===index?'正在计算…':!selectedPeriod?'请先选择可用预算周期':complete(index)?'查看该项资金影响':'补充信息后查看影响'}}</button><button class="link-button adopt-link" :disabled="!selectedPeriod||!['draft','accepted'].includes(draft.status)" @tap="adopt(index)">由我确认后加入正式计划 ›</button></SectionCard></view><template v-if="draft.status==='draft'"><view class="draft-actions"><button class="primary-button action" :loading="saving" :disabled="saving" @tap="transition('accepted')">采纳这份草稿</button><button class="secondary-button action action--discard" :disabled="saving" @tap="transition('discarded')">放弃草稿</button></view><view class="notice notice--info boundary">采纳或放弃只记录草稿状态，不会自动改动正式预算；每个项目仍需逐项确认。</view></template><view v-else class="notice notice--info boundary">这份草稿{{draft.status==='accepted'?'已被采纳':draft.status==='discarded'?'已放弃':'已失效'}}，正式预算没有被自动修改。</view></template></PageShell><BottomSheet :model-value="impactOpen" title="单项资金影响" description="以下只读比较基于草稿用户字段和当前资金依据；不会写入预算或建单。" :primary-text="draft&&['draft','accepted'].includes(draft.status)?'继续完善并确认':''" secondary-text="关闭" @update:model-value="impactOpen=$event" @primary="impactOpen=false;impactIndex!==null&&adopt(impactIndex)"><FactRow label="原预计最低余额" :value="yuan(impact?.before.minimumProjectedCashMinor)"/><FactRow label="加入该项后" :value="yuan(impact?.after.minimumProjectedCashMinor)"/><FactRow label="原缓冲／缺口" :value="yuan(impact?.before.minimumSavingsHeadroomMinor)"/><FactRow label="加入后的缓冲／缺口" :value="yuan(impact?.after.minimumSavingsHeadroomMinor)"/><FactRow label="加入后的结论" :value="impact?fundingLabel(impact.after.status):'依据不足'"/><text class="suggestion">{{basisNotice}} 继续编辑时仍会再次预览并由你确认保存。</text></BottomSheet><BottomSheet :model-value="periodOpen" title="选择本人预算周期" description="仅用于本次草稿转入计划，原草稿保留。" secondary-text="返回" @update:model-value="periodOpen=$event"><button v-for="(period,index) in periods" :key="period.period.periodId" class="secondary-button period-picker" @tap="choosePeriod(index)">{{periodLabels[index]}}{{periodIndex===index?' · 已选择':''}}</button></BottomSheet></template>

<style lang="scss">@use '../../styles/tokens' as *;.back{position:absolute;z-index:4;top:calc(34px + env(safe-area-inset-top));right:28px;width:64px;height:64px;color:$brand-deep;background:rgba(255,255,255,.7);border-radius:50%;font-size:44px}.card-title,.item-title{font-size:27px;font-weight:700}.assessment,.missing,.boundary{margin-top:18px}.draft-list{display:grid;gap:16px;margin-top:18px}.suggestion{display:block;margin-top:14px;color:$text-secondary;font-size:21px;line-height:1.55}.adopt,.action{width:100%;min-height:76px;margin-top:18px;font-size:23px}.adopt-link{margin-top:8px}.draft-actions{display:grid;gap:12px;margin-top:20px}.action--discard{color:$text-secondary}.period-picker{padding:20px;margin-top:16px;background:$soft-surface;border-radius:12px;font-size:24px}</style>
