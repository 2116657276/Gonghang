import type { PoolClient } from 'pg';
import type { PlanSnapshot } from '@xingzhi/contracts';
import type { AuthUser } from '../auth/session.js';
import { listPausedIds, readablePlan } from './access.js';
import { remainingBudget, sumMinor } from './money.js';

type PlanItemRow = {
  id: string;
  catalog_item_id: string | null;
  name: string;
  kind: PlanSnapshot['items'][number]['kind'];
  price_minor: number;
  status: string;
};

type OrderRow = {
  id: string;
  plan_item_id: string;
  item_name: string;
  amount_minor: number;
  status: string;
  payment_status: string;
  simulation_mode: string;
  close_simulation_mode: string;
  refund_simulation_mode: string;
  reserved_minor: number;
  refunded_minor: number;
  environment: 'simulation' | 'sandbox';
  provider: 'simulation' | 'alipay';
};

type AuthorizationRow = {
  id: string;
  type: 'purchase' | 'aftercare' | 'query';
  status: string;
  scope: { itemIds?: string[]; orderIds?: string[] };
  expires_at: Date;
};

type CancellationRow = {
  id: string;
  order_id: string;
  status: string;
  decision: string | null;
  decision_reason: string | null;
  accepted_fee_minor: number;
  accepted_refund_minor: number;
  updated_at: Date;
};

type RefundBatchRow = {
  id: string;
  operation_id: string | null;
  cancellation_request_id: string;
  batch_number: number;
  amount_minor: number;
  status: string;
  updated_at: Date;
};

type ManualTaskRow = {
  id: string;
  order_id: string | null;
  cancellation_request_id: string | null;
  type: string;
  state: string;
  reason: string;
  next_action: string;
  next_review_at: Date;
};

export async function planSnapshot(client: PoolClient, planId: string, user: AuthUser): Promise<PlanSnapshot> {
  const plan = await readablePlan(client, planId, user);
  const [itemsResult, ordersResult, operationsResult, authorizationsResult, cancellationsResult, batchesResult, manualTasksResult] = await Promise.all([
    client.query<PlanItemRow>('SELECT id, catalog_item_id, name, kind, price_minor, status FROM plan_items WHERE plan_id = $1 ORDER BY position', [planId]),
    client.query<OrderRow>(`SELECT id, plan_item_id, item_name, amount_minor, status, payment_status, simulation_mode,
      close_simulation_mode, refund_simulation_mode, reserved_minor, refunded_minor,
      environment, provider
      FROM orders WHERE plan_id = $1 ORDER BY created_at`, [planId]),
    client.query<{ type: string }>(`SELECT type FROM operations WHERE plan_id = $1 AND state IN ('accepted', 'processing', 'unknown', 'pending_review') ORDER BY created_at`, [planId]),
    client.query<AuthorizationRow>(`SELECT id, type, status, scope, expires_at FROM authorizations
      WHERE plan_id = $1 ORDER BY created_at DESC`, [planId]),
    client.query<CancellationRow>(`SELECT cancellation_requests.id, cancellation_requests.order_id, cancellation_requests.status,
      cancellation_requests.decision, cancellation_requests.decision_reason, cancellation_requests.accepted_fee_minor,
      cancellation_requests.accepted_refund_minor, cancellation_requests.updated_at
      FROM cancellation_requests JOIN orders ON orders.id = cancellation_requests.order_id
      WHERE orders.plan_id = $1 ORDER BY cancellation_requests.updated_at DESC`, [planId]),
    client.query<RefundBatchRow>(`SELECT refund_batches.id, refund_batches.operation_id, refund_batches.cancellation_request_id, refund_batches.batch_number,
      refund_batches.amount_minor, refund_batches.status, refund_batches.updated_at
      FROM refund_batches JOIN orders ON orders.id = refund_batches.order_id
      WHERE orders.plan_id = $1 ORDER BY refund_batches.batch_number`, [planId]),
    client.query<ManualTaskRow>(`SELECT id, order_id, cancellation_request_id, type, state, reason, next_action, next_review_at
      FROM manual_tasks WHERE plan_id = $1 ORDER BY next_review_at`, [planId]),
  ]);
  const orders = ordersResult.rows;
  const paid = sumMinor(orders.filter((order) => order.payment_status === 'paid').map((order) => order.amount_minor));
  const refunded = sumMinor(orders.map((order) => order.refunded_minor));
  const reserved = sumMinor(orders.filter((order) => ['pending', 'unknown'].includes(order.payment_status)).map((order) => order.reserved_minor));
  return {
    id: plan.id,
    purpose: plan.purpose,
    version: plan.version,
    purchaseLimitMinor: plan.purchase_limit_minor,
    pausedItemIds: listPausedIds(plan.paused_item_ids),
    items: itemsResult.rows.map((item) => ({
      id: item.id,
      catalogItemId: item.catalog_item_id,
      name: item.name,
      kind: item.kind,
      priceMinor: item.price_minor,
      status: item.status,
      hasOrder: orders.some((order) => order.plan_item_id === item.id),
    })),
    orders: orders.map((order) => ({
      id: order.id,
      planItemId: order.plan_item_id,
      itemName: order.item_name,
      amountMinor: order.amount_minor,
      refundedMinor: order.refunded_minor,
      status: order.status,
      paymentStatus: order.payment_status,
      simulationMode: order.simulation_mode,
      closeSimulationMode: order.close_simulation_mode,
      refundSimulationMode: order.refund_simulation_mode,
      environment: order.environment,
      provider: order.provider,
    })),
    authorizations: authorizationsResult.rows.map((authorization) => ({
      id: authorization.id,
      type: authorization.type,
      status: authorization.status === 'active' && authorization.expires_at.getTime() <= Date.now()
        ? 'expired' : authorization.status,
      itemIds: authorization.scope.itemIds ?? [],
      orderIds: Array.isArray(authorization.scope?.orderIds) ? authorization.scope.orderIds : [],
      expiresAt: authorization.expires_at.toISOString(),
    })),
    cancellations: cancellationsResult.rows.map((cancellation) => {
      const batches = batchesResult.rows.filter((batch) => batch.cancellation_request_id === cancellation.id);
      return {
        id: cancellation.id,
        orderId: cancellation.order_id,
        status: cancellation.status,
        decision: cancellation.decision,
        decisionReason: cancellation.decision_reason,
        acceptedFeeMinor: cancellation.accepted_fee_minor,
        acceptedRefundMinor: cancellation.accepted_refund_minor,
        refundedMinor: sumMinor(batches.filter((batch) => batch.status === 'succeeded').map((batch) => batch.amount_minor)),
        pendingRefundMinor: sumMinor(batches.filter((batch) => ['pending', 'processing', 'unknown', 'pending_review'].includes(batch.status)).map((batch) => batch.amount_minor)),
        updatedAt: cancellation.updated_at.toISOString(),
        batches: batches.map((batch) => ({
          id: batch.id,
          operationId: batch.operation_id,
          batchNumber: batch.batch_number,
          amountMinor: batch.amount_minor,
          status: batch.status,
          updatedAt: batch.updated_at.toISOString(),
        })),
        manualTasks: manualTasksResult.rows.filter((task) => task.cancellation_request_id === cancellation.id
          || (!task.cancellation_request_id && task.order_id === cancellation.order_id)).map((task) => ({
          id: task.id,
          type: task.type,
          state: task.state,
          reason: task.reason,
          nextAction: task.next_action,
          nextReviewAt: task.next_review_at.toISOString(),
        })),
      };
    }),
    budget: {
      limitMinor: plan.purchase_limit_minor,
      totalPaidMinor: paid,
      refundedMinor: refunded,
      paidMinor: paid - refunded,
      reservedMinor: reserved,
      remainingMinor: remainingBudget(plan.purchase_limit_minor, paid, reserved),
    },
    pending: operationsResult.rows.map((operation) => operation.type),
  };
}
