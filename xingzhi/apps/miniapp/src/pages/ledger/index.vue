<script setup lang="ts">
import { computed, ref } from 'vue';
import Taro, { useDidShow } from '@tarojs/taro';
import BottomSheet from '@/components/BottomSheet.vue';
import FactRow from '@/components/FactRow.vue';
import PageShell from '@/components/PageShell.vue';
import StatePanel from '@/components/StatePanel.vue';
import { useOverview } from '@/composables/useOverview';
import { openAiWithQuestion } from '@/lib/ai-entry';
import { categoryLabel, clockTime, dateKey, shortDate, yuan } from '@/lib/format';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import type { BudgetLedgerLinks, FinanceAccountFacts, LedgerEntry } from '@/lib/types';

type Obligation = FinanceAccountFacts['obligations']['items'][number];
const overview = useOverview();
const filter = ref<'all' | 'outflow' | 'inflow' | 'refund' | 'obligation'>('all');
const selectedMonth = ref(dateKey(new Date().toISOString()).slice(0, 7));
const searchOpen = ref(false);
const query = ref('');
const obligationsOpen = ref(true);
const collapsedDates = ref<string[]>([]);
const statsOpen = ref(false);
const selectedEntry = ref<LedgerEntry | null>(null);
const linkEntry = ref<LedgerEntry | null>(null);
const linkData = ref<BudgetLedgerLinks | null>(null);
const linkOpen = ref(false);
const linkSaving = ref(false);
const linkError = ref('');
const pendingItemId = ref('');
const coverageYuan = ref('');
const selectedObligation = ref<Obligation | null>(null);
const categoryOpen = ref(false);
const categoryEntryId = ref('');
const categorySaving = ref(false);
const categoryError = ref('');
const pendingCategory = ref('other');
const categories = ['food','housing','transport','utilities','health','education','shopping','entertainment','repayment','income','refund','purchase','unexpected','other'];
useDidShow(() => { void overview.load(); });

const monthKey = computed(() => selectedMonth.value);
const selectedPeriod = computed(() => overview.periods.value.find(value =>
  value.period.accountId === overview.primaryAccount.value?.account.accountId
  && value.period.monthStart === `${monthKey.value}-01`) ?? null);
const aiContextPeriod = computed(() => selectedPeriod.value ?? overview.periods.value.find(value =>
  value.period.accountId === overview.primaryAccount.value?.account.accountId) ?? null);
const monthEntries = computed(() => (overview.primaryAccount.value?.ledger ?? []).filter(entry => dateKey(entry.occurredAt).startsWith(monthKey.value)));
const entries = computed(() => monthEntries.value.filter(entry => {
  const filterMatches = filter.value === 'all'
    || filter.value === 'refund' && entry.isRefund
    || filter.value !== 'refund' && entry.direction === filter.value;
  const keyword = query.value.trim().toLowerCase();
  const searchMatches = !keyword || categoryLabel(entry.displayCategory).toLowerCase().includes(keyword)
    || (entry.category ?? '').toLowerCase().includes(keyword) || (entry.summary ?? '').toLowerCase().includes(keyword);
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
const refund = computed(() => posted.value.filter(entry => entry.isRefund).reduce((sum, entry) => sum + entry.amountMinor, 0));
const obligations = computed(() => (overview.primaryAccount.value?.obligations.items ?? []).filter(item =>
  !['paid', 'cancelled'].includes(item.status) && item.dueOn.startsWith(monthKey.value)
  && (!query.value.trim() || item.label.toLowerCase().includes(query.value.trim().toLowerCase()))));
const categoryTotals = computed(() => {
  const totals = new Map<string, { category: string | null; direction: 'inflow' | 'outflow'; amountMinor: number; count: number }>();
  for (const entry of posted.value) {
    const key = `${entry.direction}:${entry.displayCategory ?? 'other'}`;
    const current = totals.get(key) ?? { category: entry.displayCategory, direction: entry.direction, amountMinor: 0, count: 0 };
    current.amountMinor += entry.amountMinor;
    current.count += 1;
    totals.set(key, current);
  }
  return [...totals.values()].sort((a, b) => a.direction.localeCompare(b.direction) || b.amountMinor - a.amountMinor);
});
function categoryIcon(value: string | null, refundEntry = false) {
  if (refundEntry) return '退';
  return ({ food: '食', housing: '住', transport: '行', utilities: '缴', health: '医', education: '学',
    shopping: '购', entertainment: '乐', repayment: '还', income: '收', refund: '退', purchase: '购',
    unexpected: '急', other: '记' } as Record<string, string>)[value ?? 'other'] ?? '记';
}
function selectMonth(value: string) { selectedMonth.value = value.slice(0, 7); }
function askAboutMonth() {
  if (!aiContextPeriod.value) return;
  void openAiWithQuestion({ periodId: aiContextPeriod.value.period.periodId, ledgerMonth: monthKey.value,
    question: `请只根据我${monthKey.value.replace('-', '年')}月的已入账月度汇总，解释支出、总流入与其中退款；不要把预计收入或待到账退款当作已入账。` });
}
function toggleDate(value: string) { collapsedDates.value = collapsedDates.value.includes(value)
  ? collapsedDates.value.filter(date => date !== value) : [...collapsedDates.value, value]; }

function dayHeading(value: string) {
  const today = dateKey(new Date().toISOString());
  return value === today ? '今天' : shortDate(value);
}
function openEntry(entry: LedgerEntry) { selectedEntry.value = entry; }
const eligibleItems = computed(() => (linkData.value?.items ?? []).filter(item => item.eligible
  && item.remainingMinor > 0));
function canLink(entry: LedgerEntry) { return entry.status === 'posted' && entry.direction === 'outflow'
  && !entry.orderId && !entry.linkedPlan && !!selectedPeriod.value
  && selectedPeriod.value.period.status === 'active'
  && overview.primaryAccount.value?.account.status === 'linked'; }
async function openLinkPicker(entry: LedgerEntry) {
  const period = selectedPeriod.value;
  if (!period || !canLink(entry)) return;
  linkEntry.value = entry; selectedEntry.value = null; linkOpen.value = true;
  linkData.value = null; linkError.value = ''; pendingItemId.value = ''; coverageYuan.value = '';
  try { linkData.value = (await api.budgetLedgerLinks(period.period.periodId)).data; }
  catch (reason) { linkError.value = errorMessage(reason); }
}
function chooseLinkItem(itemId: string) {
  pendingItemId.value = itemId;
  const item = eligibleItems.value.find(value => value.itemId === itemId);
  coverageYuan.value = item && linkEntry.value
    ? (Math.min(item.remainingMinor, linkEntry.value.amountMinor) / 100).toFixed(2) : '';
}
async function confirmLink() {
  if (linkSaving.value) return;
  if (!linkEntry.value || !linkData.value) { linkError.value = '计划信息尚未加载，请稍后再试。'; return; }
  if (!pendingItemId.value) { linkError.value = '请先选择要关联的计划。'; return; }
  const amount = Number(coverageYuan.value.trim());
  const coveredMinor = Math.round(amount * 100);
  const item = eligibleItems.value.find(value => value.itemId === pendingItemId.value);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(coveredMinor)
    || Math.abs(amount * 100 - coveredMinor) > 0.00001 || !item
    || coveredMinor > item.remainingMinor || coveredMinor > linkEntry.value.amountMinor) {
    linkError.value = '覆盖金额须大于零，且不能超过本笔支出或计划剩余金额。'; return;
  }
  linkSaving.value = true; linkError.value = '';
  try {
    await api.linkBudgetLedger(linkData.value.periodId, { entryId: linkEntry.value.entryId,
      itemId: pendingItemId.value, coveredMinor,
      expectedFinancialVersion: linkData.value.financialVersion,
      expectedPeriodVersion: linkData.value.periodVersion, confirmedByUser: true });
    linkOpen.value = false; linkEntry.value = null; await overview.load();
  } catch (reason) { linkError.value = errorMessage(reason); }
  finally { linkSaving.value = false; }
}
async function unlinkSelected() {
  const linked = selectedEntry.value?.linkedPlan;
  if (!linked || linkSaving.value) return;
  const confirmation = await Taro.showModal({ title: '解除计划关联',
    content: '只解除计划与这笔已入账支出的对应关系，不删除流水；未发生的计划金额会重新计入资金预测。',
    confirmText: '确认解除' });
  if (!confirmation.confirm) return;
  linkSaving.value = true; linkError.value = '';
  try {
    const basis = (await api.budgetLedgerLinks(linked.periodId)).data;
    await api.unlinkBudgetLedger(linked.periodId, linked.linkId, basis.periodVersion);
    selectedEntry.value = null; await overview.load();
  } catch (reason) { linkError.value = errorMessage(reason); }
  finally { linkSaving.value = false; }
}
function openLinkedPlan() { const linked = selectedEntry.value?.linkedPlan; if (!linked) return;
  selectedEntry.value = null; void Taro.navigateTo({ url: `/pages/item/detail?periodId=${linked.periodId}&itemId=${linked.itemId}` }); }
function openLinkedOrder() { const id = selectedEntry.value?.orderId; if (!id) return;
  selectedEntry.value = null; void Taro.navigateTo({ url: `/pages/order/detail?id=${id}` }); }
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
      <view v-if="searchOpen" class="search-box"><input v-model="query" focus placeholder="搜索账目名称或分类"/><button v-if="query" @tap="query=''">清除</button></view>
      <picker class="month-picker" mode="date" fields="month" start="2000-01-01" end="2100-12-01" :value="`${monthKey}-01`" @change="selectMonth(String(($event.detail as any).value))"><view>账目月份：{{monthKey.replace('-', '年')}}月 <text>选择月份 ›</text></view></picker>
      <view class="ledger-month-card" @tap="statsOpen=true"><view class="ledger-month-card__orb"/><view class="row-between"><view><text class="month-title">{{ monthKey.replace('-', '年') }}月账本</text><text class="month-subtitle">钱去了哪里，一眼看明白</text></view><text class="month-arrow">›</text></view><view class="ledger-metrics"><view><text>本月花了</text><b>{{ yuan(expense) }}</b></view><view><text>一共进账</text><b>{{ yuan(income) }}</b></view><view><text>退款回来</text><b>{{ yuan(refund) }}</b></view></view></view>
      <button v-if="aiContextPeriod" class="month-ai-button" @tap="askAboutMonth">就本月已入账汇总问行止 ›</button>
      <scroll-view class="chips" scroll-x><button v-for="item in [{k:'all',n:'全部'},{k:'outflow',n:'支出'},{k:'inflow',n:'流入'},{k:'refund',n:'退款'},{k:'obligation',n:'未来义务'}]" :key="item.k" class="chip" :class="{'chip--active':filter===item.k}" @tap="filter=item.k as typeof filter">{{ item.n }}</button></scroll-view>

      <view v-if="(filter==='all'&&obligations.length)||filter==='obligation'" class="future-section">
        <button class="future-heading" @tap="obligationsOpen=!obligationsOpen"><view><text>未来需要留意</text><text>{{ obligations.length }} 项义务尚待发生或核验</text></view><text :class="{'future-heading__arrow--open':obligationsOpen}">⌄</text></button>
        <view v-if="obligationsOpen" class="future-list"><view v-for="item in obligations" :key="item.id" class="future-row" @tap="openObligation(item)"><view><text>{{ shortDate(item.dueOn) }} · {{ item.label }}</text><text>未来义务 · {{ item.status==='overdue'?'已逾期':item.status==='unknown'?'状态待核验':'尚未发生' }}</text></view><text class="amount">{{ item.remainingDueMinor===null||item.remainingDueMinor===undefined?'剩余待核验':yuan(item.remainingDueMinor) }}</text></view></view>
        <view v-if="obligationsOpen&&!obligations.length" class="future-empty">该月份没有待发生或待核验的义务。</view>
      </view>

      <template v-if="filter!=='obligation'&&groups.length"><view v-for="group in groups" :key="group.date" class="date-group"><button class="date-heading" :aria-expanded="!collapsedDates.includes(group.date)" @tap="toggleDate(group.date)"><text>{{ dayHeading(group.date) }}</text><text>{{ group.items.length }} 笔 · {{collapsedDates.includes(group.date)?'展开':'收起'}} ⌄</text></button><view v-if="!collapsedDates.includes(group.date)" class="ledger-entry-card"><view v-for="entry in group.items" :key="entry.entryId" class="entry-row" @tap="openEntry(entry)"><view class="entry-icon" :class="{'entry-icon--in':entry.direction==='inflow'}">{{ categoryIcon(entry.displayCategory,entry.isRefund) }}</view><view class="entry-copy"><text>{{ entry.summary || categoryLabel(entry.displayCategory) }}</text><text>{{ categoryLabel(entry.displayCategory) }} · {{ clockTime(entry.occurredAt) }}</text><text class="entry-copy__status">{{ entry.status==='posted'?'钱已经记好啦':entry.status==='pending'?'正在确认这笔钱':'这笔已冲正' }}{{entry.linkedPlan?` · 已关联${entry.linkedPlan.title}`:''}}</text></view><view class="entry-end"><text class="entry-amount amount" :class="{'entry-amount--in':entry.direction==='inflow'}">{{ entry.direction==='inflow'?'+':'-' }}{{ yuan(entry.amountMinor) }}</text><text>›</text></view></view></view></view><text class="list-end">这个月的账目都在这里啦</text></template>
      <StatePanel v-else-if="filter!=='obligation'" title="当前条件下没有账目" detail="该月份没有符合条件的已发生流水；预计工资和待到账退款不混入统计。" />
    </template>
  </PageShell>

  <BottomSheet above-tab-bar :model-value="statsOpen" :title="`${monthKey.replace('-', '年')}月统计`" description="仅汇总所选账户与月份的已入账事实；退款已包含在总流入中。" :primary-text="selectedPeriod?'查看月度复盘':''" @update:model-value="statsOpen=$event" @primary="statsOpen=false;selectedPeriod&&Taro.navigateTo({url:`/pages/review/index?periodId=${selectedPeriod.period.periodId}`})"><FactRow label="支出" :value="yuan(expense)" emphasis/><FactRow label="总流入（含退款）" :value="yuan(income)"/><FactRow label="其中退款" :value="yuan(refund)"/><FactRow label="已入账笔数" :value="`${posted.length} 笔`"/><view class="stats-boundary">分类汇总按展示分类统计，修改分类不改变原流水金额或退款身份。未来义务不计入此处。</view><view v-if="categoryTotals.length" class="category-totals"><view v-for="item in categoryTotals" :key="`${item.direction}-${item.category}`" class="category-total"><text>{{item.direction==='outflow'?'支出':'流入'}} · {{categoryLabel(item.category)}}（{{item.count}} 笔）</text><b class="amount">{{yuan(item.amountMinor)}}</b></view></view><StatePanel v-else title="该月暂无已入账分类"/></BottomSheet>
  <BottomSheet expanded above-tab-bar :model-value="selectedEntry!==null" title="这笔钱的小记" :description="selectedEntry?.summary || categoryLabel(selectedEntry?.displayCategory??null)" primary-text="换个分类" @update:model-value="value=>{if(!value)selectedEntry=null}" @primary="beginCategory"><template v-if="selectedEntry"><view class="entry-detail-hero"><view class="entry-detail-hero__icon" :class="{'entry-detail-hero__icon--in':selectedEntry.direction==='inflow'}">{{categoryIcon(selectedEntry.displayCategory,selectedEntry.isRefund)}}</view><text class="detail-amount amount" :class="{'detail-amount--in':selectedEntry.direction==='inflow'}">{{ selectedEntry.direction==='inflow'?'+':'-' }}{{ yuan(selectedEntry.amountMinor) }}</text><text class="entry-detail-hero__mood">{{selectedEntry.direction==='inflow'?'收入到账，安心一点':'已经花掉，记得明明白白'}}</text></view><view class="entry-detail-grid"><view><text>现在状态</text><b>{{selectedEntry.status==='posted'?'已记到账本':selectedEntry.status==='pending'?'还在确认':'已经冲正'}}</b></view><view><text>花在哪类</text><b>{{categoryLabel(selectedEntry.displayCategory)}}</b></view><view><text>什么时候</text><b>{{shortDate(selectedEntry.occurredAt)}} {{clockTime(selectedEntry.occurredAt)}}</b></view><view><text>来自哪里</text><b>{{overview.primaryAccount.value?.account.displayName??'—'}}</b></view><view class="entry-detail-grid__wide"><text>相关安排</text><b>{{selectedEntry.linkedPlan?`${selectedEntry.linkedPlan.title} · 覆盖 ${yuan(selectedEntry.linkedPlan.coveredMinor)}`:selectedEntry.orderId?'关联了一笔订单':'暂时没有关联计划'}}</b></view></view><view v-if="linkError" class="notice notice--error">{{linkError}}</view><button v-if="selectedEntry.orderId" class="secondary-button linked-order" @tap="openLinkedOrder">看看关联订单</button><button v-if="selectedEntry.linkedPlan" class="secondary-button linked-order" @tap="openLinkedPlan">看看关联计划</button><button v-if="selectedEntry.linkedPlan&&selectedPeriod?.period.status==='active'&&overview.primaryAccount.value?.account.status==='linked'" class="secondary-button linked-order" :disabled="linkSaving" @tap="unlinkSelected">解除关联</button><button v-else-if="canLink(selectedEntry)" class="secondary-button linked-order" @tap="openLinkPicker(selectedEntry)">关联到本月计划</button></template></BottomSheet>
  <BottomSheet above-tab-bar :model-value="linkOpen" title="关联已入账支出" description="选择本人本月未承诺计划，确认本笔支出覆盖的金额；超出部分仍计入已发生支出。" primary-text="确认关联" @update:model-value="linkOpen=$event" @primary="confirmLink"><template v-if="linkEntry"><FactRow label="本笔已入账支出" :value="yuan(linkEntry.amountMinor)"/><StatePanel v-if="!linkData&&!linkError" title="正在读取可关联计划"/><view v-if="linkError" class="notice notice--error">{{linkError}}</view><view v-for="item in eligibleItems" :key="item.itemId" class="link-option"><button class="secondary-button" :class="{'link-option--active':pendingItemId===item.itemId}" @tap="chooseLinkItem(item.itemId)">{{item.title}} · 剩余 {{yuan(item.remainingMinor)}}</button></view><StatePanel v-if="linkData&&!eligibleItems.length" title="没有可关联计划" detail="仅支持本月尚未承诺且仍有未发生金额的支出计划。"/><view v-if="pendingItemId" class="link-amount"><text>本笔覆盖金额（元）</text><input v-model="coverageYuan" type="digit" placeholder="例如 25.00"/></view></template></BottomSheet>
  <BottomSheet above-tab-bar :model-value="categoryOpen" title="修改展示分类" description="只调整你看到的分类，不改写银行原始流水。" primary-text="确认修改" @update:model-value="categoryOpen=$event" @primary="confirmCategory"><view v-if="categoryError" class="notice notice--error category-error">{{categoryError}}</view><view class="category-grid"><button v-for="value in categories" :key="value" :class="{'category--active':pendingCategory===value}" @tap="pendingCategory=value">{{categoryLabel(value)}}</button></view></BottomSheet>
  <BottomSheet above-tab-bar :model-value="selectedObligation!==null" :title="selectedObligation?.label??'未来义务'" description="尚未发生的义务不会提前计入账目。" @update:model-value="value=>{if(!value)selectedObligation=null}"><template v-if="selectedObligation"><FactRow label="账单金额" :value="yuan(selectedObligation.amountDueMinor)"/><FactRow label="剩余待处理" :value="selectedObligation.remainingDueMinor===null||selectedObligation.remainingDueMinor===undefined?'待核验':yuan(selectedObligation.remainingDueMinor)" emphasis/><FactRow label="预计日期" :value="shortDate(selectedObligation.dueOn)"/><FactRow label="状态" :value="selectedObligation.status==='overdue'?'已逾期':selectedObligation.status==='unknown'?'状态待核验':'尚未发生'"/></template></BottomSheet>
</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.link-option{margin-top:12px}.link-option button{width:100%;text-align:left}.link-option--active{border-color:$brand-primary;color:$brand-primary;background:$surface-tint}.link-amount{margin-top:20px}.link-amount text{display:block;color:$text-secondary;font-size:21px}.link-amount input{height:72px;margin-top:9px;padding:0 18px;background:#fff;border:1px solid $border;border-radius:12px;font-size:25px}
.retry{margin:24px auto 0}.search-button{position:absolute;z-index:4;top:calc(40px + env(safe-area-inset-top));right:30px;display:flex;width:66px;height:66px;align-items:center;justify-content:center;padding:0;color:$brand-deep;background:rgba(255,255,255,.66);border:1px solid rgba(255,255,255,.86);border-radius:50%;font-size:38px;line-height:1;box-shadow:$shadow-card}.search-box{display:flex;align-items:center;gap:14px;margin-bottom:16px;padding:16px 22px;background:#fff;border:1px solid $border;border-radius:18px}.search-box input{flex:1;height:52px;font-size:24px}.search-box button{flex:0 0 auto;width:auto;color:$brand-primary;font-size:22px;white-space:nowrap}.month-picker{margin-bottom:14px}.month-picker view{display:flex;justify-content:space-between;gap:14px;padding:16px 20px;color:$brand-deep;background:$surface-tint;border-radius:15px;font-size:22px;font-weight:650}.month-picker text{font-size:20px;font-weight:400}.month-title,.month-subtitle{display:block}.month-title{font-size:29px;font-weight:720}.month-subtitle{margin-top:6px;color:$text-secondary;font-size:20px}.month-arrow{color:$text-tertiary;font-size:38px}.ledger-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:26px}.ledger-metrics view{min-width:0;padding-top:18px;border-top:1px solid $border}.ledger-metrics text,.ledger-metrics b{display:block}.ledger-metrics text{color:$text-secondary;font-size:20px;line-height:1.35}.ledger-metrics b{margin-top:8px;font-size:27px;line-height:1.2;white-space:nowrap}.chips{margin:22px 0;white-space:nowrap}.chip{display:inline-flex;width:auto;align-items:center;justify-content:center;margin-right:12px;padding:16px 30px;color:$text-secondary;background:#E9EFEC;border-radius:999px;font-size:23px;line-height:1.2;white-space:nowrap}.chip--active{color:#fff;background:$brand-primary}
.ledger-month-card{position:relative;overflow:hidden;padding:28px;background:linear-gradient(145deg,#F2FBF6,#FFF8E9);border:1px solid #D5E6DC;border-radius:26px;box-shadow:0 14px 34px rgba(31,66,54,.09)}.ledger-month-card__orb{position:absolute;right:-45px;top:-55px;width:150px;height:150px;background:rgba(117,189,156,.14);border-radius:50%}.ledger-month-card>.row-between,.ledger-month-card>.ledger-metrics{position:relative;z-index:1}.ledger-month-card .month-title{font-size:34px}.ledger-month-card .month-subtitle{font-size:23px}.ledger-month-card .ledger-metrics view{padding:17px 14px;background:rgba(255,255,255,.68);border:0;border-radius:16px}.ledger-month-card .ledger-metrics text{font-size:21px}.ledger-month-card .ledger-metrics b{font-size:27px}
.future-section{margin-bottom:22px;overflow:hidden;background:#FFF9F0;border:1px solid #EAD3B0;border-radius:18px}.future-heading{display:flex;width:100%;align-items:center;justify-content:space-between;padding:20px 24px;text-align:left}.future-heading text{display:block}.future-heading view text:first-child{color:#785528;font-size:24px;font-weight:680}.future-heading view text+text{margin-top:5px;color:#9A7443;font-size:20px}.future-heading>text{color:#9A7443;font-size:30px;transition:transform .2s}.future-heading__arrow--open{transform:rotate(180deg)}.future-list{border-top:1px solid #EAD3B0}.future-empty{padding:20px 24px;color:$text-secondary;font-size:21px}.future-row{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:20px 24px}.future-row+.future-row{border-top:1px solid #EFDFC5}.future-row text{display:block}.future-row view text:first-child{font-size:23px;font-weight:620}.future-row view text+text{margin-top:5px;color:$text-secondary;font-size:19px}.future-row>.amount{font-weight:680}
.month-ai-button{width:100%;margin-top:10px;padding:12px;color:$brand-primary;background:transparent;text-align:center;font-size:21px}
.date-group+.date-group{margin-top:22px}.date-heading{display:flex;width:100%;align-items:center;justify-content:space-between;gap:10px;margin:0 5px 10px;padding:8px 0;background:transparent;text-align:left}.date-heading text:first-child{font-size:25px;font-weight:680}.date-heading text+text{color:$text-tertiary;font-size:20px}.entry-list{padding-block:6px}.entry-row{display:flex;align-items:center;gap:16px;padding:20px 0}.entry-row+.entry-row{border-top:1px solid $border}.entry-icon{display:grid;width:56px;height:56px;place-items:center;color:#9A6728;background:$warning-surface;border-radius:50%;font-size:27px}.entry-icon--in{color:$success;background:$success-surface}.entry-copy{flex:1}.entry-copy text{display:block;font-size:24px;font-weight:620}.entry-copy text+text{margin-top:5px;color:$text-secondary;font-size:20px;font-weight:400}.entry-end{display:flex;align-items:center;gap:10px}.entry-end>text:last-child{color:$text-tertiary;font-size:30px}.entry-amount{font-weight:700}.entry-amount--in,.detail-amount--in{color:$success}.list-end{display:block;padding:25px 0 4px;color:$text-tertiary;font-size:20px;text-align:center}.detail-amount{margin-bottom:20px;font-size:44px;font-weight:760}.linked-order{width:100%;margin-top:16px}.stats-boundary{margin:16px 0;padding:14px 16px;color:$text-secondary;background:$soft-surface;border-radius:12px;font-size:20px;line-height:1.5}.category-totals{margin-top:12px}.category-total{display:flex;justify-content:space-between;gap:12px;padding:12px 0;border-top:1px solid $border;font-size:21px}.category-total b{white-space:nowrap}.category-error{margin-bottom:14px}.category-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.category-grid button{min-height:66px;padding:8px;color:$text-secondary;background:$soft-surface;border:1px solid $border;border-radius:14px;font-size:21px}.category-grid .category--active{color:$brand-primary;background:$surface-tint;border-color:#AFCBBB}
.ledger-entry-card{display:grid;gap:12px}.ledger-entry-card .entry-row{padding:20px 22px;background:#fff;border:1px solid rgba(216,226,220,.86);border-radius:21px;box-shadow:0 8px 22px rgba(31,66,54,.055)}.ledger-entry-card .entry-row+.entry-row{border-top:1px solid rgba(216,226,220,.86)}.ledger-entry-card .entry-icon{flex:0 0 60px;width:60px;height:60px;border-radius:19px;font-size:28px}.ledger-entry-card .entry-copy{min-width:0}.ledger-entry-card .entry-copy>text:first-child{font-size:28px;font-weight:700}.ledger-entry-card .entry-copy>text:nth-child(2){font-size:22px}.entry-copy__status{color:$text-tertiary!important;font-size:21px!important}.ledger-entry-card .entry-amount{font-size:27px}.entry-detail-hero{display:flex;flex-direction:column;align-items:center;padding:12px 0 24px}.entry-detail-hero__icon{display:flex;width:76px;height:76px;align-items:center;justify-content:center;color:#9A6728;background:$warning-surface;border-radius:24px;font-size:34px;font-weight:720}.entry-detail-hero__icon--in{color:$success;background:$success-surface}.entry-detail-hero .detail-amount{margin:15px 0 0;font-size:54px}.entry-detail-hero__mood{margin-top:7px;color:$text-secondary;font-size:25px}.entry-detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.entry-detail-grid>view{min-width:0;padding:18px;background:$soft-surface;border-radius:17px}.entry-detail-grid text,.entry-detail-grid b{display:block}.entry-detail-grid text{color:$text-secondary;font-size:22px}.entry-detail-grid b{margin-top:8px;font-size:26px;line-height:1.4;overflow-wrap:anywhere}.entry-detail-grid__wide{grid-column:1/-1}.linked-order{min-height:76px;font-size:26px}
@media screen and (max-width:360px){.ledger-month-card{padding:23px 18px}.ledger-metrics{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.ledger-month-card .ledger-metrics view{display:block;padding:14px 9px}.ledger-month-card .ledger-metrics b{margin-top:7px;font-size:23px;white-space:normal}.future-row,.entry-row{align-items:flex-start}.entry-copy{min-width:0}.entry-end{flex:0 0 auto}.entry-detail-grid{grid-template-columns:1fr}.entry-detail-grid__wide{grid-column:auto}.category-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.search-box{padding:14px 18px}}
</style>
