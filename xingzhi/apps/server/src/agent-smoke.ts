import { randomUUID } from 'node:crypto';
import { Agent, type StreamFn } from '@earendil-works/pi-agent-core';
import { Type, type Model } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import './config.js';
import { closePool, transaction } from './db/client.js';
import { reserveModelCost, settleModelCost } from './domain/model-budget.js';
import { deepseekPricing, modelCostMicros } from './domain/model-pricing.js';

// Official DeepSeek V4.1 Flash peak prices verified 2026-09-12; record conservative estimates, not provider bills.
const key=process.env.DEEPSEEK_API_KEY;
const baseUrl=process.env.DEEPSEEK_BASE_URL??'https://api.deepseek.com';
const modelId=process.env.DEEPSEEK_MODEL??'deepseek-flash';
if(!key?.trim() || baseUrl!=='https://api.deepseek.com' || modelId!=='deepseek-flash') {
  console.error('模型烟测未发送：请在本机 .env 配置 DEEPSEEK_API_KEY，并保持已确认模型与地址。');
  process.exitCode=2;
} else {
  const model:Model<'openai-completions'>={id:modelId,name:modelId,provider:'deepseek',api:'openai-completions',baseUrl,
    reasoning:false,input:['text'],contextWindow:1_000_000,maxTokens:512,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  let calls=0;let toolCalls=0;let settledCalls=0;
  const run=randomUUID();
  const reservedCalls=new Map<number,string>();
  const guarded:StreamFn=async (_model,context,options)=>{
    if(++calls>2) throw new Error('烟测最多两次模型调用。');
    const id=randomUUID();reservedCalls.set(calls,id);
    // Reserve the entire supported input window plus our bounded output, independent of token estimates.
    const ceiling=modelCostMicros({input:1_000_000,cacheRead:0,cacheWrite:0,output:512});
    await transaction(client=>reserveModelCost(client,id,`pi_smoke:${run}:${calls}`,ceiling));
    return streamSimple(model,context,{...options,apiKey:key,maxTokens:512,maxRetries:0,signal:AbortSignal.any([AbortSignal.timeout(30_000),...(options?.signal?[options.signal]:[])])});
  };
  const agent=new Agent({initialState:{model,systemPrompt:'这是无资金工具烟测。请调用 get_plan_orders 一次，再根据返回事实用中文简短解释。不要调用任何其他工具。',tools:[{
    name:'get_plan_orders',label:'读取烟测事实',description:'只读固定虚构事实，不访问业务数据库',parameters:Type.Object({}),
    async execute(){if(++toolCalls>1)throw new Error('烟测只允许一次只读工具调用。');return {content:[{type:'text',text:'来源：烟测虚构数据；计划尚未下单，实付和退款均为0。'}],details:{source:'smoke_fixture'}};},
  }]},streamFn:guarded,toolExecution:'sequential'});
  agent.subscribe(async event=>{
    if(event.type==='message_end' && event.message.role==='assistant') {
      const usage=event.message.usage;
      if(usage.totalTokens>0) {
        const amount=modelCostMicros({input:usage.input,cacheRead:usage.cacheRead,cacheWrite:usage.cacheWrite,output:usage.output});
        const {cost: _sdkCost,...tokens}=usage;
        const id=reservedCalls.get(calls);if(id) { await transaction(client=>settleModelCost(client,id,amount,{...tokens,pricing:deepseekPricing})); settledCalls++; }
      }
    }
  });
  const timer=setTimeout(()=>agent.abort(),60_000);
  try {
    await agent.prompt('读取烟测计划并说明是否发生付款。');
    if(toolCalls!==1 || settledCalls!==calls || agent.state.errorMessage) throw new Error('模型未完成预期只读工具循环。');
    console.log(JSON.stringify({status:'passed',runId:run,model:modelId,calls,toolCalls,paymentCalls:0}));
  } catch {
    console.error('模型烟测未通过；缺失 usage 的调用费用预占仍保留，请按账本核对。');process.exitCode=1;
  } finally {clearTimeout(timer);await closePool();}
}
