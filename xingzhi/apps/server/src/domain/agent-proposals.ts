import { isDeepStrictEqual } from 'node:util';
import type { AuthUser } from '../auth/session.js';
import { query, transaction } from '../db/client.js';
import { ownedPlan } from './access.js';
import { AppError, notFound } from './errors.js';
import { createPurchaseProposal, createChangeProposal } from './proposals.js';

export async function createAgentProposal(user: AuthUser, planId: string, runId: string, toolCallId: string,
  toolName: 'propose_purchase'|'propose_change', input: unknown) {
  return transaction(async client => {
    // Drafts, execution and cancellation all lock plan before run.
    await ownedPlan(client,planId,user,true);
    const result=await client.query<{state:string;active:boolean;trigger_event_id:string|null}>(`SELECT state,deadline>now() AS active,trigger_event_id FROM agent_runs
      WHERE id=$1 AND plan_id=$2 AND owner_id=$3 FOR UPDATE`,[runId,planId,user.id]);
    const run=result.rows[0];if(!run)notFound();
    const existing=await client.query<{tool_call_id:string;tool_name:string;request_payload:unknown;proposal_id:string}>(
      'SELECT tool_call_id,tool_name,request_payload,proposal_id FROM agent_run_proposals WHERE run_id=$1',[runId]);
    const prior=existing.rows[0];
    if(prior){
      if(prior.tool_call_id!==toolCallId || prior.tool_name!==toolName || !isDeepStrictEqual(prior.request_payload,input)) {
        throw new AppError(409,'AGENT_DRAFT_EXISTS','本轮已有待确认方案，请先查看。');
      }
      return {proposalId:prior.proposal_id,type:toolName==='propose_purchase'?'purchase':'change'};
    }
    if(run.trigger_event_id)throw new AppError(422,'EVENT_CANNOT_PROPOSE','事件恢复不能生成新的待确认方案。');
    if(run.state!=='RUNNING' || !run.active)throw new AppError(409,'AGENT_RUN_STOPPED','运行已结束，不能创建新方案。');
    const proposal=toolName==='propose_purchase'
      ?await createPurchaseProposal(client,user,planId,input)
      :await createChangeProposal(client,user,planId,input);
    await client.query('INSERT INTO agent_run_proposals(run_id,tool_call_id,tool_name,request_payload,proposal_id) VALUES($1,$2,$3,$4,$5)',
      [runId,toolCallId,toolName,input,proposal.proposalId]);
    await client.query("UPDATE agent_runs SET state='WAITING_USER',output='方案已生成，请查看范围与金额后在确认卡片中决定。尚未确认或执行任何交易。',finished_at=now() WHERE id=$1",[runId]);
    return {proposalId:proposal.proposalId,type:toolName==='propose_purchase'?'purchase':'change'};
  });
}

export async function readAgentProposal(user: AuthUser, runId: string) {
  const result=await query(`SELECT p.id,p.type,p.status,p.plan_version,p.expires_at,p.snapshot,c.id AS confirmation_id,
      p.expires_at>now() AND p.plan_version=plans.version AND p.status='pending' AS confirmable
    FROM agent_run_proposals a JOIN agent_runs r ON r.id=a.run_id
    JOIN proposals p ON p.id=a.proposal_id JOIN plans ON plans.id=p.plan_id
    LEFT JOIN confirmations c ON c.proposal_id=p.id
    WHERE a.run_id=$1 AND r.owner_id=$2 AND p.owner_id=$2`,[runId,user.id]);
  const row=result.rows[0];
  return row?{proposalId:row.id,type:row.type,status:row.status,version:row.plan_version,expiresAt:row.expires_at,
    confirmable:row.confirmable,confirmationId:row.confirmation_id,...row.snapshot}:null;
}
