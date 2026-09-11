import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';

type OrderFact = { paymentStatus:string; status:string; refundedMinor:number; cancellations:unknown; batches:unknown; responsibilities:unknown };

async function orderFact(client:PoolClient,orderId:string):Promise<OrderFact> {
  return (await client.query<OrderFact>(`SELECT o.payment_status AS "paymentStatus",o.status,o.refunded_minor AS "refundedMinor",
    COALESCE((SELECT jsonb_agg(jsonb_build_array(c.id,c.status,c.decision) ORDER BY c.id)
      FROM cancellation_requests c WHERE c.order_id=o.id),'[]') AS cancellations,
    COALESCE((SELECT jsonb_agg(jsonb_build_array(b.id,b.status,b.amount_minor) ORDER BY b.id)
      FROM refund_batches b WHERE b.order_id=o.id),'[]') AS batches,
    COALESCE((SELECT jsonb_agg(jsonb_build_array(t.id,t.state,t.claimed_by,t.next_action) ORDER BY t.id)
      FROM manual_tasks t WHERE t.order_id=o.id),'[]') AS responsibilities
    FROM orders o WHERE o.id=$1`,[orderId])).rows[0]!;
}

function terminal(kind:string,fact:OrderFact) {
  return kind==='purchase' ? ['paid','closed'].includes(fact.paymentStatus)
    : ['cancelled','cancellation_rejected'].includes(fact.status);
}

export async function watchAgentOrder(client:PoolClient,runId:string,orderId:string,kind:'purchase'|'change') {
  const fact=await orderFact(client,orderId);
  await client.query(`INSERT INTO agent_order_watches(run_id,order_id,kind,active,last_fact) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(run_id,order_id) DO UPDATE SET kind=EXCLUDED.kind,active=EXCLUDED.active,last_fact=EXCLUDED.last_fact
    WHERE agent_order_watches.kind<>EXCLUDED.kind`,[runId,orderId,kind,!terminal(kind,fact),fact]);
}

// Called in the business-event transaction. Enqueuing never invokes a model.
export async function enqueueAgentEvent(client:PoolClient,eventId:string,planId:string,type:string,data:Record<string,unknown>) {
  if(type==='purchase.confirmed' || type==='change.confirmed'){
    await client.query(`INSERT INTO agent_wakeups(parent_run_id,event_id,event_key)
      SELECT r.id,$1,$2 FROM agent_run_proposals p JOIN agent_runs r ON r.id=p.run_id
      WHERE p.proposal_id::text=$3 AND r.plan_id=$4 AND r.state='WAITING_USER'
      ON CONFLICT DO NOTHING`,[eventId,`confirmation:${String(data.confirmationId)}`,String(data.proposalId),planId]);
    return;
  }
  if(!/^(simulation\.(payment|close|refund)|sandbox\.(sandbox_|payment_|notification_)|cancellation\.(decided|auto_decided)|refund_batch\.|manual_task\.)/.test(type))return;
  const watches=await client.query<{run_id:string;order_id:string;kind:string;last_fact:OrderFact|null}>(`
    SELECT w.run_id,w.order_id,w.kind,w.last_fact FROM agent_order_watches w
    JOIN orders o ON o.id=w.order_id JOIN agent_runs r ON r.id=w.run_id
    WHERE o.plan_id=$1 AND w.active AND r.state<>'CANCELLED' FOR UPDATE OF w`,[planId]);
  for(const watch of watches.rows){
    const fact=await orderFact(client,watch.order_id);
    if(!isDeepStrictEqual(watch.last_fact,fact)){
      // Stable business facts exclude observation time and the IDs of read-only queries.
      await client.query('INSERT INTO agent_wakeups(parent_run_id,event_id,event_key) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [watch.run_id,eventId,JSON.stringify([watch.order_id,fact])]);
    }
    await client.query('UPDATE agent_order_watches SET active=$3,last_fact=$4 WHERE run_id=$1 AND order_id=$2',
      [watch.run_id,watch.order_id,!terminal(watch.kind,fact),fact]);
  }
}
