import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  consumerOrderView,
  purchaseIntentConfirmationView,
  type ConsumerOrderView,
  type PurchaseIntentConfirmInput,
  type PurchaseIntentConfirmationView,
} from '@xingzhi/contracts';
import { config } from '../config.js';
import { createAlipayHandoff, sandboxReadiness } from '../payment/alipay-sandbox.js';
import { AppError } from './errors.js';
import { createOperation, createOperationJob } from './jobs.js';
import { applyVerifiedMoneyEvent } from './verified-money-event.js';
import { commitPurchaseAssessment, type ValidatedPurchaseCommit } from './purchase-commit.js';

type OrderDetails = {
  orderId: string;
  purchaseIntentId: string;
  budgetPeriodId: string;
  itemName: string;
  amountMinor: number;
  currency: string;
  environment: string;
  provider: string;
  status: string;
  paymentStatus: string;
  refundedMinor: number;
  createdAt: Date;
  updatedAt: Date;
};

async function readOrder(client: PoolClient, ownerId: string, orderId: string): Promise<ConsumerOrderView> {
  const row = (await client.query<OrderDetails>(`SELECT id AS "orderId",
      purchase_intent_id AS "purchaseIntentId",budget_period_id AS "budgetPeriodId",
      item_name AS "itemName",amount_minor AS "amountMinor",currency,environment,provider,
      status,payment_status AS "paymentStatus",refunded_minor AS "refundedMinor",
      created_at AS "createdAt",updated_at AS "updatedAt"
    FROM orders WHERE id=$1 AND owner_id=$2 AND purchase_intent_id IS NOT NULL`,
  [orderId, ownerId])).rows[0];
  if (!row) throw new AppError(404, 'RESOURCE_FORBIDDEN', '未找到本人新消费者订单。');
  return consumerOrderView.parse({ ...row, createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString() });
}

async function writeConfirmedOrder(client: PoolClient, scope: ValidatedPurchaseCommit) {
  const catalog = (await client.query<{
    name: string;
    simulationMode: 'SUCCESS' | 'PENDING' | 'UNKNOWN';
    closeSimulationMode: 'SUCCESS' | 'PENDING' | 'UNKNOWN';
    refundSimulationMode: 'SUCCESS' | 'PENDING' | 'UNKNOWN';
  }>(`SELECT c.name,c.simulation_mode AS "simulationMode",
      c.close_simulation_mode AS "closeSimulationMode",
      c.refund_simulation_mode AS "refundSimulationMode"
    FROM offer_quotes q JOIN catalog_items c ON c.id=q.catalog_item_id
    WHERE q.id=$1 AND c.id=(SELECT catalog_item_id FROM offer_quotes WHERE id=$1)`,
  [scope.quoteId])).rows[0];
  if (!catalog) throw new AppError(409, 'QUOTE_STALE', '已确认报价对应的商品不存在。');
  const orderId = randomUUID();
  const environment = config.paymentMode === 'sandbox' ? 'sandbox' : 'simulation';
  const provider = environment === 'sandbox' ? 'alipay' : 'simulation';
  const simulationMode = environment === 'simulation' ? catalog.simulationMode : 'UNKNOWN';
  const closeSimulationMode = environment === 'simulation' ? catalog.closeSimulationMode : 'UNKNOWN';
  const refundSimulationMode = environment === 'simulation' ? catalog.refundSimulationMode : 'UNKNOWN';
  await client.query(`UPDATE purchase_intents SET status='confirmed',accepted_amount_minor=$2,
      confirmed_at=now() WHERE id=$1 AND owner_id=$3 AND status='proposed'`,
  [scope.purchaseIntentId, scope.acceptedAmountMinor, scope.ownerId]);
  await client.query(`INSERT INTO orders
      (id,owner_id,budget_period_id,purchase_intent_id,item_name,amount_minor,
        simulation_mode,close_simulation_mode,refund_simulation_mode,
        environment,provider,reserved_minor)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$6)`, [orderId, scope.ownerId,
    scope.periodId, scope.purchaseIntentId, catalog.name, scope.acceptedAmountMinor,
    simulationMode, closeSimulationMode, refundSimulationMode, environment, provider]);
  const businessNumber = environment === 'sandbox'
    ? `XZ_SBX_${orderId.replaceAll('-', '')}` : `SIM-PAY-${orderId.replaceAll('-', '')}`;
  await client.query(`INSERT INTO payment_attempts
      (id,order_id,business_number,status,environment,provider)
    VALUES($1,$2,$3,'pending',$4,$5)`, [randomUUID(), orderId, businessNumber,
    environment, provider]);
  await client.query(`UPDATE purchase_intents SET status='ordered'
    WHERE id=$1 AND owner_id=$2 AND status='confirmed'`, [scope.purchaseIntentId, scope.ownerId]);
  return orderId;
}

export async function confirmPurchaseIntent(
  client: PoolClient,
  ownerId: string,
  purchaseIntentId: string,
  input: PurchaseIntentConfirmInput,
): Promise<PurchaseIntentConfirmationView> {
  const intent = (await client.query<{
    periodId: string;
    budgetItemId: string;
    quoteId: string;
    assessmentId: string;
  }>(`SELECT period_id AS "periodId",budget_item_id AS "budgetItemId",
      quote_id AS "quoteId",assessment_id AS "assessmentId"
    FROM purchase_intents WHERE id=$1 AND owner_id=$2`, [purchaseIntentId, ownerId])).rows[0];
  if (!intent) throw new AppError(404, 'RESOURCE_FORBIDDEN', '未找到本人的购买意图。');
  const committed = await commitPurchaseAssessment(client, {
    ownerId,
    periodId: intent.periodId,
    budgetItemId: intent.budgetItemId,
    quoteId: intent.quoteId,
    assessmentId: intent.assessmentId,
    purchaseIntentId,
    expectedFinancialVersion: input.expectedFinancialVersion,
    expectedPeriodVersion: input.expectedPeriodVersion,
    expectedQuoteVersion: input.expectedQuoteVersion,
    acceptedAmountMinor: input.acceptedAmountMinor,
    confirmedByUser: input.confirmedByUser,
  }, writeConfirmedOrder);
  const order = await readOrder(client, ownerId, committed.orderId);
  return purchaseIntentConfirmationView.parse({
    purchaseIntentId,
    status: 'ordered',
    order,
    financialVersion: input.expectedFinancialVersion + 1,
    periodVersion: input.expectedPeriodVersion,
    paymentHandoffRequired: true,
  });
}

export async function readConsumerOrder(client: PoolClient, ownerId: string, orderId: string) {
  return readOrder(client, ownerId, orderId);
}

export async function prepareConsumerPaymentHandoff(
  client: PoolClient,
  ownerId: string,
  orderId: string,
) {
  const scope = (await client.query<{ periodId: string; accountId: string }>(`SELECT
      o.budget_period_id AS "periodId",p.primary_account_id AS "accountId"
    FROM orders o JOIN budget_periods p ON p.id=o.budget_period_id
    WHERE o.id=$1 AND o.owner_id=$2 AND o.purchase_intent_id IS NOT NULL`,
  [orderId, ownerId])).rows[0];
  if (!scope) throw new AppError(404, 'RESOURCE_FORBIDDEN', '未找到本人新消费者订单。');
  const account = (await client.query<{ status: string }>(`SELECT status FROM finance_accounts
    WHERE id=$1 AND owner_id=$2 FOR UPDATE`, [scope.accountId, ownerId])).rows[0];
  if (!account || account.status !== 'linked') {
    throw new AppError(409, 'FINANCE_SCOPE_REVOKED', '账户授权已撤回，不能发起首次付款交接。');
  }
  await client.query(`SELECT id FROM budget_periods WHERE id=$1 AND owner_id=$2
    AND primary_account_id=$3 FOR UPDATE`, [scope.periodId, ownerId, scope.accountId]);
  const order = (await client.query<{
    id: string;
    itemName: string;
    amountMinor: number;
    environment: 'simulation' | 'sandbox';
    provider: 'simulation' | 'alipay';
    paymentStatus: string;
    businessNumber: string;
  }>(`SELECT o.id,o.item_name AS "itemName",o.amount_minor AS "amountMinor",
      o.environment,o.provider,o.payment_status AS "paymentStatus",
      p.business_number AS "businessNumber"
    FROM orders o JOIN payment_attempts p ON p.order_id=o.id
    WHERE o.id=$1 AND o.owner_id=$2 FOR UPDATE OF o,p`, [orderId, ownerId])).rows[0];
  if (!order) throw new AppError(404, 'RESOURCE_FORBIDDEN', '未找到本人新消费者订单。');
  if (order.paymentStatus !== 'pending') {
    throw new AppError(409, 'PROVIDER_RESULT_UNKNOWN', '订单已经离开首次待付款状态，请读取原订单结果。');
  }
  const operationType = order.environment === 'simulation' ? 'simulate_payment' : 'sandbox_payment_handoff';
  const existing = (await client.query<{ id: string; state: string }>(`SELECT id,state FROM operations
    WHERE budget_period_id=$1 AND owner_id=$2 AND entity_id=$3 AND type=$4
    ORDER BY created_at LIMIT 1 FOR UPDATE`, [scope.periodId, ownerId, order.id, operationType])).rows[0];
  if (existing) {
    return { orderId: order.id, operationId: existing.id, environment: order.environment,
      provider: order.provider, paymentStatus: order.paymentStatus,
      requiresUserAction: order.environment === 'sandbox', reused: true };
  }
  if (order.environment === 'simulation') {
    const operationId = await createOperationJob(client, { budgetPeriodId: scope.periodId,
      ownerId, type: 'simulate_payment', entityId: order.id, purpose: 'B04 本地模拟付款' });
    await applyVerifiedMoneyEvent(client, ownerId, {
      orderId: order.id,
      provider: 'simulation',
      providerEventId: `SIM_PENDING_${operationId}`,
      eventType: 'payment_pending',
      amountMinor: order.amountMinor,
      currency: 'CNY',
      occurredAt: new Date().toISOString(),
      verificationState: 'unverified',
      source: 'demo',
    });
    await client.query(`INSERT INTO budget_events (owner_id,period_id,actor_id,type,data)
      VALUES($1,$2,$1,'payment_handoff_requested',$3::jsonb)`, [ownerId, scope.periodId,
      JSON.stringify({ orderId: order.id, operationId, environment: order.environment })]);
    return { orderId: order.id, operationId, environment: order.environment,
      provider: order.provider, paymentStatus: order.paymentStatus,
      requiresUserAction: false, reused: false };
  }
  if (order.provider !== 'alipay' || !sandboxReadiness().ready) {
    throw new AppError(409, 'PROVIDER_RESULT_UNKNOWN', '支付宝沙箱付款交接尚未就绪。');
  }
  const operationId = await createOperation(client, { budgetPeriodId: scope.periodId,
    ownerId, type: 'sandbox_payment_handoff', entityId: order.id, purpose: 'B04 支付宝沙箱付款交接' });
  const handoff = createAlipayHandoff({ businessNumber: order.businessNumber,
    amountMinor: order.amountMinor, subject: order.itemName });
  await applyVerifiedMoneyEvent(client, ownerId, {
    orderId: order.id,
    provider: 'alipay',
    providerEventId: `ALIPAY_HANDOFF_${operationId}`,
    eventType: 'payment_pending',
    amountMinor: order.amountMinor,
    currency: 'CNY',
    occurredAt: new Date().toISOString(),
    verificationState: 'unverified',
    source: 'demo',
  });
  await client.query('UPDATE payment_attempts SET handoff_ready_at=now() WHERE order_id=$1', [order.id]);
  await client.query("UPDATE operations SET state='processing',updated_at=now() WHERE id=$1", [operationId]);
  await client.query(`INSERT INTO budget_events (owner_id,period_id,actor_id,type,data)
    VALUES($1,$2,$1,'payment_handoff_requested',$3::jsonb)`, [ownerId, scope.periodId,
    JSON.stringify({ orderId: order.id, operationId, environment: order.environment,
      expiresAt: handoff.expiresAt.toISOString() })]);
  return { orderId: order.id, operationId, environment: order.environment,
    provider: order.provider, paymentStatus: order.paymentStatus, requiresUserAction: true,
    handoffUrl: handoff.handoffUrl, expiresAt: handoff.expiresAt.toISOString(), reused: false };
}
