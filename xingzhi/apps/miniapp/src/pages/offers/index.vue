<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import Taro, { useLoad } from '@tarojs/taro';
import PageShell from '@/components/PageShell.vue';import SectionCard from '@/components/SectionCard.vue';import StatePanel from '@/components/StatePanel.vue';import FactRow from '@/components/FactRow.vue';import StatusBadge from '@/components/StatusBadge.vue';
import { api } from '@/lib/api';import { errorMessage } from '@/lib/errors';import { fundingLabel, shortDate, yuan } from '@/lib/format';import type { BudgetItem, BudgetPeriod, FundingAssessment, Offer, OfferQuote } from '@/lib/types';
const period=ref<BudgetPeriod|null>(null),item=ref<BudgetItem|null>(null),offers=ref<Offer[]>([]),selected=ref<Offer|null>(null),quote=ref<OfferQuote|null>(null),assessment=ref<FundingAssessment|null>(null);const loading=ref(true),saving=ref(false),error=ref('');
const difference=computed(()=>quote.value&&item.value?quote.value.priceMinor-item.value.userEstimatedAmountMinor:null);
useLoad(async o=>{try{period.value=(await api.period(o.periodId??'')).data;item.value=period.value.items.find(v=>v.itemId===o.itemId)??null;if(!item.value)throw new Error('未找到计划项目。');offers.value=(await api.offers(item.value.plannedOn,item.value.categoryCode)).data.items;}catch(e){error.value=errorMessage(e);}finally{loading.value=false;}});
const checking = ref(false);
let selectionSequence = 0;
onBeforeUnmount(() => { selectionSequence++; });
const assessmentGap = computed(() => !assessment.value || assessment.value.status === 'unknown'
  ? '尚无法确定' : yuan(assessment.value.shortfallMinor));
const canCreate = computed(() => Boolean(!checking.value && selected.value && quote.value && assessment.value
  && assessment.value.status === 'allowed' && selected.value.id === quote.value.catalogItemId
  && assessment.value.quoteId === quote.value.quoteId && assessment.value.budgetItemId === item.value?.itemId
  && assessment.value.periodId === period.value?.period.periodId));

async function choose(value: Offer) {
  if (saving.value || !period.value || !item.value) return;
  const sequence = ++selectionSequence;
  const currentPeriod = period.value, currentItem = item.value;
  selected.value = value; quote.value = null; assessment.value = null; error.value = ''; checking.value = true;
  try {
    const nextQuote = (await api.offerQuote(value.id, currentItem.plannedOn)).data;
    if (sequence !== selectionSequence) return;
    const nextAssessment = (await api.assessPurchase({ periodId: currentPeriod.period.periodId,
      budgetItemId: currentItem.itemId, quoteId: nextQuote.quoteId,
      expectedFinancialVersion: currentPeriod.basis.financialVersion,
      expectedPeriodVersion: currentPeriod.basis.periodVersion,
      expectedQuoteVersion: nextQuote.quoteVersion, mode: 'preview' })).data;
    if (sequence !== selectionSequence) return;
    quote.value = nextQuote; assessment.value = nextAssessment;
  } catch (reason) {
    if (sequence === selectionSequence) error.value = errorMessage(reason);
  } finally {
    if (sequence === selectionSequence) checking.value = false;
  }
}
async function createIntent() {
  if (!canCreate.value || !period.value || !item.value || !quote.value || !assessment.value || saving.value) return;
  saving.value = true;
  try {
    const result = await api.createPurchaseIntent({ periodId: period.value.period.periodId,
      budgetItemId: item.value.itemId, quoteId: quote.value.quoteId, assessmentId: assessment.value.assessmentId,
      expectedFinancialVersion: assessment.value.financialVersion,
      expectedPeriodVersion: assessment.value.periodVersion, expectedQuoteVersion: assessment.value.quoteVersion });
    await Taro.redirectTo({ url: `/pages/purchase/detail?id=${String(result.data.purchaseIntentId ?? '')}` });
  } catch (reason) { error.value = errorMessage(reason); }
  finally { saving.value = false; }
}
</script>
<template><PageShell title="选择候选" subtitle="报价与计划估价分开核对" compact><template #hero><button class="back" @tap="Taro.navigateBack()">‹</button></template><StatePanel v-if="loading" title="正在读取候选"/><StatePanel v-else-if="error&&!offers.length" title="候选暂时不可用" :detail="error" tone="error"/><template v-else><SectionCard v-if="item"><text class="title">{{item.title}}</text><FactRow label="计划日期" :value="shortDate(item.plannedOn)"/><FactRow label="原计划估价" :value="yuan(item.userEstimatedAmountMinor)"/></SectionCard><view class="list"><SectionCard v-for="offer in offers" :key="offer.id" class="offer"><view class="row-between"><view><text class="title">{{offer.name}}</text><text class="muted">{{offer.description}}</text></view><text class="price">{{yuan(offer.displayPriceMinor)}}</text></view><text class="rule">{{offer.ruleLabel}}</text><view class="offer-actions"><button class="text-button" @tap="Taro.navigateTo({url:`/pages/catalog/detail?id=${offer.id}&periodId=${period?.period.periodId}&itemId=${item?.itemId}`})">查看详情</button><button class="secondary-button" :disabled="saving" :loading="checking&&selected?.id===offer.id" @tap="choose(offer)">核对报价</button></view></SectionCard></view><StatePanel v-if="!offers.length" title="该日期暂无可用候选" detail="可以返回修改计划日期后重试。"/><StatePanel v-if="checking" title="正在核对所选商品" detail="报价与资金评估完成后再确认。"/><SectionCard v-if="selected&&quote&&assessment" class="decision"><view class="row-between"><text class="title">确认前核对</text><StatusBadge :label="fundingLabel(assessment.status)" :tone="assessment.status==='allowed'?'success':'warning'"/></view><FactRow label="所选商品" :value="selected.name"/><FactRow label="服务日期" :value="shortDate(quote.serviceOn??item?.plannedOn)"/><FactRow label="实时报价" :value="yuan(quote.priceMinor)" emphasis/><FactRow label="相对估价变化" :value="difference===null?'—':`${difference>=0?'+':''}${yuan(difference)}`"/><FactRow label="报价有效至" :value="shortDate(quote.validUntil)"/><FactRow label="预计缺口" :value="assessmentGap"/><button class="primary-button full" :disabled="!canCreate||saving" :loading="saving" @tap="createIntent">建立待确认意图</button><view v-if="assessment.status!=='allowed'" class="recovery"><button class="secondary-button" @tap="Taro.navigateTo({url:`/pages/impact/detail?periodId=${period?.period.periodId}`})">查看资金影响</button><button class="secondary-button" @tap="Taro.switchTab({url:'/pages/ai/index'})">问问行止</button></view></SectionCard><view v-if="error" class="notice notice--error err">{{error}}</view></template></PageShell></template>
<style lang="scss">@use '../../styles/tokens' as *;.back{position:absolute;right:28px;top:calc(34px + env(safe-area-inset-top));width:64px;height:64px;border-radius:50%;font-size:44px}.list{display:grid;gap:20px;margin-top:24px}.title,.muted{display:block}.title{font-size:34px;font-weight:730;line-height:1.4}.muted{max-width:500px;margin-top:10px;color:$text-secondary;font-size:27px;line-height:1.55}.price{font-size:38px;font-weight:760;white-space:nowrap}.rule{display:block;margin-top:18px;padding:16px 18px;color:$text-secondary;background:$soft-surface;border-radius:18px;font-size:26px;line-height:1.5}.offer{border-left:7px solid transparent}.offer-actions,.recovery{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:22px}.offer-actions button,.recovery button{width:100%}.text-button{min-height:88px;color:$brand-primary;background:#fff;border:2px solid $border;border-radius:20px;font-size:28px;font-weight:650}.decision{margin-top:24px;background:linear-gradient(145deg,$surface-tint,#fff);border-color:#BFD8CA}.full{width:100%;margin-top:28px}.err{margin-top:20px;font-size:28px}@media screen and (max-width:360px){.row-between{align-items:flex-start}.offer-actions,.recovery{grid-template-columns:1fr}.price{font-size:34px}}</style>
