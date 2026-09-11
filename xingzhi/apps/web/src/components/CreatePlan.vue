<script setup lang="ts">
import { ref } from 'vue';
import type { CatalogItem } from '../lib/types';
import { yuan } from '../lib/api';

const props = defineProps<{ catalog: CatalogItem[]; busy?: boolean }>();
const emit = defineEmits<{ create: [purpose: string, itemIds: string[]] }>();

const purpose = ref('周末出行安排');
const selected = ref<string[]>([]);

function toggle(id: string) {
  selected.value = selected.value.includes(id) ? selected.value.filter((itemId) => itemId !== id) : [...selected.value, id];
}

function submit() {
  if (purpose.value.trim().length >= 2 && selected.value.length) emit('create', purpose.value.trim(), selected.value);
}
</script>

<template>
  <section class="ledger-section plan-create" aria-labelledby="create-plan-title">
    <div class="section-title"><div><p class="eyebrow">从空计划开始</p><h2 id="create-plan-title">先标记本次行程</h2></div></div>
    <form @submit.prevent="submit">
      <label>计划名称<input v-model="purpose" maxlength="120" autocomplete="off" placeholder="例如：周末出行安排" /></label>
      <fieldset class="catalog-choice"><legend>加入计划的项目</legend>
        <label v-for="item in props.catalog" :key="item.id" class="choice-row">
          <input type="checkbox" :checked="selected.includes(item.id)" @change="toggle(item.id)" />
          <span><b>{{ item.code }} · {{ item.name }}</b><small>{{ item.description }}</small></span>
          <strong>{{ item.kind === 'unbooked' ? '暂不购买' : yuan(item.priceMinor) }}</strong>
        </label>
      </fieldset>
      <button class="primary-button" type="submit" :disabled="busy || !selected.length">建立计划</button>
    </form>
  </section>
</template>
