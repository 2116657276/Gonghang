<script setup lang="ts">
import { reactive, watch } from 'vue';
import type { MerchantCatalogItem } from '../lib/types';
import { yuan } from '../lib/api';

const props = defineProps<{ items: MerchantCatalogItem[]; busy?: boolean }>();
const emit = defineEmits<{ update: [itemId: string, rule: string, expectedVersion: number] }>();
const selected = reactive<Record<string, string>>({});

const ruleOptions = [
  ['full_refund', '全额退款'], ['fee_80', '收取 80 元费用'], ['two_batches', '收取 80 元并分两批'],
  ['reject', '拒绝取消退款'], ['delay', '延迟人工复核'],
] as const;

watch(() => props.items, (items) => {
  for (const item of items) selected[item.id] = item.rule;
}, { immediate: true });
</script>

<template>
  <section class="ledger-section" aria-labelledby="merchant-rules-title">
    <div class="section-title"><div><p class="eyebrow">规则预设</p><h2 id="merchant-rules-title">测试取消口径</h2></div></div>
    <p class="scope-note">规则只影响之后生成且尚未执行的取消预览；消费者已确认的金额仍按快照校验。</p>
    <div class="rule-list">
      <div v-for="item in items" :key="item.id" class="rule-row">
        <span><strong>{{ item.code }} · {{ item.name }}</strong><small>{{ yuan(item.priceMinor) }} · 版本 {{ item.ruleVersion }}</small></span>
        <label :for="`rule-${item.id}`" class="visually-hidden">{{ item.name }}的取消规则</label>
        <select :id="`rule-${item.id}`" v-model="selected[item.id]">
          <option v-for="option in ruleOptions" :key="option[0]" :value="option[0]">{{ option[1] }}</option>
        </select>
        <button class="secondary-button" type="button" :disabled="busy || selected[item.id] === item.rule" @click="emit('update', item.id, selected[item.id], item.ruleVersion)">保存</button>
      </div>
    </div>
  </section>
</template>
