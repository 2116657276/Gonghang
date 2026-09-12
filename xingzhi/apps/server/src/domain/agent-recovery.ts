import type { AuthUser } from '../auth/session.js';
import { query, transaction } from '../db/client.js';
import { createAgentRun } from './agent-runs.js';
import { AppError } from './errors.js';

export async function claimAgentWakeup() {
  const candidate=(await query<{id:string;plan_id:string}>(`SELECT w.id,r.plan_id FROM agent_wakeups w
    JOIN agent_runs r ON r.id=w.parent_run_id LEFT JOIN agent_runs child ON child.id=w.run_id
    WHERE w.next_run_at<=now() AND (w.state='pending' OR (w.state='dispatched' AND (child.state<>'RUNNING' OR child.deadline<=now())))
    ORDER BY w.next_run_at,w.id LIMIT 1`)).rows[0];
  if(!candidate)return;
  return transaction(async client=>{
    // Same order as user writes: plan, then wakeup/run. Do not hold this transaction during inference.
    await client.query('SELECT id FROM plans WHERE id=$1 FOR UPDATE',[candidate.plan_id]);
    const wakeup=(await client.query<{id:string;parent_run_id:string;event_id:string;state:string;run_id:string|null;attempts:number}>(
      "SELECT * FROM agent_wakeups WHERE id=$1 AND state IN ('pending','dispatched') AND next_run_at<=now() FOR UPDATE SKIP LOCKED",[candidate.id])).rows[0];
    if(!wakeup)return;
    const parent=(await client.query<{state:string;owner_id:string;plan_id:string}>(
      'SELECT state,owner_id,plan_id FROM agent_runs WHERE id=$1',[wakeup.parent_run_id])).rows[0]!;
    await client.query("UPDATE agent_runs SET state='FAILED',error_code='RUN_EXPIRED',finished_at=now() WHERE id=$1 AND state='RUNNING' AND deadline<=now()",[wakeup.parent_run_id]);
    if(parent.state==='RUNNING' && (await client.query("SELECT 1 FROM agent_runs WHERE id=$1 AND state='RUNNING'",[wakeup.parent_run_id])).rowCount){
      await client.query("UPDATE agent_wakeups SET next_run_at=now()+interval '3 seconds' WHERE id=$1",[wakeup.id]);return;
    }
    if(parent.state==='CANCELLED'){
      await client.query("UPDATE agent_wakeups SET state='failed',error_code='PARENT_CANCELLED' WHERE id=$1",[wakeup.id]);return;
    }
    if(wakeup.state==='dispatched'){
      const child=(await client.query<{state:string;expired:boolean;error_code:string|null}>(
        'SELECT state,deadline<=now() AS expired,error_code FROM agent_runs WHERE id=$1 FOR UPDATE',[wakeup.run_id])).rows[0]!;
      if(child.state==='RUNNING' && !child.expired)return;
      if(['COMPLETED','WAITING_USER','WAITING_EXTERNAL'].includes(child.state)){
        await client.query("UPDATE agent_wakeups SET state='completed' WHERE id=$1",[wakeup.id]);return;
      }
      const interrupted=(child.state==='RUNNING' && child.expired) || ['RUN_EXPIRED','RUN_INTERRUPTED'].includes(child.error_code??'');
      if(child.state==='RUNNING' && child.expired)await client.query("UPDATE agent_runs SET state='FAILED',error_code='RUN_EXPIRED',finished_at=now() WHERE id=$1 AND state='RUNNING'",[wakeup.run_id]);
      if(!interrupted || wakeup.attempts>=2){
        await client.query("UPDATE agent_wakeups SET state='failed',error_code=$2 WHERE id=$1",[wakeup.id,child.expired && child.state==='RUNNING'?'RUN_EXPIRED':child.error_code??'MODEL_UNAVAILABLE']);return;
      }
      await client.query("UPDATE agent_runs SET state='FAILED',error_code='RUN_EXPIRED',finished_at=now() WHERE id=$1 AND state='RUNNING'",[wakeup.run_id]);
    }
    const event=(await client.query<{type:string;data:{confirmationId?:string;proposalId?:string}}>(
      'SELECT type,data FROM events WHERE id=$1 AND plan_id=$2',[wakeup.event_id,parent.plan_id])).rows[0]!;
    const isConfirmation=['purchase.confirmed','change.confirmed'].includes(event.type);
    if(isConfirmation){
      const valid=await client.query(`SELECT 1 FROM confirmations c JOIN proposals p ON p.id=c.proposal_id
        JOIN agent_run_proposals ap ON ap.proposal_id=p.id WHERE ap.run_id=$1 AND c.id::text=$2 AND c.owner_id=$3
        AND p.status IN ('confirmed','executing')`,[wakeup.parent_run_id,event.data.confirmationId,parent.owner_id]);
      if(!valid.rowCount){await client.query("UPDATE agent_wakeups SET state='failed',error_code='CONFIRMATION_UNAVAILABLE' WHERE id=$1",[wakeup.id]);return;}
    }
    const row=(await client.query<{id:string;email:string;display_name:string;role:AuthUser['role']}>('SELECT id,email,display_name,role FROM users WHERE id=$1',[parent.owner_id])).rows[0]!;
    const user:AuthUser={id:row.id,email:row.email,displayName:row.display_name,role:row.role};
    const input=isConfirmation
      ?`服务端已记录用户确认。先读取当前计划与已有动作，仅继续本次${event.type==='purchase.confirmed'?'购买':'变更'}确认：confirmationId=${event.data.confirmationId}，proposalId=${event.data.proposalId}。${event.type==='purchase.confirmed'
        ?'为本次确认的每个项目创建或复用订单，再逐单调用 request_payment 读取模拟付款状态或准备沙箱付款交接；这些动作已在本次确认范围内，不再索要口头同意。模拟订单由后台任务处理，没有官方收银台；仅沙箱待付订单提示用户到付款卡片完成付款。'
        :'使用本次 proposalId 调用 submit_change，提交已确认变更；退款批次仍由商户执行。'}已建订单和已受理操作必须复用，失效授权停止并说明。不得生成或确认新方案。`
      :'当前计划收到关联业务的新事实。只读取最新业务快照并解释结果、未决金额和下一步责任，不执行任何写工具，不请求渠道查询。';
    try{
      const attempt=wakeup.attempts+1;
      const run=await createAgentRun(client,user,parent.plan_id,`event:${wakeup.id}:${attempt}`,input);
      await client.query('UPDATE agent_runs SET parent_run_id=$2,trigger_event_id=$3 WHERE id=$1',[run.runId,wakeup.parent_run_id,wakeup.event_id]);
      if(wakeup.run_id){
        // A replacement owns remaining observations; the expired attempt cannot keep spawning siblings.
        await client.query(`INSERT INTO agent_order_watches(run_id,order_id,kind,active,last_fact)
          SELECT $1,order_id,kind,active,last_fact FROM agent_order_watches WHERE run_id=$2 AND active
          ON CONFLICT DO NOTHING`,[run.runId,wakeup.run_id]);
        await client.query('UPDATE agent_order_watches SET active=false WHERE run_id=$1',[wakeup.run_id]);
      }
      await client.query("UPDATE agent_wakeups SET state='dispatched',run_id=$2,attempts=$3,next_run_at=now()+interval '3 seconds',error_code=NULL WHERE id=$1",[wakeup.id,run.runId,attempt]);
      return {runId:run.runId,planId:parent.plan_id,user,input};
    }catch(error){
      if(error instanceof AppError && ['AGENT_RUN_ACTIVE','AGENT_RATE_LIMIT'].includes(error.code)){
        await client.query("UPDATE agent_wakeups SET next_run_at=now()+interval '6 seconds' WHERE id=$1",[wakeup.id]);return;
      }
      throw error;
    }
  });
}
