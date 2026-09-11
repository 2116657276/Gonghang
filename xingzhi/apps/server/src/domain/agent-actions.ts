import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { createOrderInput } from '@xingzhi/contracts';
import type { AuthUser } from '../auth/session.js';
import { transaction } from '../db/client.js';
import { ownedPlan } from './access.js';
import { AppError, notFound } from './errors.js';
import { createConfirmedOrder, pausePurchases, preparePaymentHandoff, submitConfirmedChange } from './business-actions.js';
import { watchAgentOrder } from './agent-events.js';
import { requestOperationRecheck } from './operation-rechecks.js';

export type ExecutionTool = 'create_order'|'request_payment'|'pause_purchases'|'submit_change'|'get_operation_status';
const idInput=z.object({id:z.string().uuid()}).strict();

// Only the authenticated user's entire message can request a pause. No model-supplied quote or scope.
export function requestedPauseScope(message:string,items:Array<{id:string;name:string;code:string|null}>):string[]|null {
  const text=message.trim().replace(/[。！!]+$/u,'').replace(/\s+/gu,'');
  if(/^(?:请)?(?:立即|现在|先)?(?:暂停|停止)(?:(?:全部|所有|整个计划)(?:的)?)?(?:购买|下单)$/u.test(text))return items.map(item=>item.id);
  const match=/^(?:请)?(?:立即|现在|先)?(?:暂停|停止)(.+?)(?:的)?(?:购买|下单)$/u.exec(text);
  if(!match)return null;
  const names=match[1]!.replace(/的$/u,'').split(/[、,，和]/u);
  const ids:string[]=[];
  for(const name of names){
    const matches=items.filter(item=>item.name.replace(/\s+/gu,'')===name || item.code===name);
    if(matches.length!==1)return null;
    ids.push(matches[0]!.id);
  }
  return ids.length? [...new Set(ids)]:null;
}

export async function executeAgentAction(user:AuthUser,planId:string,runId:string,callId:string,name:ExecutionTool,rawInput:unknown) {
  const input=name==='create_order'?createOrderInput.strict().parse(rawInput)
    :name==='pause_purchases'?z.object({}).strict().parse(rawInput):idInput.parse(rawInput);
  return transaction(async client=>{
    const plan=await ownedPlan(client,planId,user,true);
    const run=(await client.query<{state:string;active:boolean;input:string;trigger_event_id:string|null}>(
      'SELECT state,deadline>now() AS active,input,trigger_event_id FROM agent_runs WHERE id=$1 AND plan_id=$2 AND owner_id=$3 FOR UPDATE',
      [runId,planId,user.id])).rows[0];
    if(!run)notFound();
    const prior=(await client.query<{tool_name:string;request_payload:unknown;response_payload:Record<string,unknown>}>(
      'SELECT tool_name,request_payload,response_payload FROM agent_tool_calls WHERE run_id=$1 AND tool_call_id=$2',[runId,callId])).rows[0];
    if(prior){
      if(prior.tool_name!==name || !isDeepStrictEqual(prior.request_payload,input))throw new AppError(409,'TOOL_CALL_CONFLICT','工具调用标识不能改换参数。');
      return prior.response_payload;
    }
    if (run.trigger_event_id) {
      if(name==='get_operation_status')throw new AppError(422,'EVENT_READ_ONLY','事件恢复不能新增主动渠道复核。');
      const event=(await client.query<{type:string;data:{proposalId?:string;confirmationId?:string}}>('SELECT type,data FROM events WHERE id=$1',[run.trigger_event_id])).rows[0];
      if(!event || !['purchase.confirmed','change.confirmed'].includes(event.type))throw new AppError(422,'EVENT_READ_ONLY','业务结果恢复仅可读取事实，不能执行新交易。');
      if(name==='create_order' && (event.type!=='purchase.confirmed' || createOrderInput.parse(input).confirmationId!==event.data.confirmationId))throw new AppError(422,'EVENT_SCOPE_MISMATCH','不能执行其他确认范围。');
      if(name==='submit_change' && (event.type!=='change.confirmed' || idInput.parse(input).id!==event.data.proposalId))throw new AppError(422,'EVENT_SCOPE_MISMATCH','不能提交其他变更方案。');
      if(name==='request_payment'){
        if(event.type!=='purchase.confirmed' || !(await client.query('SELECT 1 FROM orders WHERE id=$1 AND confirmation_id=$2',[idInput.parse(input).id,event.data.confirmationId])).rowCount)throw new AppError(422,'EVENT_SCOPE_MISMATCH','付款对象不在本次确认范围。');
      }
    }
    if(run.state!=='RUNNING' || !run.active)throw new AppError(409,'AGENT_RUN_STOPPED','运行已停止，不能执行新动作。');
    if(name==='pause_purchases'){
      const paused=(await client.query<{response_payload:Record<string,unknown>}>(
        "SELECT response_payload FROM agent_tool_calls WHERE run_id=$1 AND tool_name='pause_purchases' AND response_payload IS NOT NULL LIMIT 1",[runId])).rows[0];
      if(paused){
        await client.query('INSERT INTO agent_tool_calls(run_id,tool_call_id,tool_name,request_payload,response_payload) VALUES($1,$2,$3,$4,$5)',
          [runId,callId,name,input,paused.response_payload]);
        return paused.response_payload;
      }
    }
    await client.query('INSERT INTO agent_tool_calls(run_id,tool_call_id,tool_name,request_payload) VALUES($1,$2,$3,$4)',[runId,callId,name,input]);
    let result:Record<string,unknown>;
    const operationIds:string[]=[];
    if(name==='create_order'){
      const args=createOrderInput.parse(input);
      if(!(await client.query("SELECT 1 FROM confirmations WHERE id=$1 AND plan_id=$2 AND owner_id=$3 AND type='purchase'",[args.confirmationId,planId,user.id])).rowCount)notFound();
      const order=await createConfirmedOrder(client,user,args);
      if(order.operationId)operationIds.push(order.operationId);
      await watchAgentOrder(client,runId,order.orderId,'purchase');
      result={...order,message:'订单已受理。模拟付款由本地任务处理；官方付款仍需用户在付款页面完成。'};
    }else if(name==='request_payment'){
      const {id}=idInput.parse(input);
      const order=(await client.query<{environment:string;payment_status:string}>(
        'SELECT environment,payment_status FROM orders WHERE id=$1 AND plan_id=$2 AND owner_id=$3',[id,planId,user.id])).rows[0];
      if(!order)notFound();
      if(order.environment==='sandbox' && order.payment_status==='pending'){
        const handoff=await preparePaymentHandoff(client,user,id);
        // Never persist or return the signed URL to the model or conversation history.
        result={orderId:id,environment:'sandbox',paymentStatus:'pending',requiresUserAction:true,expiresAt:handoff.expiresAt,
          message:'付款交接已准备，请由用户在当前计划的付款进度卡片进入官方收银台。打开页面不表示付款成功。'};
      }else{
        result={orderId:id,environment:order.environment,paymentStatus:order.payment_status,requiresUserAction:false,
          message:order.environment==='simulation'?'本地模拟订单，没有官方收银台，请查看后台任务状态。':'订单不再待付款，请查看最新事实。'};
      }
      const operations=await client.query<{id:string}>("SELECT id FROM operations WHERE entity_id=$1 AND type IN ('sandbox_payment_handoff','simulate_payment')",[id]);
      operationIds.push(...operations.rows.map(row=>row.id));
      await watchAgentOrder(client,runId,id,'purchase');
    }else if(name==='pause_purchases'){
      if(run.trigger_event_id)throw new AppError(422,'PAUSE_REQUIRES_USER_REQUEST','事件恢复不能代替用户发出暂停指令。');
      const items=await client.query<{id:string;name:string;code:string|null}>(
        'SELECT p.id,p.name,c.code FROM plan_items p LEFT JOIN catalog_items c ON c.id=p.catalog_item_id WHERE p.plan_id=$1',[planId]);
      const scope=requestedPauseScope(run.input,items.rows);
      if(!scope?.length)throw new AppError(422,'PAUSE_REQUIRES_USER_REQUEST','需要明确的暂停范围；请澄清或使用独立暂停按钮。');
      result=await pausePurchases(client,user,planId,{expectedVersion:plan.version,itemIds:scope,reason:'用户在本轮消息中明确请求暂停购买'});
    }else if(name==='submit_change'){
      const {id}=idInput.parse(input);
      if(!(await client.query("SELECT 1 FROM proposals WHERE id=$1 AND plan_id=$2 AND owner_id=$3 AND type='change'",[id,planId,user.id])).rowCount)notFound();
      const targets=await client.query<{order_id:string}>("SELECT o.id AS order_id FROM proposals p CROSS JOIN LATERAL jsonb_array_elements(p.snapshot->'items') item JOIN orders o ON o.id::text=item->>'orderId' WHERE p.id=$1 AND item->>'intent' IN ('close','cancel')",[id]);
      for(const target of targets.rows)await watchAgentOrder(client,runId,target.order_id,'change');
      const change=await submitConfirmedChange(client,user,id);
      operationIds.push(...change.operationIds);
      result={...change,message:'已按有效确认受理变更。受理不等于退款成功；退款批次由商户执行。'};
    }else{
      const {id}=idInput.parse(input);
      if(!(await client.query('SELECT 1 FROM operations WHERE id=$1 AND plan_id=$2 AND owner_id=$3',[id,planId,user.id])).rowCount)notFound();
      const recheck=await requestOperationRecheck(client,user,id,{reason:'用户通过助手请求核对已有操作的最新事实。'});
      operationIds.push('recheckOperationId' in recheck && typeof recheck.recheckOperationId==='string'?recheck.recheckOperationId:id);
      result={...recheck,message:'复核已受理，请查看关联操作或人工任务；受理不代表渠道已核验成功。'};
    }
    for(const operationId of operationIds)await client.query('INSERT INTO agent_run_operations(run_id,operation_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[runId,operationId]);
    await client.query('UPDATE agent_tool_calls SET response_payload=$3 WHERE run_id=$1 AND tool_call_id=$2',[runId,callId,result]);
    return result;
  });
}
