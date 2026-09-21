<script setup lang="ts">
import { ref } from 'vue';
import Taro, { useLoad } from '@tarojs/taro';
import FactRow from '@/components/FactRow.vue';
import PageShell from '@/components/PageShell.vue';
import SectionCard from '@/components/SectionCard.vue';
import StatePanel from '@/components/StatePanel.vue';
import StatusBadge from '@/components/StatusBadge.vue';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { fundingLabel, shortDate, yuan } from '@/lib/format';
import type { PlanningDraft } from '@/lib/types';

const id = ref('');
const draft = ref<PlanningDraft | null>(null);
const loading = ref(true);
const saving = ref(false);
const error = ref('');

useLoad(async (options) => {
  id.value = options.id ?? '';
  try { draft.value = (await api.planningDraft(id.value)).data; }
  catch (reason) { error.value = errorMessage(reason); }
  finally { loading.value = false; }
});

function adopt(index: number) {
  if (!draft.value?.periodId || draft.value.status !== 'draft') return;
  void Taro.navigateTo({ url: `/pages/item/edit?periodId=${draft.value.periodId}&draftId=${draft.value.draftId}&index=${index}` });
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

<template><PageShell title="行止规划草稿" subtitle="草稿不会自动改变预算" compact><template #hero><button class="back" @tap="Taro.navigateBack()">‹</button></template><StatePanel v-if="loading" title="正在读取规划草稿"/><StatePanel v-else-if="error||!draft" title="草稿暂时不可用" :detail="error" tone="error"/><template v-else><SectionCard><view class="row-between"><text class="card-title">整体判断</text><StatusBadge :label="statusLabel(draft.status)" :tone="draft.status==='accepted'?'success':draft.status==='draft'?'info':'warning'"/></view><view class="assessment"><StatusBadge :label="draft.assessment?fundingLabel(draft.assessment.status):'尚未绑定资金依据'" :tone="draft.assessment?.status==='allowed'?'success':draft.assessment?.status==='unknown'?'info':'warning'"/></view><template v-if="draft.assessment"><FactRow label="预计缺口" :value="draft.assessment.shortfallMinor===null?'依据不足':yuan(draft.assessment.shortfallMinor)"/><FactRow label="受影响日期" :value="draft.assessment.affectedDates.length?draft.assessment.affectedDates.map(shortDate).join('、'):'暂无'"/></template><view v-if="draft.missingFields.length" class="notice notice--warning missing">还有 {{draft.missingFields.length}} 个字段需要你确认，采纳项目时可以补齐。</view></SectionCard><view class="draft-list"><SectionCard v-for="(item,index) in draft.items" :key="`${item.title}-${index}`"><view class="row-between"><text class="item-title">{{item.title}}</text><StatusBadge :label="item.plannedOn&&item.userEstimatedAmountMinor&&item.priority?'信息完整':'需要补充'" :tone="item.plannedOn&&item.userEstimatedAmountMinor&&item.priority?'success':'info'"/></view><FactRow label="日期" :value="shortDate(item.plannedOn??item.suggestion?.plannedOn)"/><FactRow label="估算金额" :value="yuan(item.userEstimatedAmountMinor??item.suggestion?.estimatedAmountMinor)"/><FactRow label="安排属性" :value="(item.priority??item.suggestion?.priority)==='required'?'必须保留':(item.priority??item.suggestion?.priority)==='adjustable'?'可以调整':'待确认'"/><text v-if="item.suggestion?.reason" class="suggestion">建议：{{item.suggestion.reason}}</text><button class="secondary-button adopt" :disabled="!draft.periodId||draft.status!=='draft'" @tap="adopt(index)">{{draft.status!=='draft'?'草稿已处理':draft.periodId?'完善并加入计划':'请先建立预算周期'}}</button></SectionCard></view><template v-if="draft.status==='draft'"><view class="draft-actions"><button class="primary-button action" :loading="saving" :disabled="saving" @tap="transition('accepted')">采纳这份草稿</button><button class="secondary-button action action--discard" :disabled="saving" @tap="transition('discarded')">放弃草稿</button></view><view class="notice notice--info boundary">采纳或放弃只记录草稿状态，不会自动改动正式预算；加入计划仍需逐项确认。</view></template><view v-else class="notice notice--info boundary">这份草稿{{draft.status==='accepted'?'已被采纳':draft.status==='discarded'?'已放弃':'已失效'}}，正式预算没有被自动修改。</view></template></PageShell></template>

<style lang="scss">@use '../../styles/tokens' as *;.back{position:absolute;z-index:4;top:calc(34px + env(safe-area-inset-top));right:28px;width:64px;height:64px;color:$brand-deep;background:rgba(255,255,255,.7);border-radius:50%;font-size:44px}.card-title,.item-title{font-size:27px;font-weight:700}.assessment,.missing,.boundary{margin-top:18px}.draft-list{display:grid;gap:16px;margin-top:18px}.suggestion{display:block;margin-top:14px;color:$text-secondary;font-size:21px;line-height:1.55}.adopt,.action{width:100%;min-height:76px;margin-top:18px;font-size:23px}.draft-actions{display:grid;gap:12px;margin-top:20px}.action--discard{color:$text-secondary}</style>
