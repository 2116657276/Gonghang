<script setup lang="ts">
import { computed, ref } from 'vue';
import Taro, { useLoad } from '@tarojs/taro';
import BottomSheet from '@/components/BottomSheet.vue';
import FactRow from '@/components/FactRow.vue';
import PageShell from '@/components/PageShell.vue';
import SectionCard from '@/components/SectionCard.vue';
import StatePanel from '@/components/StatePanel.vue';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { dateKey, fundingLabel, minorFromYuan, shortDate, yuan, yuanInput } from '@/lib/format';
import type { BudgetItem, BudgetItemChangePreview, BudgetItemImpact, BudgetItemInput, BudgetPeriod } from '@/lib/types';

const periodId = ref('');
const itemId = ref('');
const period = ref<BudgetPeriod | null>(null);
const item = ref<BudgetItem | null>(null);
const title = ref('');
const amount = ref('');
const plannedOn = ref('');
const kind = ref<'essential_expense' | 'planned_spend' | 'expected_income'>('planned_spend');
const priority = ref<'required' | 'adjustable'>('adjustable');
const reason = ref('完善本月计划');
const loading = ref(true);
const saving = ref(false);
const previewing = ref(false);
const error = ref('');
const changePreview = ref<BudgetItemChangePreview | null>(null);
const previewKey = ref('');
const previewOpen = ref(false);
const cancelPreview = ref<BudgetItemImpact | null>(null);
const cancelOpen = ref(false);
const kindOptions = [{ v: 'essential_expense', n: '必要支出' },
  { v: 'planned_spend', n: '计划消费' }, { v: 'expected_income', n: '预计收入' }] as const;
const editing = computed(() => Boolean(itemId.value));
const changeInput = computed<BudgetItemInput | null>(() => {
  const minor = minorFromYuan(amount.value);
  if (!period.value || !title.value.trim() || minor === null || minor <= 0
    || plannedOn.value < period.value.period.monthStart || plannedOn.value > period.value.period.monthEnd
    || reason.value.trim().length < 2) return null;
  return { periodId: periodId.value, itemId: itemId.value || null,
    expectedPeriodVersion: period.value.period.periodVersion, kind: kind.value,
    expectedFinancialVersion: period.value.basis.financialVersion,
    title: title.value.trim(), categoryCode: item.value?.categoryCode ?? null, plannedOn: plannedOn.value,
    userEstimatedAmountMinor: minor, priority: priority.value, changeReason: reason.value.trim() };
});
const currentKey = computed(() => JSON.stringify(changeInput.value));
function headroomText(value: number | null) { return value === null ? '依据不足'
  : value < 0 ? `缺口 ${yuan(-value)}` : `缓冲 ${yuan(value)}`; }

useLoad(async options => {
  periodId.value = options.periodId ?? '';
  itemId.value = options.itemId ?? '';
  try {
    period.value = (await api.period(periodId.value)).data;
    item.value = period.value.items.find(value => value.itemId === itemId.value) ?? null;
    if (item.value) {
      title.value = item.value.title; amount.value = yuanInput(item.value.userEstimatedAmountMinor);
      plannedOn.value = item.value.plannedOn; kind.value = item.value.kind; priority.value = item.value.priority;
    } else if (options.draftId && options.index) {
      const draft = (await api.planningDraft(options.draftId)).data;
      const source = draft.items[Number(options.index)];
      if (source) {
        title.value = source.title;
        amount.value = yuanInput(source.userEstimatedAmountMinor ?? source.suggestion?.estimatedAmountMinor);
        plannedOn.value = source.plannedOn ?? source.suggestion?.plannedOn ?? period.value.period.monthStart;
        priority.value = source.priority ?? source.suggestion?.priority ?? 'adjustable';
        kind.value = priority.value === 'required' ? 'essential_expense' : 'planned_spend';
        reason.value = '采纳行止规划草稿';
      }
    } else {
      const today = dateKey(new Date().toISOString());
      plannedOn.value = today >= period.value.period.monthStart && today <= period.value.period.monthEnd
        ? today : period.value.period.monthStart;
    }
  } catch (reason) { error.value = errorMessage(reason); }
  finally { loading.value = false; }
});

function selectKind(value: typeof kind.value) {
  kind.value = value;
  if (value === 'essential_expense') priority.value = 'required';
  if (value === 'expected_income') priority.value = 'adjustable';
}
async function showPreview() {
  const input = changeInput.value;
  if (!input || previewing.value) return;
  previewing.value = true; error.value = '';
  try {
    const result = (await api.budgetItemChangePreview(periodId.value, input)).data;
    if (result.periodVersion !== period.value?.period.periodVersion
      || result.financialVersion !== period.value?.basis.financialVersion) {
      throw new Error('资金或计划依据已经变化，请返回后重新进入编辑。');
    }
    changePreview.value = result;
    previewKey.value = JSON.stringify(input);
    previewOpen.value = true;
  } catch (reason) { error.value = errorMessage(reason); }
  finally { previewing.value = false; }
}
async function save() {
  const input = changeInput.value;
  if (!input || !changePreview.value || previewKey.value !== currentKey.value || saving.value) return;
  saving.value = true; error.value = '';
  try { await api.saveBudgetItem(input); previewOpen.value = false; await Taro.navigateBack(); }
  catch (reason) { error.value = errorMessage(reason); previewOpen.value = false; }
  finally { saving.value = false; }
}
async function showCancel() {
  if (!period.value || !item.value || previewing.value) return;
  previewing.value = true; error.value = '';
  try {
    const result = (await api.budgetItemImpact(periodId.value, item.value.itemId)).data;
    if (result.periodVersion !== period.value.period.periodVersion
      || result.financialVersion !== period.value.basis.financialVersion) {
      throw new Error('资金或计划依据已经变化，请返回后重新进入编辑。');
    }
    cancelPreview.value = result; cancelOpen.value = true;
  } catch (reason) { error.value = errorMessage(reason); }
  finally { previewing.value = false; }
}
async function cancel() {
  if (!period.value || !item.value || !cancelPreview.value || saving.value) return;
  saving.value = true; error.value = '';
  try {
    await api.cancelBudgetItem(periodId.value, item.value.itemId, period.value.period.periodVersion,
      '用户取消本月计划项目', cancelPreview.value.financialVersion);
    cancelOpen.value = false; await Taro.navigateBack();
  } catch (reason) { error.value = errorMessage(reason); cancelOpen.value = false; }
  finally { saving.value = false; }
}
</script>
<template><PageShell :title="editing?'编辑计划项目':'新增计划项目'" subtitle="先查看改前改后，再确认保存" compact><template #hero><button class="back" @tap="Taro.navigateBack()">‹</button></template><StatePanel v-if="loading" title="正在读取计划"/><template v-else-if="period"><view v-if="error" class="notice notice--error error-box">{{error}}</view><StatePanel v-if="period.period.status==='closed'||(editing&&item?.status!=='planned')" title="这个项目目前只可查看" detail="已承诺、已结束或已取消的项目需回到详情查看原记录与后续处理。"/><template v-else><SectionCard><label class="field"><text>名称</text><input v-model="title" maxlength="120" placeholder="例如 房租、周末出行"/></label><label class="field"><text>金额（元）</text><input v-model="amount" type="digit" placeholder="请输入估算金额"/></label><label class="field"><text>日期</text><picker mode="date" :start="period.period.monthStart" :end="period.period.monthEnd" :value="plannedOn" @change="plannedOn=String(($event.detail as any).value)"><view class="picker-value">{{plannedOn||'请选择日期'}} ›</view></picker></label><view class="field"><text>项目类型</text><view class="choices"><button v-for="option in kindOptions" :key="option.v" :class="{'choice--active':kind===option.v}" @tap="selectKind(option.v)">{{option.n}}</button></view></view><view class="field"><text>安排属性</text><view class="choices"><button :class="{'choice--active':priority==='required'}" :disabled="kind==='expected_income'" @tap="priority='required'">必须保留</button><button :class="{'choice--active':priority==='adjustable'}" :disabled="kind==='essential_expense'" @tap="priority='adjustable'">可以调整</button></view></view><label class="field"><text>修改说明</text><textarea v-model="reason" maxlength="200"/></label></SectionCard><view class="notice notice--info preview-note">日期只能在本月内调整；预计收入未到账前不计入可用现金。</view><button class="primary-button save" :disabled="previewing||!changeInput" @tap="showPreview">{{previewing?'正在计算…':'查看变更前后影响'}}</button><button v-if="editing&&item?.status==='planned'" class="danger-link" @tap="showCancel">取消这个计划项目</button></template></template><StatePanel v-else title="无法读取计划" :detail="error" tone="error"/></PageShell>
<BottomSheet :model-value="previewOpen" title="确认计划变更" description="以下金额来自同一版本资金依据；提交时服务端仍会复核。" primary-text="确认保存" secondary-text="返回修改" @update:model-value="previewOpen=$event" @primary="save"><template v-if="changePreview"><FactRow label="原日期" :value="item?shortDate(item.plannedOn):'新增项目'"/><FactRow label="新日期" :value="shortDate(plannedOn)"/><FactRow label="原金额" :value="item?yuan(item.userEstimatedAmountMinor):'—'"/><FactRow label="新金额" :value="yuan(changeInput?.userEstimatedAmountMinor)"/><FactRow label="原预计最低余额" :value="yuan(changePreview.before.minimumProjectedCashMinor)"/><FactRow label="新预计最低余额" :value="yuan(changePreview.after.minimumProjectedCashMinor)"/><FactRow label="原缓冲／缺口" :value="headroomText(changePreview.before.minimumSavingsHeadroomMinor)"/><FactRow label="新缓冲／缺口" :value="headroomText(changePreview.after.minimumSavingsHeadroomMinor)"/><FactRow label="原结论" :value="fundingLabel(changePreview.before.status)"/><FactRow label="新结论" :value="fundingLabel(changePreview.after.status)"/><view class="notice notice--info preview-note">{{kind==='expected_income'?'预计收入只是安排信息，到账前不增加确认现金。':'预览不会写入计划；确认后才保存。'}} 未知金额表示当前资金依据不足。</view></template></BottomSheet>
<BottomSheet :model-value="cancelOpen" title="确认取消计划项目" description="取消后保留历史记录，并按同一资金依据重新评估。" primary-text="确认取消" secondary-text="保留项目" @update:model-value="cancelOpen=$event" @primary="cancel"><FactRow label="项目" :value="item?.title??'—'"/><FactRow label="原金额" :value="yuan(item?.userEstimatedAmountMinor)"/><FactRow label="取消前最低余额" :value="yuan(cancelPreview?.withItem.minimumProjectedCashMinor)"/><FactRow label="取消后最低余额" :value="yuan(cancelPreview?.withoutItem.minimumProjectedCashMinor)"/><FactRow label="取消前缓冲／缺口" :value="headroomText(cancelPreview?.withItem.minimumSavingsHeadroomMinor??null)"/><FactRow label="取消后缓冲／缺口" :value="headroomText(cancelPreview?.withoutItem.minimumSavingsHeadroomMinor??null)"/></BottomSheet></template>
<style lang="scss">@use '../../styles/tokens' as *;.back{position:absolute;z-index:4;top:calc(34px + env(safe-area-inset-top));right:28px;width:64px;height:64px;color:$brand-deep;background:rgba(255,255,255,.7);border-radius:50%;font-size:44px}.error-box{margin-bottom:16px}.field{display:block}.field+.field{margin-top:24px}.field>text{display:block;margin-bottom:10px;color:$text-secondary;font-size:22px}.field input,.field textarea,.picker-value{width:100%;padding:0 22px;background:$soft-surface;border:1px solid $border;border-radius:16px;font-size:25px}.field input,.picker-value{height:82px;line-height:82px}.field textarea{min-height:120px;padding-block:16px}.choices{display:flex;gap:10px}.choices button{flex:1;min-height:72px;padding:10px;color:$text-secondary;background:$soft-surface;border:1px solid $border;border-radius:14px;font-size:21px}.choices .choice--active{color:$brand-primary;background:$surface-tint;border-color:#AFCBBB}.choices button[disabled]{opacity:.42}.save{width:100%;margin-top:22px}.preview-note{margin-top:16px}.danger-link{display:block;margin:20px auto;color:$danger;font-size:23px}</style>
