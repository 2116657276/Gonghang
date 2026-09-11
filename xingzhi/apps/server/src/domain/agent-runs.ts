import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { AuthUser } from '../auth/session.js';
import { query, transaction } from '../db/client.js';
import { ownedPlan } from './access.js';
import { AppError, notFound } from './errors.js';
import { readAgentProposal } from './agent-proposals.js';

export async function startAgentRun(user: AuthUser, planId: string, key: string, input: string) {
  return transaction(client=>createAgentRun(client,user,planId,key,input));
}

export async function createAgentRun(client:PoolClient,user:AuthUser,planId:string,key:string,input:string) {
    const plan = await ownedPlan(client, planId, user, true);
    const existing = await client.query<{ id: string; input: string }>('SELECT id,input FROM agent_runs WHERE plan_id=$1 AND trigger_key=$2', [planId,key]);
    if (existing.rows[0]) {
      if (existing.rows[0].input !== input) throw new AppError(409,'IDEMPOTENCY_CONFLICT','同一请求标识不能用于不同消息。');
      return { runId: existing.rows[0].id, reused: true };
    }
    await client.query("UPDATE agent_runs SET state='FAILED',error_code='RUN_EXPIRED',finished_at=now() WHERE plan_id=$1 AND state='RUNNING' AND deadline<=now()", [planId]);
    if ((await client.query("SELECT 1 FROM agent_runs WHERE plan_id=$1 AND state='RUNNING'",[planId])).rowCount) {
      throw new AppError(409,'AGENT_RUN_ACTIVE','该计划已有运行，请等待或取消。');
    }
    await client.query('INSERT INTO agent_rate_limits(owner_id,tokens) VALUES($1,2) ON CONFLICT DO NOTHING',[user.id]);
    const rate = await client.query<{ available: number }>(`SELECT LEAST(2,tokens+GREATEST(0,EXTRACT(EPOCH FROM (clock_timestamp()-updated_at)))/6) AS available
      FROM agent_rate_limits WHERE owner_id=$1 FOR UPDATE`,[user.id]);
    if (rate.rows[0]!.available < 1) throw new AppError(429,'AGENT_RATE_LIMIT','请求过于频繁，请稍后重试。');
    await client.query('UPDATE agent_rate_limits SET tokens=$2,updated_at=clock_timestamp() WHERE owner_id=$1',[user.id,rate.rows[0]!.available-1]);
    const runId = randomUUID();
    await client.query("INSERT INTO agent_runs(id,plan_id,owner_id,trigger_key,input,snapshot_version,state) VALUES($1,$2,$3,$4,$5,$6,'RUNNING')",
      [runId,planId,user.id,key,input,plan.version]);
    return { runId, reused: false };
}

export async function readAgentRun(user: AuthUser, runId: string) {
  if (user.role !== 'consumer') notFound();
  await query(`UPDATE agent_runs r SET state='COMPLETED' WHERE id=$1 AND owner_id=$2 AND state='WAITING_EXTERNAL'
    AND NOT EXISTS(SELECT 1 FROM agent_order_watches w WHERE w.run_id=r.id AND w.active)`,[runId,user.id]);
  await query("UPDATE agent_runs SET state='FAILED',error_code='RUN_EXPIRED',finished_at=now() WHERE id=$1 AND owner_id=$2 AND state='RUNNING' AND deadline<=now()",[runId,user.id]);
  const result = await query<{id:string;plan_id:string;state:string;output:string;error_code:string|null;model_calls:number;tool_calls:number;snapshot_version:number;created_at:Date;finished_at:Date|null}>('SELECT id,plan_id,state,output,error_code,model_calls,tool_calls,snapshot_version,created_at,finished_at,parent_run_id,trigger_event_id FROM agent_runs WHERE id=$1 AND owner_id=$2',[runId,user.id]);
  if (!result.rows[0]) notFound();
  const actions=await query('SELECT tool_name AS "toolName",response_payload AS result FROM agent_tool_calls WHERE run_id=$1 ORDER BY created_at,tool_call_id',[runId]);
  const root=(await query<{id:string}>(`WITH RECURSIVE ancestors AS (
    SELECT id,parent_run_id FROM agent_runs WHERE id=$1
    UNION ALL SELECT r.id,r.parent_run_id FROM agent_runs r JOIN ancestors a ON r.id=a.parent_run_id
  ) SELECT id FROM ancestors WHERE parent_run_id IS NULL`,[runId])).rows[0]!;
  const queued=(await query<{count:number;failed:boolean}>(`WITH RECURSIVE branch AS (
    SELECT id FROM agent_runs WHERE id=$1
    UNION ALL SELECT r.id FROM agent_runs r JOIN branch b ON r.parent_run_id=b.id
  ) SELECT ((SELECT count(*) FROM agent_wakeups WHERE parent_run_id IN (SELECT id FROM branch) AND state IN ('pending','dispatched'))
    + (SELECT count(*) FROM agent_order_watches WHERE run_id IN (SELECT id FROM branch) AND active))::int AS count,
    EXISTS(SELECT 1 FROM agent_wakeups WHERE parent_run_id IN (SELECT id FROM branch) AND state='failed'
      AND error_code NOT IN ('RUN_CANCELLED','PARENT_CANCELLED')) AS failed`,[root.id])).rows[0]!;
  return {...result.rows[0],proposal:await readAgentProposal(user,runId),actions:actions.rows,
    pendingFollowups:queued.count,followupFailed:queued.failed,followupRootId:root.id};
}

export async function latestAgentRun(user: AuthUser, planId: string) {
  await transaction(client=>ownedPlan(client,planId,user));
  const result=await query<{id:string}>('SELECT id FROM agent_runs WHERE plan_id=$1 AND owner_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[planId,user.id]);
  return result.rows[0]?readAgentRun(user,result.rows[0].id):null;
}

export async function cancelAgentRun(user: AuthUser, runId: string) {
  const run=await readAgentRun(user,runId);
  await transaction(async client=>{
    await ownedPlan(client,run.plan_id,user,true);
    // Stop this branch, including a recovery already dispatched from its confirmation.
    const branch=(await client.query<{id:string}>(`WITH RECURSIVE branch AS (
      SELECT id FROM agent_runs WHERE id=$1 AND owner_id=$2
      UNION ALL SELECT r.id FROM agent_runs r JOIN branch b ON r.parent_run_id=b.id
    ) SELECT id FROM branch`,[runId,user.id])).rows.map(row=>row.id);
    await client.query("UPDATE agent_runs SET state='CANCELLED',finished_at=now() WHERE id=ANY($1::uuid[]) AND state IN ('RUNNING','WAITING_USER','WAITING_EXTERNAL')",[branch]);
    await client.query("UPDATE agent_wakeups SET state='failed',error_code='RUN_CANCELLED' WHERE (parent_run_id=ANY($1::uuid[]) OR run_id=ANY($1::uuid[])) AND state IN ('pending','dispatched')",[branch]);
    await client.query('UPDATE agent_order_watches SET active=false WHERE run_id=ANY($1::uuid[])',[branch]);
  });
  return readAgentRun(user,runId);
}

export async function assertAgentRunActive(runId: string) {
  if (!(await query("SELECT 1 FROM agent_runs WHERE id=$1 AND state='RUNNING' AND deadline>now()",[runId])).rowCount) {
    throw new AppError(409,'AGENT_RUN_STOPPED','运行已结束或取消。');
  }
}
