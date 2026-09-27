import type { PoolClient } from 'pg';
import { AppError } from './errors.js';

/** Called inside the worker transaction after locking the account, period and order. */
export async function finishClosedOrderBudget(client: PoolClient, ownerId: string, orderId: string) {
  const item = (await client.query<{ id: string; periodId: string; status: string; hasPayment: boolean }>(`
    SELECT i.id,i.period_id AS "periodId",i.status,
      EXISTS(SELECT 1 FROM finance_money_events e WHERE e.order_id=o.id
        AND e.owner_id=o.owner_id AND e.event_type='payment_posted'
        AND e.verification_state='verified') AS "hasPayment"
    FROM orders o JOIN purchase_intents intent ON intent.id=o.purchase_intent_id
    JOIN budget_items i ON i.id=intent.budget_item_id AND i.owner_id=o.owner_id
    WHERE o.id=$1 AND o.owner_id=$2 AND o.payment_status='closed'
    FOR UPDATE OF i`, [orderId, ownerId])).rows[0];
  if (!item) return; // Legacy orders have no consumer budget item.
  if (item.hasPayment || item.status === 'settled') {
    throw new AppError(409, 'CONFIRMATION_SCOPE_MISMATCH', '关单与已入账付款证据冲突，保留原状态等待复核。');
  }
  if (item.status !== 'committed') return;
  await client.query("UPDATE budget_items SET status='cancelled' WHERE id=$1", [item.id]);
  await client.query(`INSERT INTO budget_events(owner_id,period_id,actor_id,type,data)
    VALUES($1,$2,NULL,'budget_item_cancelled',$3::jsonb)`, [ownerId, item.periodId,
    JSON.stringify({ itemId: item.id, orderId, reason: '原待付款订单已确认关闭' })]);
}
