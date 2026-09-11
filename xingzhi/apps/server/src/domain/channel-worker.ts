import type { PoolClient } from 'pg';
import { transaction } from '../db/client.js';
import { config } from '../config.js';
import { closeAlipayTrade, queryAlipayTrade, queryAlipayRefund, refundAlipayTrade, refundQueryConfirmed, yuanToMinor } from '../payment/alipay-sandbox.js';
import { appendEvent } from './events.js';
import { ensureManualTask } from './aftercare.js';
import type { ClaimedJob } from './worker-runtime.js';

export const channelAdapter = { queryTrade: queryAlipayTrade, closeTrade: closeAlipayTrade, refund: refundAlipayTrade, queryRefund: queryAlipayRefund };
type Context = {
  order_id: string; plan_id: string; merchant_id: string; amount_minor: number; refunded_minor: number;
  payment_status: string; business_number: string; environment: string; provider: string;
  cancellation_id: string | null; batch_id: string | null; refund_number: string | null; refund_amount: number | null;
  batch_status: string | null; accepted_refund_minor: number | null; cancellation_status: string | null;
  sent_at: Date | null; created_at: Date; attempt_count: number; purpose: string; authorization_id: string | null;
};

async function lockContext(client: PoolClient, job: ClaimedJob) {
  await client.query('SELECT id FROM plans WHERE id=$1 FOR UPDATE', [job.plan_id]);
  const result = await client.query<Context>(`SELECT o.id AS order_id,o.plan_id,o.merchant_id,o.amount_minor,o.refunded_minor,
    o.payment_status,p.business_number,o.environment,o.provider,c.id AS cancellation_id,b.id AS batch_id,
    b.business_number AS refund_number,b.amount_minor AS refund_amount,b.status AS batch_status,
    c.accepted_refund_minor,c.status AS cancellation_status,op.sent_at,op.created_at,op.attempt_count,op.purpose,op.authorization_id
    FROM operations op
    LEFT JOIN refund_batches b ON op.type IN ('sandbox_refund','sandbox_refund_recheck') AND b.id=op.entity_id
    LEFT JOIN cancellation_requests c ON c.id=b.cancellation_request_id
    JOIN orders o ON o.id=CASE WHEN op.type IN ('sandbox_refund','sandbox_refund_recheck') THEN b.order_id ELSE op.entity_id END
    JOIN payment_attempts p ON p.order_id=o.id WHERE op.id=$1 AND o.plan_id=$2 FOR UPDATE OF o`, [job.operation_id,job.plan_id]);
  const ctx=result.rows[0];
  const lease=await client.query(`SELECT j.id FROM jobs j JOIN operations op ON op.id=j.operation_id
    WHERE j.id=$1 AND op.id=$2 AND j.state='leased' AND j.lease_version=$3 AND op.lease_version=$4
      AND j.lease_until>now() AND op.state='processing' FOR UPDATE OF j,op`,
  [job.job_id,job.operation_id,job.job_lease_version,job.operation_lease_version]);
  if(!lease.rowCount) return;
  if(!ctx || ctx.environment!=='sandbox' || ctx.provider!=='alipay') throw new Error('渠道任务环境或对象不一致。');
  if(ctx.batch_id) {
    const batch=await client.query(`SELECT id FROM refund_batches WHERE id=$1 AND environment='sandbox' AND provider='alipay'
      AND merchant_id=$2 FOR UPDATE`,[ctx.batch_id,ctx.merchant_id]);
    if(!batch.rowCount) throw new Error('退款批次环境不一致。');
    await client.query('SELECT id FROM cancellation_requests WHERE id=$1 FOR UPDATE',[ctx.cancellation_id]);
  }
  return ctx;
}

type Outcome = { state: 'succeeded' | 'unknown' | 'pending_review'; action: 'closed' | 'paid' | 'refunded' | 'waiting'; evidence: Record<string,unknown> };
export async function processChannelJob(job: ClaimedJob, adapter = channelAdapter) {
  // Configuration is checked before any external access, including recovery queries.
  if(config.paymentMode!=='sandbox') return false;
  const ctx=await transaction(async client=>{
    const ctx=await lockContext(client,job);if(!ctx)return;
    if(ctx.purpose.startsWith('consumer_query:')) {
      const active=await client.query(`SELECT id FROM authorizations WHERE id=$1 AND type='query' AND status='active'
        AND expires_at>now() AND (scope->'orderIds') ? $2`,[ctx.authorization_id,ctx.order_id]);
      if(!active.rowCount) {
        await client.query("UPDATE operations SET state='failed',lease_until=NULL,result=$2 WHERE id=$1",[job.operation_id,{reason:'受托查询授权已失效'}]);
        await client.query("UPDATE jobs SET state='complete',lease_until=NULL WHERE id=$1",[job.job_id]);
        await appendEvent(client,ctx.plan_id,null,'query.authorization_expired',{operationId:job.operation_id});
        return;
      }
    }
    if(job.type==='sandbox_close' && !ctx.sent_at) {
      const auth=await client.query(`SELECT a.id FROM authorizations a JOIN operations op ON op.authorization_id=a.id
        WHERE op.id=$1 AND a.type='aftercare' AND a.status='active' AND a.expires_at>now()
          AND (a.scope->'orderIds') ? $2`,[job.operation_id,ctx.order_id]);
      if(!auth.rowCount) return {...ctx,blocked:true};
    }
    if(job.type==='sandbox_refund' && (!['approved','refund_processing'].includes(ctx.cancellation_status ?? '') || ctx.payment_status!=='paid')) {
      return {...ctx,blocked:true};
    }
    if(job.type==='sandbox_refund' && !ctx.sent_at) {
      if(!ctx.refund_amount || ctx.refunded_minor+ctx.refund_amount>ctx.amount_minor) return {...ctx,blocked:true};
      await client.query("UPDATE refund_batches SET status='processing',updated_at=now() WHERE id=$1",[ctx.batch_id]);
    }
    await client.query('UPDATE operations SET sent_at=COALESCE(sent_at,now()) WHERE id=$1',[job.operation_id]);
    return {...ctx,blocked:false};
  });
  if(!ctx)return false;
  let outcome:Outcome={state:'unknown',action:'waiting',evidence:{reason:'等待原业务编号核验'}};
  try {
    if(ctx.blocked) outcome={state:'pending_review',action:'waiting',evidence:{reason:'当前授权、取消决定或金额条件不满足'}};
    else if(job.type==='sandbox_refund' || job.type==='sandbox_refund_recheck') {
      if(job.type==='sandbox_refund' && !ctx.sent_at) {
        const receipt=await adapter.refund(ctx.business_number,ctx.refund_number!,ctx.refund_amount!);
        outcome.evidence={...receipt,source:'alipay_refund',nextAction:'至少等待 15 秒后按本批次退款号查询'};
      } else {
        const receipt=await adapter.queryRefund(ctx.business_number,ctx.refund_number!);
        outcome={state:refundQueryConfirmed(receipt,ctx.business_number,ctx.refund_number!,ctx.refund_amount!)?'succeeded':'unknown',
          action:refundQueryConfirmed(receipt,ctx.business_number,ctx.refund_number!,ctx.refund_amount!)?'refunded':'waiting',
          evidence:{...receipt,source:'alipay_refund_query'}};
      }
    } else {
      const receipt=await adapter.queryTrade(ctx.business_number);
      const matched=receipt.code==='10000' && receipt.outTradeNo===ctx.business_number
        && typeof receipt.totalAmount==='string' && yuanToMinor(receipt.totalAmount)===ctx.amount_minor
        && (!receipt.sellerId || receipt.sellerId===config.alipaySandbox.sellerId);
      outcome.evidence={...receipt,source:'alipay_query'};
      if(matched && ['TRADE_SUCCESS','TRADE_FINISHED'].includes(receipt.tradeStatus ?? '')) {
        outcome={state:job.type==='sandbox_close'?'pending_review':'succeeded',action:'paid',evidence:{...receipt,source:'alipay_query',reason:'已确认付款，不能沿用未付关单授权退款'}};
      } else if(matched && receipt.tradeStatus==='TRADE_CLOSED' && ctx.payment_status!=='paid' && ctx.refunded_minor===0) {
        outcome={state:'succeeded',action:'closed',evidence:{...receipt,source:'alipay_query'}};
      } else if(matched && receipt.tradeStatus==='WAIT_BUYER_PAY' && job.type==='sandbox_close' && ctx.attempt_count<=3) {
        const closed=await adapter.closeTrade(ctx.business_number);
        outcome.evidence={...closed,source:'alipay_close',nextAction:'按原单查询关单结果'};
      }
    }
  } catch {
    outcome={state:'unknown',action:'waiting',evidence:{reason:'渠道通信未取得可核验结果，保留占用并查原号'}};
  }
  await transaction(async client=>{
    const current=await lockContext(client,job);if(!current)return;
    const observedTradeNo=typeof outcome.evidence.tradeNo==='string'?outcome.evidence.tradeNo:null;
    const observedTradeStatus=typeof outcome.evidence.tradeStatus==='string'?outcome.evidence.tradeStatus:null;
    if(observedTradeNo || observedTradeStatus) {
      await client.query(`UPDATE payment_attempts
        SET provider_trade_no=COALESCE($2,provider_trade_no), provider_status=COALESCE($3,provider_status), observed_at=now()
        WHERE order_id=$1`,[current.order_id,observedTradeNo,observedTradeStatus]);
    }
    if(outcome.action==='refunded' && current.batch_status!=='succeeded') {
      const total=await client.query<{total:number}>("SELECT COALESCE(SUM(amount_minor),0)::int AS total FROM refund_batches WHERE cancellation_request_id=$1 AND status='succeeded'",[current.cancellation_id]);
      const next=total.rows[0]!.total+current.refund_amount!;
      if(next>current.accepted_refund_minor! || current.refunded_minor+current.refund_amount!>current.amount_minor) throw new Error('渠道退款核验金额超出原单或确认总额。');
      const completed=next===current.accepted_refund_minor;
      await client.query("UPDATE refund_batches SET status='succeeded',updated_at=now() WHERE id=$1",[current.batch_id]);
      await client.query('UPDATE orders SET refunded_minor=refunded_minor+$2,status=$3,updated_at=now() WHERE id=$1',[current.order_id,current.refund_amount,completed?'cancelled':'cancellation_processing']);
      await client.query('UPDATE cancellation_requests SET status=$2,updated_at=now() WHERE id=$1',[current.cancellation_id,completed?'completed':'refund_processing']);
      await client.query(`UPDATE operations SET state='succeeded',result=$2,channel_evidence=$2,lease_until=NULL
        WHERE id=(SELECT operation_id FROM refund_batches WHERE id=$1)`,[current.batch_id,outcome.evidence]);
      await client.query(`UPDATE jobs SET state='complete',lease_until=NULL WHERE operation_id=(SELECT operation_id FROM refund_batches WHERE id=$1)`,[current.batch_id]);

    } else if(outcome.action==='paid' && current.payment_status!=='paid') {
      if(['closed','failed'].includes(current.payment_status) || current.refunded_minor>0) {
        outcome={state:'pending_review',action:'waiting',evidence:{...outcome.evidence,reason:'渠道付款观察与已关单或退款事实冲突'}};
      } else {
        await client.query("UPDATE orders SET payment_status='paid',status='fulfilling',updated_at=now() WHERE id=$1",[current.order_id]);
        await client.query("UPDATE payment_attempts SET status='paid',observed_at=now() WHERE order_id=$1",[current.order_id]);
      }
    } else if(outcome.action==='closed') {
      if(current.payment_status==='paid' || current.refunded_minor>0) {
        outcome={state:'pending_review',action:'waiting',evidence:{reason:'关单观察与本地付款事实冲突'}};
      } else {
        await client.query("UPDATE orders SET payment_status='closed',status='cancelled',reserved_minor=0,updated_at=now() WHERE id=$1",[current.order_id]);
        await client.query("UPDATE payment_attempts SET status='closed',observed_at=now() WHERE order_id=$1",[current.order_id]);
      }
    }
    const explicitQuery=job.type==='sandbox_refund_recheck' || job.type==='sandbox_payment_recheck';
    const manual=(explicitQuery && outcome.state==='unknown') || outcome.state==='pending_review' || (outcome.state==='unknown' && Date.now()-current.created_at.getTime()>=30*60_000);
    if(manual) {
      outcome.state='pending_review';
      await ensureManualTask(client,{dedupeKey:`channel:${job.operation_id}`,planId:current.plan_id,merchantId:current.merchant_id,
        orderId:current.order_id,cancellationRequestId:current.cancellation_id??undefined,refundBatchId:current.batch_id??undefined,
        operationId:job.operation_id,type:current.batch_id?'refund_recheck':'operation_recheck',reason:String(outcome.evidence.reason??'渠道结果等待超时'),nextAction:'核对原操作及原业务编号，不新增替代退款号。'});
    }
    if(current.batch_id && outcome.state!=='succeeded' && !explicitQuery) await client.query('UPDATE refund_batches SET status=$2,updated_at=now() WHERE id=$1',[current.batch_id,outcome.state]);
    const retry=outcome.state==='unknown';
    const seconds=Math.min(300,15*Math.pow(2,Math.min(current.attempt_count-1,5)));
    await client.query(`UPDATE operations SET state=$2,result=$3,channel_evidence=$3,lease_until=NULL,
      next_run_at=now()+$4*interval '1 second',updated_at=now() WHERE id=$1`,[job.operation_id,outcome.state,{...outcome.evidence,observedAt:new Date().toISOString()},seconds]);
    await client.query("UPDATE jobs SET state=$2,lease_until=NULL,next_run_at=now()+$3*interval '1 second',updated_at=now() WHERE id=$1",[job.job_id,retry?'pending':'complete',seconds]);
    if(outcome.state==='succeeded') await client.query("UPDATE manual_tasks SET state='resolved',resolved_at=now(),updated_at=now() WHERE operation_id=$1 AND state<>'resolved'",[job.operation_id]);
    await appendEvent(client,current.plan_id,null,`sandbox.${job.type}.${outcome.state}`,{operationId:job.operation_id,...outcome.evidence});
  });
  return true;
}
