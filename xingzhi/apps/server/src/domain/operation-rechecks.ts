import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AuthUser } from '../auth/session.js';
import { AppError, forbidden, notFound } from './errors.js';
import { appendEvent } from './events.js';
import { createOperationJob } from './jobs.js';
import { ensureManualTask } from './aftercare.js';
import { sandboxReadiness } from '../payment/alipay-sandbox.js';

export const recheckInput = z.object({
  reason: z.string().trim().min(2).max(200),
});

async function relatedOrderForOperation(client: PoolClient, type: string, entityId: string) {
  if (['simulate_payment', 'simulate_close', 'sandbox_payment_handoff', 'sandbox_payment_recheck', 'sandbox_close'].includes(type)) {
    const result = await client.query<{ order_id: string; merchant_id: string }>(
      `SELECT o.id AS order_id,COALESCE(o.merchant_id,m.merchant_id) AS merchant_id
       FROM orders o LEFT JOIN consumer_order_merchants m ON m.order_id=o.id WHERE o.id=$1`, [entityId],
    );
    return result.rows[0];
  }
  if (['simulate_refund', 'merchant_cancellation_review'].includes(type)) {
    const result = await client.query<{ order_id: string; merchant_id: string }>(`
      SELECT cancellation_requests.order_id,COALESCE(orders.merchant_id,m.merchant_id) AS merchant_id
      FROM cancellation_requests JOIN orders ON orders.id = cancellation_requests.order_id
      LEFT JOIN consumer_order_merchants m ON m.order_id=orders.id
      WHERE cancellation_requests.id = $1`, [entityId]);
    return result.rows[0];
  }
  if (['simulate_refund_batch', 'sandbox_refund', 'sandbox_refund_recheck'].includes(type)) {
    const result = await client.query<{ order_id: string; merchant_id: string }>(
      'SELECT order_id, merchant_id FROM refund_batches WHERE id = $1', [entityId],
    );
    return result.rows[0];
  }
}

export async function requestOperationRecheck(
  client: PoolClient,
  user: AuthUser,
  operationId: string,
  rawInput: unknown,
) {
  const input = recheckInput.parse(rawInput);
  const operationResult = await client.query<{ id: string; plan_id: string | null; budget_period_id: string | null;
    owner_id: string; type: string; entity_id: string }>(
    `SELECT id,plan_id,budget_period_id,owner_id,type,entity_id
     FROM operations WHERE id=$1 FOR UPDATE`, [operationId],
  );
  const operation = operationResult.rows[0];
  if (!operation) notFound('未找到可复核的操作。');
  if (operation.plan_id) await client.query('SELECT id FROM plans WHERE id=$1 FOR UPDATE', [operation.plan_id]);
  else if (operation.budget_period_id) {
    await client.query('SELECT id FROM budget_periods WHERE id=$1 FOR UPDATE', [operation.budget_period_id]);
  } else notFound('未找到可复核的操作。');
  const order = await relatedOrderForOperation(client, operation.type, operation.entity_id);
  if (!order) throw new AppError(422, 'RECHECK_NOT_AVAILABLE', '该操作没有可复核的交易订单。');
  let queryAuthorizationId: string | undefined;
  if (user.role === 'consumer') {
    if (operation.owner_id !== user.id) notFound('未找到可复核的操作。');
    if (!operation.plan_id) {
      throw new AppError(422, 'QUERY_AUTHORIZATION_INACTIVE', '新预算订单请从订单售后入口复核。');
    }
    const authorization = await client.query<{ id: string }>(`SELECT id FROM authorizations
      WHERE plan_id = $1 AND owner_id = $2 AND type = 'query' AND status = 'active' AND expires_at > now()
        AND (scope -> 'orderIds') ? $3`, [operation.plan_id, user.id, order.order_id]);
    if (!authorization.rowCount) throw new AppError(422, 'QUERY_AUTHORIZATION_INACTIVE', '查询授权已撤回或过期，不能新增受托复核。');
    queryAuthorizationId = authorization.rows[0]!.id;
  } else if (user.role === 'merchant_admin') {
    if (order.merchant_id !== user.id) notFound('未找到可复核的操作。');
  } else {
    forbidden('当前身份不能请求交易复核。');
  }
  const target = await client.query<{ environment: string }>('SELECT environment FROM orders WHERE id=$1', [order.order_id]);
  if (target.rows[0]?.environment === 'sandbox') {
    if (!sandboxReadiness().ready) throw new AppError(422, 'PAYMENT_SANDBOX_NOT_READY', '沙箱查询配置尚未就绪。');
    const purpose = `${queryAuthorizationId ? 'consumer_query' : 'merchant_query'}:${operation.id}:${user.id}:${queryAuthorizationId ?? 'merchant'}`;
    // Different idempotency keys can still represent the same user action. Serialize the
    // purpose check so concurrent retries cannot create two channel recheck operations.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`recheck:${purpose}`]);
    const existing = await client.query<{ id: string }>(`SELECT id FROM operations WHERE purpose=$1
      AND (state IN ('accepted','processing') OR created_at>now()-interval '15 seconds') ORDER BY created_at DESC LIMIT 1`, [purpose]);
    if (existing.rows[0]) return { operationId: operation.id, recheckOperationId: existing.rows[0].id, status: 'accepted', reused: true };
    const refund = ['sandbox_refund', 'sandbox_refund_recheck'].includes(operation.type);
    const recheckOperationId = await createOperationJob(client, {
      ...(operation.plan_id ? { planId: operation.plan_id } : { budgetPeriodId: operation.budget_period_id! }),
      ownerId: operation.owner_id,
      type: refund ? 'sandbox_refund_recheck' : 'sandbox_payment_recheck',
      entityId: refund ? operation.entity_id : order.order_id,
      authorizationId: queryAuthorizationId,
      purpose,
    });
    // Refund observations must wait at least 15 seconds after the original send.
    await client.query(`UPDATE jobs SET next_run_at=GREATEST(now(),COALESCE((SELECT sent_at+interval '15 seconds'
      FROM operations WHERE id=$2),now())) WHERE operation_id=$1`, [recheckOperationId, operation.id]);
    if (operation.plan_id) {
      await appendEvent(client, operation.plan_id, user.id, 'operation.recheck_scheduled', { operationId: operation.id, recheckOperationId });
    } else {
      await client.query(`INSERT INTO budget_events(owner_id,period_id,actor_id,type,data)
        VALUES($1,$2,$3,'operation.recheck_scheduled',$4)`, [operation.owner_id,
      operation.budget_period_id, user.id, { operationId: operation.id, recheckOperationId }]);
    }
    return { operationId: operation.id, recheckOperationId, status: 'accepted', source: 'scheduled' };
  }
  const task = await ensureManualTask(client, {
    dedupeKey: `operation-recheck:${operation.id}`,
    ...(operation.plan_id ? { planId: operation.plan_id, merchantId: order.merchant_id }
      : { budgetPeriodId: operation.budget_period_id!, responsibleProvider: 'merchant' }),
    orderId: order.order_id, operationId: operation.id, type: 'operation_recheck', reason: input.reason,
    nextAction: '按原业务编号复核既有交易；不得改写退款金额或手工填报资金成功。',
  });
  if (operation.plan_id) {
    await appendEvent(client, operation.plan_id, user.id, 'operation.recheck_requested', {
      operationId: operation.id, taskId: task.id, requesterRole: user.role,
    });
  } else {
    await client.query(`INSERT INTO budget_events(owner_id,period_id,actor_id,type,data)
      VALUES($1,$2,$3,'operation.recheck_requested',$4)`, [operation.owner_id,
    operation.budget_period_id, user.id, { operationId: operation.id, taskId: task.id, requesterRole: user.role }]);
  }
  return { operationId: operation.id, manualTaskId: task.id, status: 'accepted' };
}
