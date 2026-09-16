import type { FastifyInstance } from 'fastify';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { z } from 'zod';
import { requireRole, requireSameOrigin, idempotencyKey } from '../auth/guards.js';
import { startAgentRun, readAgentRun, cancelAgentRun, latestAgentRun } from '../domain/agent-runs.js';
import { executeAgentRun, modelReady } from '../domain/agent-runtime.js';
import {
  cancelConsumerAgentRun,
  executeConsumerAgentRun,
  listConsumerAgentRuns,
  readConsumerAgentRun,
  startConsumerAgentRun,
} from '../domain/consumer-agent-runtime.js';

const idInput=z.object({id:z.string().uuid()});
const messageInput=z.object({message:z.string().trim().min(1).max(4000)}).strict();
const consumerMessageInput=z.object({
  message:z.string().trim().min(1).max(4000),
  periodId:z.string().uuid().nullable().default(null),
}).strict();
const consumerRunQuery=z.object({
  periodId:z.union([z.string().uuid(),z.literal('null')]).optional(),
  cursor:z.string().uuid().optional(),
}).strict();

export function registerAgentApi(app: FastifyInstance, stream?: StreamFn) {
  const running=new Map<string,{controller:AbortController;done:Promise<void>}>();
  app.addHook('onClose',async()=>{
    for(const run of running.values())run.controller.abort();
    await Promise.allSettled([...running.values()].map(run=>run.done));
  });
  app.post('/api/plans/:id/agent-runs',async(request,reply)=>{
    const user=requireRole(request,reply,'consumer'); if(!user)return;
    if(!requireSameOrigin(request,reply))return;
    const key=idempotencyKey(request,reply);if(!key)return;
    const {id}=idInput.parse(request.params);const {message}=messageInput.parse(request.body);
    if(!stream && !modelReady())return reply.code(503).send({error:'MODEL_NOT_CONFIGURED',message:'自然语言助手尚未配置，仍可使用结构化功能。'});
    const result=await startAgentRun(user,id,key,message);
    if(!result.reused){
      const controller=new AbortController();
      const done=executeAgentRun(result.runId,id,user,message,controller.signal,stream)
        .catch(()=>{app.log.error({runId:result.runId},'Agent 运行持久化失败，等待超时恢复。');})
        .finally(()=>running.delete(result.runId));
      running.set(result.runId,{controller,done});
    }
    return reply.code(202).send({...result,mode:'proposal_assistant'});
  });
  app.post('/api/ai/agent-runs',async(request,reply)=>{
    const user=requireRole(request,reply,'consumer');if(!user)return;
    if(!requireSameOrigin(request,reply))return;
    const key=idempotencyKey(request,reply);if(!key)return;
    const input=consumerMessageInput.parse(request.body);
    if(!stream && !modelReady())return reply.code(503).send({error:'MODEL_NOT_CONFIGURED',message:'自然语言助手尚未配置，仍可使用结构化功能。'});
    const result=await startConsumerAgentRun(user,key,input);
    if(!result.reused){
      const controller=new AbortController();
      const done=executeConsumerAgentRun(result.runId,user,input.message,input.periodId,controller.signal,stream)
        .catch(()=>{app.log.error({runId:result.runId},'消费者 Agent 运行持久化失败。');})
        .finally(()=>running.delete(result.runId));
      running.set(result.runId,{controller,done});
    }
    return reply.code(202).send({data:{...result,mode:'consumer_planning'},meta:{}});
  });
  app.get('/api/ai/agent-runs/:id',async(request,reply)=>{
    const user=requireRole(request,reply,'consumer');if(!user)return;
    return {data:await readConsumerAgentRun(user,idInput.parse(request.params).id),meta:{}};
  });
  app.get('/api/ai/agent-runs',async(request,reply)=>{
    const user=requireRole(request,reply,'consumer');if(!user)return;
    const input=consumerRunQuery.parse(request.query);
    return {data:await listConsumerAgentRuns(user,{periodId:input.periodId==='null'?null:input.periodId,
      cursor:input.cursor}),meta:{}};
  });
  app.post('/api/ai/agent-runs/:id/cancel',async(request,reply)=>{
    const user=requireRole(request,reply,'consumer');if(!user)return;
    if(!requireSameOrigin(request,reply))return;
    const {id}=idInput.parse(request.params);
    const result=await cancelConsumerAgentRun(user,id);
    running.get(id)?.controller.abort();
    return {data:result,meta:{}};
  });
  app.get('/api/plans/:id/agent-runs/latest',async(request,reply)=>{
    const user=requireRole(request,reply,'consumer');if(!user)return;
    return {run:await latestAgentRun(user,idInput.parse(request.params).id)};
  });
  app.get('/api/agent-runs/:id',async(request,reply)=>{
    const user=requireRole(request,reply,'consumer');if(!user)return;
    return readAgentRun(user,idInput.parse(request.params).id);
  });
  app.post('/api/agent-runs/:id/cancel',async(request,reply)=>{
    const user=requireRole(request,reply,'consumer');if(!user)return;
    if(!requireSameOrigin(request,reply))return;
    const {id}=idInput.parse(request.params);
    const result=await cancelAgentRun(user,id);
    running.get(id)?.controller.abort();
    return result;
  });
}
