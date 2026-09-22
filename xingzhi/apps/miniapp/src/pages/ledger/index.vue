<script setup lang="ts">
import { computed, ref } from 'vue';
import Taro, { useDidShow } from '@tarojs/taro';
import BottomSheet from '@/components/BottomSheet.vue';
import FactRow from '@/components/FactRow.vue';
import PageShell from '@/components/PageShell.vue';
import SectionCard from '@/components/SectionCard.vue';
import StatePanel from '@/components/StatePanel.vue';
import { useOverview } from '@/composables/useOverview';
import { categoryLabel, clockTime, dateKey, shortDate, yuan } from '@/lib/format';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import type { FinanceAccountFacts, LedgerEntry } from '@/lib/types';

type Obligation = FinanceAccountFacts['obligations']['items'][number];
const overview = useOverview();
const filter = ref<'all' | 'outflow' | 'inflow' | 'refund'>('all');
const searchOpen = ref(false);
const query = ref('');
const obligationsOpen = ref(true);
const statsOpen = ref(false);
const selectedEntry = ref<LedgerEntry | null>(null);
const selectedObligation = ref<Obligation | null>(null);
const categoryOpen = ref(false);
const categoryEntryId = ref('');
const categorySaving = ref(false);
const categoryError = ref('');
const pendingCategory = ref('other');
const categories = ['food','housing','transport','utilities','health','education','shopping','entertainment','repayment','income','refund','purchase','unexpected','other'];
useDidShow(() => { void overview.load(); });

const monthKey = computed(() => overview.currentPeriod.value?.period.monthStart.slice(0, 7) ?? new Date().toISOString().slice(0, 7));
const monthEntries = computed(() => (overview.primaryAccount.value?.ledger ?? []).filter(entry => dateKey(entry.occurredAt).startsWith(monthKey.value)));
const entries = computed(() => monthEntries.value.filter(entry => {
  const filterMatches = filter.value === 'all'
    || filter.value === 'refund' && (entry.displayCategory === 'refund' || entry.category === 'refund')
    || filter.value !== 'refund' && entry.direction === filter.value;
  const keyword = query.value.trim().toLowerCase();
  const searchMatches = !keyword || categoryLabel(entry.displayCategory).toLowerCase().includes(keyword) || (entry.category ?? '').toLowerCase().includes(keyword);
  return filterMatches && searchMatches;
}));
const groups = computed(() => {
  const result = new Map<string, LedgerEntry[]>();
  for (const entry of entries.value) {
    const key = dateKey(entry.occurredAt);
    result.set(key, [...(result.get(key) ?? []), entry]);
  }
  return [...result.entries()].map(([date, items]) => ({ date, items }));
});
const posted = computed(() => monthEntries.value.filter(entry => entry.status === 'posted'));
const income = computed(() => posted.value.filter(entry => entry.direction === 'inflow').reduce((sum, entry) => sum + entry.amountMinor, 0));
const expense = computed(() => posted.value.filter(entry => entry.direction === 'outflow').reduce((sum, entry) => sum + entry.amountMinor, 0));
const refund = computed(() => posted.value.filter(entry => entry.displayCategory === 'refund' || entry.category === 'refund').reduce((sum, entry) => sum + entry.amountMinor, 0));
const obligations = computed(() => overview.primaryAccount.value?.obligations.items.filter(item => !['paid', 'cancelled'].includes(item.status)) ?? []);

function dayHeading(value: string) {
  const today = dateKey(new Date().toISOString());
  return value === today ? '今天' : shortDate(value);
}
function openEntry(entry: LedgerEntry) { selectedEntry.value = entry; }
function openObligation(item: Obligation) { selectedObligation.value = item; }
function toggleSearch() { searchOpen.value = !searchOpen.value; if (!searchOpen.value) query.value = ''; }
function beginCategory(){if(!selectedEntry.value)return;categoryEntryId.value=selectedEntry.value.entryId;pendingCategory.value=selectedEntry.value.displayCategory??selectedEntry.value.category??'other';selectedEntry.value=null;categoryError.value='';categoryOpen.value=true;}
async function confirmCategory(){if(!categoryEntryId.value||categorySaving.value)return;categorySaving.value=true;categoryError.value='';try{await api.changeLedgerCategory(categoryEntryId.value,pendingCategory.value);categoryOpen.value=false;await overview.load();}catch(reason){categoryError.value=errorMessage(reason);}finally{categorySaving.value=false;}}
</script>

<template>
  <PageShell title="账目" subtitle="看清已经发生的钱去了哪里">
    <template #hero><button class="search-button" aria-label="搜索账目" @tap="toggleSearch">⌕</button></template>
    <StatePanel v-if="overview.loading.value" title="正在读取账目事实" detail="预计收入和待到账退款不会混入已入账金额。" />
    <StatePanel v-else-if="overview.error.value" title="账目暂时不可用" :detail="overview.error.value" tone="error"><button class="secondary-button retry" @tap="overview.load">重新加载</button></StatePanel>
    <template v-else>
      <view v-if="searchOpen" class="search-box"><input v-model="query" focus placeholder="搜索账目分类"/><button v-if="query" @tap="query=''">清除</button></view>
      <SectionCard class="month-card" @tap="statsOpen=true"><view class="row-between"><view><text class="month-title">{{ monthKey.replace('-', '年') }}月</text><text class="month-subtitle">仅统计已入账事实</text></view><text class="month-arrow">›</text></view><view class="ledger-metrics"><view><text>支出</text><b>{{ yuan(expense) }}</b></view><view><text>收入</text><b>{{ yuan(income) }}</b></view><view><text>已确认退款</text><b>{{ yuan(refund) }}</b></view></view></SectionCard>
      <scroll-view class="chips" scroll-x><button v-for="item in [{k:'all',n:'全部'},{k:'outflow',n:'支出'},{k:'inflow',n:'收入'},{k:'refund',n:'退款'}]" :key="item.k" class="chip" :class="{'chip--active':filter===item.k}" @tap="filter=item.k as typeof filter">{{ item.n }}</button></scroll-view>

      <view v-if="obligations.length" class="future-section">
        <button class="future-heading" @tap="obligationsOpen=!obligationsOpen"><view><text>未来需要留意</text><text>{{ obligations.length }} 项义务尚待发生或核验</text></view><text :class="{'future-heading__arrow--open':obligationsOpen}">⌄</text></button>
        <view v-if="obligationsOpen" class="future-list"><view v-for="item in obligations" :key="item.id" class="future-row" @tap="openObligation(item)"><view><text>{{ shortDate(item.dueOn) }} · {{ item.label }}</text><text>未来义务 · {{ item.status==='overdue'?'已逾期':'尚未发生' }}</text></view><text class="amount">{{ yuan(item.remainingDueMinor??item.amountDueMinor) }}</text></view></view>
      </view>

      <template v-if="groups.length"><view v-for="group in groups" :key="group.date" class="date-group"><view class="date-heading"><text>{{ dayHeading(group.date) }}</text><text>{{ group.items.length }} 笔</text></view><SectionCard class="entry-list"><view v-for="entry in group.items" :key="entry.entryId" class="entry-row" @tap="openEntry(entry)"><view class="entry-icon" :class="{'entry-icon--in':entry.direction==='inflow'}">{{ entry.direction==='inflow'?'↗':'↘' }}</view><view class="entry-copy"><text>{{ categoryLabel(entry.displayCategory) }}</text><text>{{ clockTime(entry.occurredAt) }} · {{ entry.status==='posted'?'已入账':entry.status==='pending'?'待核验':'已冲正' }}</text></view><view class="entry-end"><text class="entry-amount amount" :class="{'entry-amount--in':entry.direction==='inflow'}">{{ entry.direction==='inflow'?'+':'-' }}{{ yuan(entry.amountMinor) }}</text><text>›</text></view></view></SectionCard></view><text class="list-end">已加载本月全部账目</text></template>
      <StatePanel v-else title="当前条件下没有账目" detail="未来计划、预计工资和待到账退款不会混入已发生账目。" />
    </template>
  </PageShell>

  <BottomSheet above-tab-bar :model-value="statsOpen" title="本月统计" description="仅汇总当前账户本月已入账的资金事实。" primary-text="查看月度复盘" @update:model-value="statsOpen=$event" @primary="statsOpen=false;overview.currentPeriod.value&&Taro.navigateTo({url:`/pages/review/index?periodId=${overview.currentPeriod.value.period.periodId}`})"><FactRow label="本月支出" :value="yuan(expense)" emphasis/><FactRow label="本月收入" :value="yuan(income)"/><FactRow label="退款已到账" :value="yuan(refund)"/><FactRow label="账目数量" :value="`${posted.length} 笔`"/></BottomSheet>
  <BottomSheet above-tab-bar :model-value="selectedEntry!==null" :title="categoryLabel(selectedEntry?.displayCategory??null)" description="这是一笔账户事实记录。" primary-text="修改分类" @update:model-value="value=>{if(!value)selectedEntry=null}" @primary="beginCategory"><template v-if="selectedEntry"><view class="detail-amount amount" :class="{'detail-amount--in':selectedEntry.direction==='inflow'}">{{ selectedEntry.direction==='inflow'?'+':'-' }}{{ yuan(selectedEntry.amountMinor) }}</view><FactRow label="状态" :value="selectedEntry.status==='posted'?'已入账':selectedEntry.status==='pending'?'待核验':'已冲正'"/><FactRow label="分类" :value="categoryLabel(selectedEntry.displayCategory)"/><FactRow label="发生时间" :value="`${shortDate(selectedEntry.occurredAt)} ${clockTime(selectedEntry.occurredAt)}`"/><FactRow label="关联订单" :value="selectedEntry.orderId?'有关联订单':'无'"/><FactRow label="账户" :value="overview.primaryAccount.value?.account.displayName??'—'"/></template></BottomSheet>
  <BottomSheet above-tab-bar :model-value="categoryOpen" title="修改展示分类" description="只调整你看到的分类，不改写银行原始流水。" primary-text="确认修改" @update:model-value="categoryOpen=$event" @primary="confirmCategory"><view v-if="categoryError" class="notice notice--error category-error">{{categoryError}}</view><view class="category-grid"><button v-for="value in categories" :key="value" :class="{'category--active':pendingCategory===value}" @tap="pendingCategory=value">{{categoryLabel(value)}}</button></view></BottomSheet>
  <BottomSheet above-tab-bar :model-value="selectedObligation!==null" :title="selectedObligation?.label??'未来义务'" description="尚未发生的义务不会提前计入账目。" @update:model-value="value=>{if(!value)selectedObligation=null}"><template v-if="selectedObligation"><FactRow label="待处理金额" :value="yuan(selectedObligation.remainingDueMinor??selectedObligation.amountDueMinor)" emphasis/><FactRow label="预计日期" :value="shortDate(selectedObligation.dueOn)"/><FactRow label="状态" :value="selectedObligation.status==='overdue'?'已逾期':'尚未发生'"/></template></BottomSheet>
</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.retry{margin:24px auto 0}.search-button{position:absolute;z-index:4;top:calc(40px + env(safe-area-inset-top));right:30px;display:flex;width:66px;height:66px;align-items:center;justify-content:center;padding:0;color:$brand-deep;background:rgba(255,255,255,.66);border:1px solid rgba(255,255,255,.86);border-radius:50%;font-size:38px;line-height:1;box-shadow:$shadow-card}.search-box{display:flex;align-items:center;gap:14px;margin-bottom:16px;padding:16px 22px;background:#fff;border:1px solid $border;border-radius:18px}.search-box input{flex:1;height:52px;font-size:24px}.search-box button{flex:0 0 auto;width:auto;color:$brand-primary;font-size:22px;white-space:nowrap}.month-title,.month-subtitle{display:block}.month-title{font-size:29px;font-weight:720}.month-subtitle{margin-top:6px;color:$text-secondary;font-size:20px}.month-arrow{color:$text-tertiary;font-size:38px}.ledger-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:26px}.ledger-metrics view{min-width:0;padding-top:18px;border-top:1px solid $border}.ledger-metrics text,.ledger-metrics b{display:block}.ledger-metrics text{color:$text-secondary;font-size:20px;line-height:1.35}.ledger-metrics b{margin-top:8px;font-size:27px;line-height:1.2;white-space:nowrap}.chips{margin:22px 0;white-space:nowrap}.chip{display:inline-flex;width:auto;align-items:center;justify-content:center;margin-right:12px;padding:16px 30px;color:$text-secondary;background:#E9EFEC;border-radius:999px;font-size:23px;line-height:1.2;white-space:nowrap}.chip--active{color:#fff;background:$brand-primary}
.future-section{margin-bottom:22px;overflow:hidden;background:#FFF9F0;border:1px solid #EAD3B0;border-radius:18px}.future-heading{display:flex;width:100%;align-items:center;justify-content:space-between;padding:20px 24px;text-align:left}.future-heading text{display:block}.future-heading view text:first-child{color:#785528;font-size:24px;font-weight:680}.future-heading view text+text{margin-top:5px;color:#9A7443;font-size:20px}.future-heading>text{color:#9A7443;font-size:30px;transition:transform .2s}.future-heading__arrow--open{transform:rotate(180deg)}.future-list{border-top:1px solid #EAD3B0}.future-row{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:20px 24px}.future-row+.future-row{border-top:1px solid #EFDFC5}.future-row text{display:block}.future-row view text:first-child{font-size:23px;font-weight:620}.future-row view text+text{margin-top:5px;color:$text-secondary;font-size:19px}.future-row>.amount{font-weight:680}
.date-group+.date-group{margin-top:22px}.date-heading{display:flex;align-items:center;gap:10px;margin:0 5px 10px}.date-heading text:first-child{font-size:25px;font-weight:680}.date-heading text+text{color:$text-tertiary;font-size:20px}.entry-list{padding-block:6px}.entry-row{display:flex;align-items:center;gap:16px;padding:20px 0}.entry-row+.entry-row{border-top:1px solid $border}.entry-icon{display:grid;width:56px;height:56px;place-items:center;color:#9A6728;background:$warning-surface;border-radius:50%;font-size:27px}.entry-icon--in{color:$success;background:$success-surface}.entry-copy{flex:1}.entry-copy text{display:block;font-size:24px;font-weight:620}.entry-copy text+text{margin-top:5px;color:$text-secondary;font-size:20px;font-weight:400}.entry-end{display:flex;align-items:center;gap:10px}.entry-end>text:last-child{color:$text-tertiary;font-size:30px}.entry-amount{font-weight:700}.entry-amount--in,.detail-amount--in{color:$success}.list-end{display:block;padding:25px 0 4px;color:$text-tertiary;font-size:20px;text-align:center}.detail-amount{margin-bottom:20px;font-size:44px;font-weight:760}.category-error{margin-bottom:14px}.category-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.category-grid button{min-height:66px;padding:8px;color:$text-secondary;background:$soft-surface;border:1px solid $border;border-radius:14px;font-size:21px}.category-grid .category--active{color:$brand-primary;background:$surface-tint;border-color:#AFCBBB}
@media screen and (max-width:360px){.ledger-metrics{grid-template-columns:1fr;gap:0}.ledger-metrics view{display:flex;align-items:center;justify-content:space-between;gap:14px}.ledger-metrics b{margin-top:0;white-space:normal}.future-row,.entry-row{align-items:flex-start}.entry-copy{min-width:0}.entry-end{flex:0 0 auto}.category-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.search-box{padding:14px 18px}}
</style>
