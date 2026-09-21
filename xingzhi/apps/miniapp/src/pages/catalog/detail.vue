<script setup lang="ts">
import { ref } from 'vue';
import Taro, { useLoad } from '@tarojs/taro';
import FactRow from '@/components/FactRow.vue';
import PageShell from '@/components/PageShell.vue';
import SectionCard from '@/components/SectionCard.vue';
import StatePanel from '@/components/StatePanel.vue';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { yuan } from '@/lib/format';
import type { Offer } from '@/lib/types';

const offer = ref<Offer | null>(null);
const periodId = ref('');
const itemId = ref('');
const loading = ref(true);
const error = ref('');
useLoad(async options => {
  periodId.value = options.periodId ?? ''; itemId.value = options.itemId ?? '';
  try { offer.value = (await api.offer(options.id ?? '')).data; }
  catch (reason) { error.value = errorMessage(reason); }
  finally { loading.value = false; }
});
</script>

<template>
  <PageShell title="候选详情" subtitle="先了解规则，再核对实时报价" compact>
    <template #hero><button class="back" @tap="Taro.navigateBack()">‹</button></template>
    <StatePanel v-if="loading" title="正在读取候选详情"/>
    <StatePanel v-else-if="error||!offer" title="候选详情暂时不可用" :detail="error" tone="error"/>
    <template v-else><SectionCard><text class="title">{{offer.name}}</text><text class="description">{{offer.description}}</text><FactRow label="展示价格" :value="yuan(offer.displayPriceMinor)" emphasis/><FactRow label="地点" :value="offer.locationLabel??'线上或以实际服务安排为准'"/><FactRow label="购买方式" :value="offer.purchaseMode==='orderable'?'可在线建立订单':'仅供信息参考'"/><FactRow label="取消规则" :value="offer.ruleLabel"/></SectionCard><SectionCard v-if="offer.tags.length" class="block"><text class="section-title">特点</text><view class="tags"><text v-for="tag in offer.tags" :key="tag">{{tag}}</text></view></SectionCard><view class="notice notice--info block">展示价格仅用于浏览；进入核对页后会读取与计划日期匹配的有效报价和资金影响。</view><button class="primary-button full" :disabled="offer.purchaseMode!=='orderable'||!periodId||!itemId" @tap="Taro.redirectTo({url:`/pages/offers/index?periodId=${periodId}&itemId=${itemId}`})">返回并核对报价</button></template>
  </PageShell>
</template>

<style lang="scss">
@use '../../styles/tokens' as *;
.back{position:absolute;right:28px;top:calc(34px + env(safe-area-inset-top));width:64px;height:64px;border-radius:50%;font-size:42px}.title{display:block;font-size:32px;font-weight:740}.description{display:block;margin-top:12px;color:$text-secondary;font-size:22px;line-height:1.65}.block,.full{margin-top:18px}.section-title{font-size:26px;font-weight:700}.tags{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px}.tags text{padding:9px 16px;color:$brand-deep;background:$surface-tint;border-radius:999px;font-size:20px}.full{width:100%}
</style>
