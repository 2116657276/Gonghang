<script setup lang="ts">
import { reactive } from 'vue';
import type { ManualTask } from '../lib/types';
import { dateTime } from '../lib/api';
import StatusPill from './StatusPill.vue';

defineProps<{ tasks: ManualTask[]; busy?: boolean }>();
const emit = defineEmits<{ claim: [id: string]; record: [id: string, note: string] }>();
const notes = reactive<Record<string, string>>({});
</script>

<template>
  <section class="ledger-section" aria-labelledby="manual-task-title">
    <div class="section-title"><div><p class="eyebrow">人工责任</p><h2 id="manual-task-title">待复核任务</h2></div></div>
    <div v-if="tasks.length" class="manual-task-list">
      <article v-for="task in tasks" :key="task.id" class="manual-task-card">
        <header><strong>{{ task.type }}</strong><StatusPill :value="task.state" /></header>
        <p>{{ task.reason }}</p>
        <p class="muted">下一步：{{ task.nextAction }}</p>
        <small>计划复核：{{ dateTime(task.nextReviewAt) }}</small>
        <button v-if="task.state === 'open'" class="secondary-button" type="button" :disabled="busy" @click="emit('claim', task.id)">领取任务</button>
        <div v-else-if="task.state === 'claimed'" class="manual-note">
          <label :for="`note-${task.id}`">复核记录</label>
          <textarea :id="`note-${task.id}`" v-model="notes[task.id]" rows="3" placeholder="记录已核对的既有事实，不手工填报退款成功。"></textarea>
          <button class="secondary-button" type="button" :disabled="busy || (notes[task.id]?.trim().length ?? 0) < 2" @click="emit('record', task.id, notes[task.id].trim())">保存复核记录</button>
        </div>
      </article>
    </div>
    <p v-else class="muted">目前没有需要人工接管的延迟或未知事项。</p>
  </section>
</template>
