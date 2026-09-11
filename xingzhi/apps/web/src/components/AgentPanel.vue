<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api, yuan } from '../lib/api';
import type { AgentProposal, AgentRun } from '../lib/types';

const props=defineProps<{planId:string;planVersion:number;busy?:boolean}>();
const emit=defineEmits<{review:[proposal:AgentProposal,planId:string]}>();
const message=ref('');const run=ref<AgentRun|null>(null);
const loading=ref(true);const sending=ref(false);const error=ref('');
let alive=true;let timer:ReturnType<typeof setTimeout>|undefined;
let readVersion=0;
let request:{message:string;key:string}|undefined;
const active=computed(()=>run.value?.state==='RUNNING');
const followupActive=computed(()=>{
  const current=run.value;
  return !!current && (current.state==='RUNNING' || current.state==='WAITING_USER' || current.state==='WAITING_EXTERNAL' || current.pendingFollowups>0);
});
const stateLabel=computed(()=>{
  const current=run.value;
  if(!current)return '回答已完成';
  if(current.state==='FAILED')return '本轮未完成';
  if(current.state==='CANCELLED')return '本轮已取消';
  if(current.proposal?.status==='confirmed')return '方案已确认';
  return ({RUNNING:'正在核对计划',WAITING_USER:'等待你查看方案',WAITING_EXTERNAL:'等待交易结果',COMPLETED:'回答已完成'}[current.state]);
});

function schedule(){
  if(timer)clearTimeout(timer);
  if(alive && (active.value || (run.value?.pendingFollowups??0)>0))timer=setTimeout(()=>{void refresh();},active.value?1500:3000);
  else if(alive && run.value?.proposal?.confirmable)timer=setTimeout(()=>{void refresh();},Math.min(60000,Math.max(500,new Date(run.value.proposal.expiresAt).getTime()-Date.now()+100)));
}
async function refresh(){
  const version=++readVersion;
  try{
    const result=(await api<{run:AgentRun|null}>(`/plans/${props.planId}/agent-runs/latest`)).run;
    if(alive && version===readVersion){run.value=result;error.value='';}
  }catch(reason){if(alive && version===readVersion)error.value=(reason as Error).message;}
  finally{if(alive && version===readVersion){loading.value=false;schedule();}}
}
async function send(){
  const text=message.value.trim();if(!text || sending.value || active.value)return;
  if(request?.message!==text)request={message:text,key:crypto.randomUUID()};
  sending.value=true;error.value='';
  readVersion++;
  try{
    const result=await api<{runId:string}>(`/plans/${props.planId}/agent-runs`,{method:'POST',
      headers:{'Idempotency-Key':request.key},body:JSON.stringify({message:text})});
    if(!alive)return;
    run.value={id:result.runId,followupRootId:result.runId,plan_id:props.planId,state:'RUNNING',output:'',error_code:null,proposal:null,pendingFollowups:0,followupFailed:false};
    request=undefined;
    await refresh();
  }catch(reason){if(alive)error.value=(reason as Error).message;}
  finally{if(alive)sending.value=false;}
}
async function cancel(){
  if(!run.value || sending.value || !followupActive.value)return;
  sending.value=true;
  try{await api<AgentRun>(`/agent-runs/${run.value.followupRootId||run.value.id}/cancel`,{method:'POST'});if(alive)await refresh();}
  catch(reason){if(alive)error.value=(reason as Error).message;}
  finally{if(alive){sending.value=false;schedule();}}
}
async function review(){
  if(!run.value)return;
  sending.value=true;
  try{
    const latest=await api<AgentRun>(`/agent-runs/${run.value.id}`);
    if(!alive)return;run.value=latest;
    if(latest.proposal && (latest.proposal.confirmable || latest.proposal.status==='confirmed'))emit('review',latest.proposal,props.planId);
    else error.value='方案已过期或计划已变化，请重新生成预览。';
  }catch(reason){if(alive)error.value=(reason as Error).message;}
  finally{if(alive)sending.value=false;}
}
onMounted(refresh);
watch(()=>props.planVersion,()=>{if(!sending.value)void refresh();});
onBeforeUnmount(()=>{alive=false;if(timer)clearTimeout(timer);});
</script>

<template>
  <section class="ledger-section agent-panel" aria-labelledby="agent-title">
    <div class="section-title"><div><p class="eyebrow">行止助手</p><h2 id="agent-title">先说想法，再看方案</h2></div></div>
    <p class="muted" id="agent-help">可以询问当前进度，或描述想购买、保留和取消的项目。助手生成的方案由你在卡片中确认，确认后会继续按授权执行。官方付款仍由你完成；可以明确说“暂停全部购买”或使用上方暂停按钮。</p>
    <p v-if="loading" role="status">正在恢复最近一次对话…</p>
    <div v-if="run" class="agent-answer">
      <p role="status">{{ stateLabel }}</p>
      <p v-if="run.proposal" class="agent-output">{{ run.proposal.status==='confirmed'?'此方案已确认，请查看跟进状态及交易进度；也可用结构化入口继续。':run.proposal.confirmable?'方案已生成，请查看范围与金额后在确认卡片中决定。尚未确认或执行任何交易。':'请查看最新计划与方案状态，必要时重新生成预览。' }}</p>
      <p v-else-if="run.output" class="agent-output">{{ run.output }}</p>
      <ul v-if="run.actions?.length" class="agent-actions" aria-label="已受理动作">
        <li v-for="(action,index) in run.actions" :key="index">
          <span>{{ action.result.message ?? (action.toolName==='pause_purchases'?'指定范围已暂停购买，已有订单仍继续核对。':'动作已受理，请查看业务进度。') }}</span>
          <span v-if="action.result.environment==='simulation'">（本地模拟）</span>
        </li>
      </ul>
      <p v-if="run.state==='WAITING_EXTERNAL'" class="muted">后台会继续处理已受理任务，有新的业务事实时更新说明，无需保持本页面打开。</p>
      <p v-if="run.pendingFollowups && run.state!=='RUNNING'" class="muted">正在等待后台处理或关联结果更新。</p>
      <p v-if="followupActive" class="muted">停止只影响助手跟进，已受理订单仍继续处理；停止后仍可查看已生成的确认卡。</p>
      <p v-if="run.state==='FAILED'" class="muted">{{ run.error_code==='RUN_EXPIRED' ? '本轮已超时。' : '助手暂时未能完成本轮。' }}可以重新提问，或继续使用结构化操作；已有订单不受影响。</p>
      <p v-if="run.followupFailed" class="muted">部分助手跟进未完成；你仍可查看已生成的确认卡，并继续使用结构化操作。已受理订单会继续处理，助手不一定会完成后续跟进。</p>
      <div v-if="run.proposal" class="confirmation-card">
        <p><strong>{{ run.proposal.type==='purchase'?'购买方案':'变更方案' }}</strong> · {{ run.proposal.items.length }} 个项目</p>
        <p v-if="run.proposal.type==='purchase'">本次金额 {{ yuan(run.proposal.totalMinor) }}</p>
        <p v-else>取消费用 {{ yuan(run.proposal.totalFeeMinor) }}，预期退款 {{ yuan(run.proposal.totalRefundMinor) }}</p>
        <button class="secondary-button" type="button" :disabled="sending || busy || (!run.proposal.confirmable && run.proposal.status!=='confirmed')" @click="review">查看确认卡片</button>
        <p v-if="!run.proposal.confirmable && run.proposal.status!=='confirmed'" class="muted">方案已失效或已进入执行，请查看最新计划，必要时重新预览。</p>
      </div>
    </div>
    <p v-if="error" role="alert" class="notice notice-error">{{ error }}</p>
    <form @submit.prevent="send">
      <label for="agent-message">你的想法</label>
      <textarea id="agent-message" v-model="message" rows="3" maxlength="4000" :disabled="sending || active" aria-describedby="agent-help" placeholder="例如：请为尚未下单的住宿生成购买方案" required />
      <div class="button-row">
        <button type="submit" class="primary-button" :disabled="loading || sending || busy || active || !message.trim()">{{ sending?'正在处理…':'发送给助手' }}</button>
        <button v-if="followupActive" type="button" class="text-button" :disabled="sending" @click="cancel">停止本次助手跟进</button>
        <button v-if="error" type="button" class="text-button" :disabled="sending" @click="refresh">刷新运行状态</button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.agent-answer { margin-block: 1rem; border-top: 1px solid #d5e0db; padding-top: 1rem; }
.agent-output { white-space: pre-wrap; overflow-wrap: anywhere; }
textarea { display: block; width: 100%; min-height: 6rem; resize: vertical; margin-block: .5rem 1rem; padding: .75rem; color: inherit; background: #fbfcfa; border: 1px solid #bfcfca; }
</style>
