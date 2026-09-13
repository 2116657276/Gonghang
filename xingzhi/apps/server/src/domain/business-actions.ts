import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { createOrderInput, pausePlanInput } from '@xingzhi/contracts';
import type { AuthUser } from '../auth/session.js';
import { config } from '../config.js';
import { listPausedIds, ownedPlan } from './access.js';
import { AppError, forbidden, notFound } from './errors.js';
import { appendEvent } from './events.js';
import { createOperation, createOperationJob } from './jobs.js';
import { remainingBudget, sumMinor } from './money.js';
import { cancellationRuleDetails, ensureManualTask, initialDecisionForRule, type CancellationRule } from './aftercare.js';
import { createAlipayHandoff, sandboxReadiness } from '../payment/alipay-sandbox.js';
import type { PlanItemRow } from './proposals.js';

type ProposalRow = { id:string; plan_id:string; owner_id:string; type:'purchase'|'change'; plan_version:number; snapshot:Record<string,any>; status:string; expires_at:Date };

export async function budgetForPlan(client: PoolClient, planId: string) {
  const result = await client.query<{ payment_status: string; amount_minor: number; reserved_minor: number }>(
    'SELECT payment_status, amount_minor, reserved_minor FROM orders WHERE plan_id = $1 FOR UPDATE', [planId],
  );
  const paid = sumMinor(result.rows.filter((order) => order.payment_status === 'paid').map((order) => order.amount_minor));
  const reserved = sumMinor(result.rows.filter((order) => ['pending', 'unknown'].includes(order.payment_status)).map((order) => order.reserved_minor));
  return { paid, reserved };
}


export async function createConfirmedOrder(client: PoolClient, user: AuthUser, rawInput: unknown) {
  if (user.role !== 'consumer') forbidden();
  const input = createOrderInput.strict().parse(rawInput);

  const confirmation = await client.query<{ plan_id: string; owner_id: string; type:string; snapshot:{proposal?:{items?:Array<{planItemId:string;catalogItemId:string;priceMinor:number;ruleVersion:number}>}} }>('SELECT plan_id, owner_id, type, snapshot FROM confirmations WHERE id = $1', [input.confirmationId]);
  const confirmationRow = confirmation.rows[0];
  if (!confirmationRow || confirmationRow.owner_id !== user.id || confirmationRow.type !== 'purchase') notFound('未找到购买确认记录。');
  const plan = await ownedPlan(client, confirmationRow.plan_id, user, true);
  const existing = await client.query<{ id: string; environment: 'simulation' | 'sandbox' }>('SELECT id, environment FROM orders WHERE confirmation_id = $1 AND plan_item_id = $2', [input.confirmationId, input.planItemId]);
  if (existing.rows[0]) {
    const operation = await client.query<{ id: string }>("SELECT id FROM operations WHERE entity_id = $1 AND type = ANY($2::text[]) ORDER BY created_at LIMIT 1", [
      existing.rows[0].id,
      existing.rows[0].environment === 'sandbox' ? ['sandbox_payment_handoff'] : ['simulate_payment'],
    ]);
    return { orderId: existing.rows[0].id, operationId: operation.rows[0]?.id, reused: true, environment: existing.rows[0].environment };
  }
  if ((await client.query('SELECT 1 FROM orders WHERE plan_item_id=$1 AND plan_id=$2',[input.planItemId,plan.id])).rowCount) throw new AppError(409,'ITEM_ALREADY_ORDERED','该计划项已有订单，请查看原单。');
  const authorization = await client.query<{ id: string; scope: { itemIds: string[] }; purchase_limit_minor: number; status: string; expires_at: Date }>(`
    SELECT id, scope, purchase_limit_minor, status, expires_at FROM authorizations
    WHERE confirmation_id = $1 AND type = 'purchase' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [input.confirmationId]);
  const auth = authorization.rows[0];
  if (!auth || auth.status !== 'active' || auth.expires_at <= new Date()) throw new AppError(422, 'PURCHASE_AUTHORIZATION_INACTIVE', '购买授权已暂停、撤销或过期。');
  if (!auth.scope.itemIds.includes(input.planItemId) || listPausedIds(plan.paused_item_ids).includes(input.planItemId)) {
    throw new AppError(422, 'PURCHASE_PAUSED', '该计划项当前暂停，需重新确认恢复范围。');
  }
  const itemResult = await client.query<PlanItemRow & { simulation_mode: 'SUCCESS' | 'PENDING' | 'UNKNOWN'; current_price_minor:number; rule_version:number; active:boolean }>(`
    SELECT plan_items.id, plan_items.plan_id, plan_items.catalog_item_id, plan_items.merchant_id, plan_items.name, plan_items.kind,
      plan_items.price_minor, plan_items.status, plan_items.position, catalog_items.simulation_mode, catalog_items.price_minor AS current_price_minor, catalog_items.rule_version, catalog_items.active
    FROM plan_items JOIN catalog_items ON catalog_items.id = plan_items.catalog_item_id WHERE plan_items.id = $1 FOR UPDATE`, [input.planItemId]);
  const item = itemResult.rows[0];
  if (!item || item.plan_id !== plan.id || item.kind === 'unbooked' || item.status === 'stopped') throw new AppError(422, 'ORDER_NOT_ALLOWED', '该计划项不能创建订单。');
  const quote = confirmationRow.snapshot.proposal?.items?.find(entry => entry.planItemId === item.id);
  if (!quote || quote.catalogItemId !== item.catalog_item_id || quote.priceMinor !== item.current_price_minor || quote.ruleVersion !== item.rule_version || !item.active) {
    throw new AppError(409,'QUOTE_STALE','确认后的报价或规则已变化，请重新预览并确认。');
  }
  item.price_minor=quote.priceMinor;
  const budget = await budgetForPlan(client, plan.id);
  if (remainingBudget(plan.purchase_limit_minor, budget.paid, budget.reserved) < item.price_minor) {
    throw new AppError(422, 'BUDGET_EXCEEDED', '计划剩余额度不足，无法创建订单。');
  }
  const orderId = randomUUID();
  const environment = config.paymentMode === 'sandbox' ? 'sandbox' : 'simulation';
  const provider = environment === 'sandbox' ? 'alipay' : 'simulation';
  const businessNumber = environment === 'sandbox' ? `XZ_SBX_${orderId.replaceAll('-', '')}` : `SIM-PAY-${orderId.slice(0, 8)}`;
  await client.query(`INSERT INTO orders (id, plan_id, plan_item_id, owner_id, merchant_id, confirmation_id, purchase_authorization_id,
    item_name, amount_minor, simulation_mode, environment, provider, reserved_minor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$9)`,
    [orderId, plan.id, item.id, user.id, item.merchant_id, input.confirmationId, auth.id, item.name, item.price_minor,
      environment === 'simulation' ? item.simulation_mode : 'UNKNOWN', environment, provider]);
  await client.query('INSERT INTO payment_attempts (id, order_id, business_number, status, environment, provider) VALUES ($1,$2,$3,$4,$5,$6)',
    [randomUUID(), orderId, businessNumber, 'pending', environment, provider]);
  await client.query("UPDATE plan_items SET status = 'in_progress', price_minor=$2 WHERE id = $1", [item.id,item.price_minor]);
  const operationId = environment === 'simulation'
    ? await createOperationJob(client, { planId: plan.id, ownerId: user.id, type: 'simulate_payment', entityId: orderId, authorizationId: auth.id, purpose: 'S1 本地模拟付款' })
    : await createOperation(client, { planId: plan.id, ownerId: user.id, type: 'sandbox_payment_handoff', entityId: orderId, authorizationId: auth.id, purpose: 'S2 等待用户获取沙箱付款交接' });
  await appendEvent(client, plan.id, user.id, 'order.created', { orderId, planItemId: item.id, operationId, environment });
  return { orderId, operationId, status: 'accepted', environment };
}

export async function preparePaymentHandoff(client: PoolClient, user: AuthUser, orderId: string) {
  if (user.role !== 'consumer') forbidden();
  const target = (await client.query<{plan_id:string}>('SELECT plan_id FROM orders WHERE id=$1 AND owner_id=$2',[orderId,user.id])).rows[0];
  if (!target) notFound();
  const plan = await ownedPlan(client,target.plan_id,user,true);
  const result = await client.query<{
    id: string; plan_id: string; owner_id: string; item_name: string; amount_minor: number; environment: string; payment_status: string; business_number: string; purchase_authorization_id:string; plan_item_id:string;
  }>(`SELECT orders.id, orders.plan_id, orders.owner_id, orders.item_name, orders.amount_minor, orders.environment, orders.payment_status,
      payment_attempts.business_number, orders.purchase_authorization_id, orders.plan_item_id
    FROM orders JOIN payment_attempts ON payment_attempts.order_id = orders.id
    WHERE orders.id = $1 FOR UPDATE OF orders, payment_attempts`, [orderId]);
  const order = result.rows[0];
  if (!order || order.owner_id !== user.id) notFound('未找到可付款的订单。');
  if (order.environment !== 'sandbox') throw new AppError(422, 'PAYMENT_HANDOFF_UNAVAILABLE', '本地模拟订单没有官方付款交接，不能将模拟结果伪装为沙箱付款。');
  if (order.payment_status !== 'pending') throw new AppError(409, 'PAYMENT_HANDOFF_NOT_PENDING', '订单不再处于待付款状态，请查看最新交易事实。');
  const authorization = (await client.query<{status:string;expires_at:Date;scope:{itemIds?:string[]}}>(
    "SELECT status,expires_at,scope FROM authorizations WHERE id=$1 AND plan_id=$2 AND owner_id=$3 AND type='purchase' FOR UPDATE",
    [order.purchase_authorization_id,plan.id,user.id])).rows[0];
  if (!authorization || authorization.status !== 'active' || authorization.expires_at <= new Date()
    || !authorization.scope.itemIds?.includes(order.plan_item_id) || listPausedIds(plan.paused_item_ids).includes(order.plan_item_id)) {
    throw new AppError(422,'PURCHASE_AUTHORIZATION_INACTIVE','购买授权已暂停、撤回或过期，不能生成新的付款交接。');
  }
  const handoff = createAlipayHandoff({ businessNumber: order.business_number, amountMinor: order.amount_minor, subject: order.item_name });
  await client.query('UPDATE payment_attempts SET handoff_ready_at = now() WHERE order_id = $1', [order.id]);
  await client.query("UPDATE operations SET state = 'processing', updated_at = now() WHERE entity_id = $1 AND type = 'sandbox_payment_handoff' AND state = 'accepted'", [order.id]);
  await appendEvent(client, order.plan_id, user.id, 'sandbox.payment_handoff_ready', { orderId: order.id, expiresAt: handoff.expiresAt.toISOString() });
  return { orderId: order.id, provider: 'alipay', handoffUrl: handoff.handoffUrl, expiresAt: handoff.expiresAt, environment: 'sandbox' };
}

export async function pausePurchases(client: PoolClient, user: AuthUser, planId: string, rawInput: unknown) {
  if (user.role !== 'consumer') forbidden();
  const input = pausePlanInput.strict().parse(rawInput);

  const plan = await ownedPlan(client, planId, user, true);
  if (plan.version !== input.expectedVersion) throw new AppError(409, 'VERSION_CONFLICT', '计划已经变化，请刷新后再暂停。');
  const allItems = await client.query<{ id: string }>('SELECT id FROM plan_items WHERE plan_id = $1', [plan.id]);
  const requested = (input.itemIds ?? []).length ? input.itemIds! : allItems.rows.map((item) => item.id);
  if (requested.some((id) => !allItems.rows.some((item) => item.id === id))) throw new AppError(422, 'ITEM_NOT_IN_PLAN', '暂停范围包含不属于该计划的项目。');
  const paused = [...new Set([...listPausedIds(plan.paused_item_ids), ...requested])];
  await client.query('UPDATE plans SET paused_item_ids = $2, version = version + 1, updated_at = now() WHERE id = $1', [plan.id, JSON.stringify(paused)]);
  if (allItems.rows.every(item => paused.includes(item.id))) {
    await client.query("UPDATE authorizations SET status = 'paused', version = version + 1 WHERE plan_id = $1 AND type = 'purchase' AND status = 'active'", [plan.id]);
  }
  const inFlight = await client.query<{ id: string }>("SELECT id FROM orders WHERE plan_id = $1 AND plan_item_id = ANY($2::uuid[]) AND payment_status IN ('pending', 'unknown')", [plan.id, requested]);
  await appendEvent(client, plan.id, user.id, 'plan.paused', { itemIds: requested, reason: input.reason, inFlightOrderIds: inFlight.rows.map((order) => order.id) });
  return { planVersion: plan.version + 1, pausedItemIds: paused, inFlightOrderIds: inFlight.rows.map((order) => order.id) };
}

export async function submitConfirmedChange(client: PoolClient, user: AuthUser, proposalId: string) {
  if (user.role !== 'consumer') forbidden();


  const proposal = await lockOwnedProposal(client,user,proposalId);
  if (!proposal || proposal.owner_id !== user.id || proposal.type !== 'change') notFound('未找到已确认变更方案。');
  const plan = await ownedPlan(client, proposal.plan_id, user, true);
  const existing = await client.query<{ id: string }>('SELECT id FROM operations WHERE plan_id = $1 AND purpose = $2 ORDER BY created_at', [plan.id, `change:${proposal.id}`]);
  if (existing.rowCount || proposal.status === 'executing') return { operationIds: existing.rows.map((item) => item.id), reused: true };
  if (proposal.status !== 'confirmed') throw new AppError(409, 'CHANGE_NOT_CONFIRMED', '变更方案未处于可执行状态。');
  const authResult = await client.query<{ id: string; status: string; expires_at: Date; scope:{orderIds?:string[]} }>(`SELECT id, status, expires_at, scope FROM authorizations
    WHERE confirmation_id = (SELECT id FROM confirmations WHERE proposal_id = $1 AND type = 'change') AND type = 'aftercare' FOR UPDATE`, [proposal.id]);
  const auth = authResult.rows[0];
  if (!auth || auth.status !== 'active' || auth.expires_at <= new Date()) throw new AppError(422, 'AFTERCARE_AUTHORIZATION_INACTIVE', '善后授权已撤回或过期，请重新确认。');
  const operationIds: string[] = [];
  for (const item of proposal.snapshot.items as Array<{
    planItemId: string; intent: string; orderId: string | null; feeMinor: number; refundMinor: number;
    ruleVersion?: number | null; rulePreset?: CancellationRule | null;
  }>) {
    if (item.intent === 'keep') continue;
    if (item.orderId && !auth.scope.orderIds?.includes(item.orderId)) throw new AppError(422,'AFTERCARE_SCOPE_MISMATCH','订单不在善后授权范围。');
    if (item.intent === 'stop') {
      if ((await client.query('SELECT 1 FROM orders WHERE plan_item_id=$1',[item.planItemId])).rowCount) throw new AppError(409,'STOP_REQUIRES_NO_ORDER','项目已有订单，请重新预览。');
      await client.query("UPDATE plan_items SET status = 'stopped' WHERE id = $1", [item.planItemId]);
      const operationId = randomUUID();
      await client.query(`INSERT INTO operations (id, plan_id, owner_id, type, entity_id, authorization_id, state, purpose, result)
        VALUES ($1,$2,$3,'simulate_close',$4,$5,'succeeded',$6,$7)`, [operationId, plan.id, user.id, item.planItemId, auth.id, `change:${proposal.id}`, { action: 'stopped_without_order' }]);
      operationIds.push(operationId);
      continue;
    }
    if (item.intent === 'close' && item.orderId) {
      const target = await client.query<{ environment: string; provider: string; payment_status: string }>(
        'SELECT environment, provider, payment_status FROM orders WHERE id = $1 AND plan_id = $2 FOR UPDATE', [item.orderId, plan.id]);
      const targetOrder = target.rows[0];
      if (!targetOrder) notFound('未找到关单对象。');
      if (targetOrder.payment_status !== 'pending') throw new AppError(409, 'CLOSE_REQUIRES_UNPAID_ORDER', '订单已不再明确待付，请查看最新事实；已付款须重新确认取消。');
      const isSandbox = targetOrder.environment === 'sandbox' && targetOrder.provider === 'alipay';
      if (isSandbox && !sandboxReadiness().ready) throw new AppError(422, 'EXTERNAL_CLOSE_NOT_READY', '沙箱关单配置尚未就绪。');
      if (!isSandbox && (targetOrder.environment !== 'simulation' || targetOrder.provider !== 'simulation')) {
        throw new AppError(422, 'PAYMENT_ENVIRONMENT_MISMATCH', '订单环境与支付适配器不一致。');
      }
      operationIds.push(await createOperationJob(client, { planId: plan.id, ownerId: user.id, type: isSandbox ? 'sandbox_close' : 'simulate_close', entityId: item.orderId, authorizationId: auth.id, purpose: `change:${proposal.id}` }));
      continue;
    }
    if (item.intent === 'cancel' && item.orderId) {
      const currentRuleResult = await client.query<{
        order_id: string; amount_minor: number; merchant_id: string; rule_version: number; cancellation_rule: CancellationRule; payment_status:string; refunded_minor:number;
      }>(`
        SELECT orders.id AS order_id, orders.amount_minor, orders.merchant_id, orders.payment_status, orders.refunded_minor, catalog_items.rule_version, catalog_items.cancellation_rule
        FROM orders
        JOIN plan_items ON plan_items.id = orders.plan_item_id
        JOIN catalog_items ON catalog_items.id = plan_items.catalog_item_id
        WHERE orders.id = $1 FOR UPDATE OF orders, catalog_items
      `, [item.orderId]);
      const currentRule = currentRuleResult.rows[0];
      if (!currentRule) notFound('未找到可取消的订单。');
      if (currentRule.payment_status !== 'paid' || currentRule.refunded_minor > 0) throw new AppError(409,'CANCELLATION_STATE_CHANGED','订单付款或退款事实已变化，请重新预览。');
      const details = cancellationRuleDetails(currentRule.cancellation_rule, currentRule.amount_minor);
      if (
        item.ruleVersion !== undefined && item.ruleVersion !== null
        && (item.ruleVersion !== currentRule.rule_version || item.rulePreset !== currentRule.cancellation_rule)
      ) {
        throw new AppError(409, 'RULE_VERSION_CONFLICT', '商户取消规则已变化，请重新预览并确认。');
      }
      if (item.feeMinor !== details.feeMinor || item.refundMinor !== currentRule.amount_minor - details.feeMinor) {
        throw new AppError(409, 'CANCELLATION_AMOUNT_CHANGED', '当前取消费用或退款金额已变化，请重新预览并确认。');
      }
      const activeRequest = await client.query<{ id: string }>(`
        SELECT id FROM cancellation_requests WHERE order_id = $1
          AND status IN ('submitted', 'approved', 'delayed', 'refund_processing', 'pending_review')
        FOR UPDATE
      `, [item.orderId]);
      if (activeRequest.rowCount) throw new AppError(409, 'CANCELLATION_ALREADY_SUBMITTED', '该订单已有商户正在处理的取消申请。');
      const cancellationId = randomUUID();
      await client.query(`INSERT INTO cancellation_requests (
        id, order_id, proposal_id, confirmation_id, accepted_fee_minor, accepted_refund_minor, rule_version, rule_preset
      ) VALUES ($1,$2,$3,(SELECT id FROM confirmations WHERE proposal_id = $3 AND type = 'change'),$4,$5,$6,$7)`, [
        cancellationId, item.orderId, proposal.id, item.feeMinor, item.refundMinor,
        currentRule.rule_version, currentRule.cancellation_rule,
      ]);
      await client.query("UPDATE orders SET status = 'cancellation_processing', updated_at = now() WHERE id = $1", [item.orderId]);
      const operationId = await createOperation(client, {
        planId: plan.id, ownerId: user.id, type: 'merchant_cancellation_review', entityId: cancellationId,
        authorizationId: auth.id, purpose: `change:${proposal.id}`,
      });
      operationIds.push(operationId);
      await appendEvent(client, plan.id, user.id, 'cancellation.submitted', {
        cancellationId, orderId: item.orderId, operationId, rulePreset: currentRule.cancellation_rule,
      });
      const decision = initialDecisionForRule(currentRule.cancellation_rule);
      const status = decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'delayed';
      const reason = `按${details.label}自动处理。`;
      await client.query(`UPDATE cancellation_requests
        SET status = $2, decision = $3, decision_reason = $4, decided_by = $5, decided_at = now(), updated_at = now()
        WHERE id = $1`, [cancellationId, status, decision, reason, currentRule.merchant_id]);
      if (decision === 'reject') {
        await client.query("UPDATE orders SET status = 'cancellation_rejected', updated_at = now() WHERE id = $1", [item.orderId]);
      }
      const operationState = decision === 'delay' ? 'pending_review' : 'succeeded';
      await client.query('UPDATE operations SET state = $2, result = $3, updated_at = now() WHERE id = $1', [operationId, operationState, {
        decision, reason, source: 'configured_simulation_rule', decidedAt: new Date().toISOString(),
      }]);
      let manualTaskId: string | undefined;
      if (decision === 'delay') {
        const task = await ensureManualTask(client, {
          dedupeKey: `cancellation-delay:${cancellationId}`, planId: plan.id, merchantId: currentRule.merchant_id,
          orderId: item.orderId, cancellationRequestId: cancellationId, operationId,
          type: 'cancellation_follow_up', reason,
          nextAction: '复核原订单与已确认的取消申请，再作出批准或拒绝决定。',
        });
        manualTaskId = task.id;
      }
      await appendEvent(client, plan.id, currentRule.merchant_id, 'cancellation.auto_decided', {
        cancellationId, orderId: item.orderId, operationId, decision, manualTaskId,
      });
    }
  }
  await client.query("UPDATE proposals SET status = 'executing' WHERE id = $1", [proposal.id]);
  await appendEvent(client, plan.id, user.id, 'change.execution_accepted', { proposalId: proposal.id, operationIds });
  return { operationIds, reused: false };
}

// Every confirmation and execution writer locks the plan before the proposal.
export async function lockOwnedProposal(client:PoolClient,user:AuthUser,proposalId:string) {
  const target=(await client.query<{plan_id:string}>('SELECT plan_id FROM proposals WHERE id=$1 AND owner_id=$2',[proposalId,user.id])).rows[0];
  if(!target)notFound();
  await ownedPlan(client,target.plan_id,user,true);
  return (await client.query<ProposalRow>('SELECT * FROM proposals WHERE id=$1 FOR UPDATE',[proposalId])).rows[0]!;
}
