import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { AftercareConfirmationInput, AftercarePreviewInput } from '@xingzhi/contracts';
import { cancellationRuleDetails, ensureManualTask, initialDecisionForRule,
  type CancellationRule } from './aftercare.js';
import { AppError } from './errors.js';
import { createOperation, createOperationJob } from './jobs.js';
import { applyVerifiedMoneyEvent } from './verified-money-event.js';

type OrderScope = {
  id: string; periodId: string; amountMinor: number; status: string; paymentStatus: string;
  refundedMinor: number; environment: 'simulation' | 'sandbox'; provider: 'simulation' | 'alipay';
  ruleVersion: number; rulePreset: CancellationRule; accountSource: 'demo' | 'bank_api';
};

async function orderScope(client: PoolClient, ownerId: string, orderId: string, lock = false) {
  const row = (await client.query<OrderScope>(`SELECT o.id,o.budget_period_id AS "periodId",
      o.amount_minor AS "amountMinor",o.status,o.payment_status AS "paymentStatus",
      o.refunded_minor AS "refundedMinor",o.environment,o.provider,
      catalog.rule_version AS "ruleVersion",catalog.cancellation_rule AS "rulePreset",
      account.source AS "accountSource"
    FROM orders o JOIN purchase_intents intent ON intent.id=o.purchase_intent_id
    JOIN offer_quotes quote ON quote.id=intent.quote_id
    JOIN catalog_items catalog ON catalog.id=quote.catalog_item_id
    JOIN budget_periods period ON period.id=o.budget_period_id
    JOIN finance_accounts account ON account.id=period.primary_account_id
    WHERE o.id=$1 AND o.owner_id=$2 AND o.purchase_intent_id IS NOT NULL
    ${lock ? 'FOR UPDATE OF o,catalog' : ''}`, [orderId, ownerId])).rows[0];
  if (!row) throw new AppError(404, 'RESOURCE_FORBIDDEN', '未找到本人新消费者订单。');
  return row;
}

export async function createAftercarePreview(
  client: PoolClient,
  ownerId: string,
  orderId: string,
  input: AftercarePreviewInput,
) {
  const order = await orderScope(client, ownerId, orderId);
  if (['closed', 'failed'].includes(order.paymentStatus) || order.status === 'cancelled') {
    throw new AppError(409, 'CONFIRMATION_SCOPE_MISMATCH', '订单已经终结，无需重复受理善后。');
  }
  if (input.action === 'close' && !['pending', 'unknown'].includes(order.paymentStatus)) {
    throw new AppError(409, 'CONFIRMATION_SCOPE_MISMATCH', '只有待付或结果未知订单可以预览关单。');
  }
  if (input.action === 'cancel' && order.paymentStatus !== 'paid') {
    throw new AppError(409, 'CONFIRMATION_SCOPE_MISMATCH', '只有已付款订单可以预览取消退款。');
  }
  const details = input.action === 'cancel'
    ? cancellationRuleDetails(order.rulePreset, order.amountMinor) : { feeMinor: 0, batchCount: 0 };
  const refundMinor = input.action === 'cancel' ? order.amountMinor - details.feeMinor : 0;
  const previewId = randomUUID();
  const expiresAt = new Date(Date.now() + 15 * 60_000);
  await client.query(`INSERT INTO consumer_aftercare_previews
      (id,owner_id,budget_period_id,order_id,action,order_status,payment_status,
        rule_version,rule_preset,accepted_fee_minor,accepted_refund_minor,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [previewId, ownerId,
    order.periodId, order.id, input.action, order.status, order.paymentStatus,
    order.ruleVersion, order.rulePreset, details.feeMinor, refundMinor, expiresAt]);
  return { previewId, orderId: order.id, action: input.action, orderStatus: order.status,
    paymentStatus: order.paymentStatus, ruleVersion: order.ruleVersion,
    feeMinor: details.feeMinor, expectedRefundMinor: refundMinor,
    expiresAt: expiresAt.toISOString(), status: 'proposed' as const };
}

export async function confirmAftercare(
  client: PoolClient,
  ownerId: string,
  orderId: string,
  input: AftercareConfirmationInput,
) {
  const preview = (await client.query<{
    id: string; periodId: string; action: 'close' | 'cancel'; orderStatus: string;
    paymentStatus: string; ruleVersion: number; rulePreset: CancellationRule;
    feeMinor: number; refundMinor: number; status: string; expiresAt: Date; operationId: string | null;
  }>(`SELECT id,budget_period_id AS "periodId",action,order_status AS "orderStatus",
      payment_status AS "paymentStatus",rule_version AS "ruleVersion",rule_preset AS "rulePreset",
      accepted_fee_minor AS "feeMinor",accepted_refund_minor AS "refundMinor",status,
      expires_at AS "expiresAt",operation_id AS "operationId"
    FROM consumer_aftercare_previews WHERE id=$1 AND order_id=$2 AND owner_id=$3 FOR UPDATE`,
  [input.previewId, orderId, ownerId])).rows[0];
  if (!preview) throw new AppError(404, 'RESOURCE_FORBIDDEN', '未找到本人订单的善后预览。');
  if (preview.status === 'accepted') {
    return { orderId, operationId: preview.operationId, operationIds: preview.operationId ? [preview.operationId] : [],
      state: 'accepted' as const, action: preview.action, reused: true };
  }
  if (preview.expiresAt <= new Date()) {
    await client.query("UPDATE consumer_aftercare_previews SET status='expired',updated_at=now() WHERE id=$1", [preview.id]);
    throw new AppError(409, 'VERSION_CONFLICT', '善后预览已过期，请重新预览。');
  }
  if (preview.feeMinor !== input.acceptedFeeMinor || preview.refundMinor !== input.acceptedRefundMinor) {
    throw new AppError(409, 'CONFIRMATION_SCOPE_MISMATCH', '确认费用或预计退款与预览不一致。');
  }
  const order = await orderScope(client, ownerId, orderId, true);
  if (order.status !== preview.orderStatus || order.paymentStatus !== preview.paymentStatus
    || order.ruleVersion !== preview.ruleVersion || order.rulePreset !== preview.rulePreset) {
    throw new AppError(409, 'CONFIRMATION_SCOPE_MISMATCH', '原订单状态或取消规则已经变化，请重新预览。');
  }
  const operationIds: string[] = [];
  if (preview.action === 'close') {
    if (!['pending', 'unknown'].includes(order.paymentStatus)) {
      throw new AppError(409, 'CONFIRMATION_SCOPE_MISMATCH', '订单已不再适用未付款关单。');
    }
    const type = order.environment === 'simulation' ? 'simulate_close' : 'sandbox_close';
    const existing = (await client.query<{ id: string }>(`SELECT id FROM operations
      WHERE budget_period_id=$1 AND owner_id=$2 AND entity_id=$3 AND type=$4
      ORDER BY created_at LIMIT 1 FOR UPDATE`, [order.periodId, ownerId, order.id, type])).rows[0];
    operationIds.push(existing?.id ?? await createOperationJob(client, { budgetPeriodId: order.periodId,
      ownerId, type, entityId: order.id, aftercarePreviewId: preview.id,
      purpose: 'M1 本人确认的原单关单；先按原付款号核对' }));
  } else {
    if (order.paymentStatus !== 'paid' || order.refundedMinor > 0) {
      throw new AppError(409, 'CONFIRMATION_SCOPE_MISMATCH', '订单付款或退款状态已经变化，请重新预览。');
    }
    if ((await client.query(`SELECT 1 FROM cancellation_requests WHERE order_id=$1 AND status IN
      ('submitted','approved','delayed','refund_processing','pending_review')`, [order.id])).rowCount) {
      throw new AppError(409, 'CONFIRMATION_SCOPE_MISMATCH', '原订单已有受理中的取消申请。');
    }
    const details = cancellationRuleDetails(order.rulePreset, order.amountMinor);
    const decision = initialDecisionForRule(order.rulePreset);
    const requestId = randomUUID();
    const requestStatus = decision === 'approve' ? 'approved' : decision === 'delay' ? 'delayed' : 'rejected';
    await client.query(`INSERT INTO cancellation_requests
        (id,order_id,owner_id,aftercare_preview_id,accepted_fee_minor,accepted_refund_minor,
          status,rule_version,rule_preset,decision,decision_reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [requestId, order.id, ownerId,
      preview.id, preview.feeMinor, preview.refundMinor, requestStatus, order.ruleVersion,
      order.rulePreset, decision, details.label]);
    if (decision === 'approve' && preview.refundMinor > 0) {
      const amounts = details.batchCount === 2
        ? [Math.floor(preview.refundMinor / 2), preview.refundMinor - Math.floor(preview.refundMinor / 2)]
        : [preview.refundMinor];
      for (const [index, amountMinor] of amounts.entries()) {
        const batchId = randomUUID();
        const operationId = await createOperationJob(client, { budgetPeriodId: order.periodId,
          ownerId, type: order.environment === 'simulation' ? 'simulate_refund_batch' : 'sandbox_refund',
          entityId: batchId, aftercarePreviewId: index === 0 ? preview.id : undefined,
          purpose: `M1 本人确认取消退款:${requestId}:${index + 1}` });
        operationIds.push(operationId);
        await client.query(`INSERT INTO refund_batches
            (id,cancellation_request_id,order_id,merchant_id,responsible_provider,operation_id,
              environment,provider,batch_number,business_number,amount_minor)
          VALUES($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10)`, [batchId, requestId, order.id,
        order.provider, operationId, order.environment, order.provider, index + 1,
        `XZ-RF-${batchId.replaceAll('-', '')}`, amountMinor]);
      }
      await client.query("UPDATE cancellation_requests SET status='refund_processing' WHERE id=$1", [requestId]);
      await client.query("UPDATE orders SET status='cancellation_processing',updated_at=now() WHERE id=$1", [order.id]);
      await applyVerifiedMoneyEvent(client, ownerId, { orderId: order.id, provider: order.provider,
        providerEventId: `REFUND_REQUESTED_${requestId}`, eventType: 'refund_requested',
        amountMinor: preview.refundMinor, currency: 'CNY', occurredAt: new Date().toISOString(),
        verificationState: 'unverified', source: order.accountSource });
    } else {
      const operationId = await createOperation(client, { budgetPeriodId: order.periodId, ownerId,
        type: 'merchant_cancellation_review', entityId: requestId, aftercarePreviewId: preview.id,
        purpose: 'M1 本人确认取消规则处理' });
      operationIds.push(operationId);
      await client.query("UPDATE operations SET state=$2,updated_at=now() WHERE id=$1",
        [operationId, decision === 'reject' ? 'succeeded' : 'pending_review']);
      if (decision === 'reject') {
        await client.query("UPDATE orders SET status='cancellation_rejected',updated_at=now() WHERE id=$1", [order.id]);
      } else {
        await client.query("UPDATE orders SET status='cancellation_processing',updated_at=now() WHERE id=$1", [order.id]);
        await ensureManualTask(client, { dedupeKey: `consumer-cancellation:${requestId}`,
          budgetPeriodId: order.periodId, responsibleProvider: order.provider, orderId: order.id,
          cancellationRequestId: requestId, operationId, type: 'cancellation_follow_up',
          reason: '登记规则要求延迟复核取消申请。',
          nextAction: '核对原订单和取消规则后继续原申请，不新建替代退款。' });
      }
    }
  }
  const operationId = operationIds[0] ?? null;
  await client.query(`UPDATE consumer_aftercare_previews SET status='accepted',confirmed_at=now(),
    operation_id=$2,updated_at=now() WHERE id=$1`, [preview.id, operationId]);
  await client.query(`INSERT INTO budget_events(owner_id,period_id,actor_id,type,data)
    VALUES($1,$2,$1,'order_aftercare_accepted',$3)`, [ownerId, order.periodId,
    { orderId, previewId: preview.id, action: preview.action, operationIds }]);
  return { orderId, operationId, operationIds, state: 'accepted' as const,
    action: preview.action, reused: false };
}
