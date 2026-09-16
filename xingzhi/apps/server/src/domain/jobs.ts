import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

export type OperationType =
  | 'simulate_payment'
  | 'simulate_close'
  | 'simulate_refund'
  | 'simulate_refund_batch'
  | 'merchant_cancellation_review'
  | 'sandbox_payment_handoff'
  | 'sandbox_payment_recheck' | 'sandbox_refund_recheck'
  | 'sandbox_close'
  | 'sandbox_refund';

type OperationInput = {
  planId?: string;
  budgetPeriodId?: string;
  ownerId: string;
  type: OperationType;
  entityId: string;
  authorizationId?: string;
  purpose: string;
};

export async function createOperation(client: PoolClient, input: OperationInput) {
  if (Boolean(input.planId) === Boolean(input.budgetPeriodId)) {
    throw new Error('操作必须且只能绑定旧计划或新预算周期。');
  }
  const operationId = randomUUID();
  await client.query(
    `INSERT INTO operations
      (id, plan_id, budget_period_id, owner_id, type, entity_id, authorization_id, purpose)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [operationId, input.planId ?? null, input.budgetPeriodId ?? null, input.ownerId,
      input.type, input.entityId, input.authorizationId ?? null, input.purpose],
  );
  return operationId;
}

export async function createOperationJob(
  client: PoolClient,
  input: OperationInput & { type: 'simulate_payment' | 'simulate_close' | 'simulate_refund' | 'simulate_refund_batch' | 'sandbox_close' | 'sandbox_refund' | 'sandbox_payment_recheck' | 'sandbox_refund_recheck' },
) {
  const operationId = await createOperation(client, input);
  await client.query('INSERT INTO jobs (id, operation_id) VALUES ($1, $2)', [randomUUID(), operationId]);
  return operationId;
}
