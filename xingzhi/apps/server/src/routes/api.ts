import { lockOwnedProposal, budgetForPlan, createConfirmedOrder, preparePaymentHandoff, pausePurchases, submitConfirmedChange } from '../domain/business-actions.js';
import { createPurchaseProposal, createChangeProposal } from '../domain/proposals.js';
import { readCatalog, readCancellationQuote, readOperation, type CatalogRow } from '../domain/business-reads.js';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import {
  changeConfirmationInput,
  changeProposalInput,
  createOrderInput,
  createPlanInput,
  loginInput,
  pausePlanInput,
  purchaseConfirmationInput,
  purchaseProposalInput,
  type PlanSnapshot,
} from '@xingzhi/contracts';
import { z } from 'zod';
import { config } from '../config.js';
import { requireRole, requireSameOrigin, requireUser, idempotencyKey } from '../auth/guards.js';
import { createSession, revokeSession, sessionCookie } from '../auth/session.js';
import { verifyPassword } from '../auth/password.js';
import { query, transaction } from '../db/client.js';
import { listPausedIds, ownedPlan, readablePlan } from '../domain/access.js';
import { AppError, forbidden, notFound } from '../domain/errors.js';
import { appendEvent } from '../domain/events.js';
import { runIdempotent } from '../domain/idempotency.js';
import { createOperation, createOperationJob } from '../domain/jobs.js';
import { sumMinor } from '../domain/money.js';
import { planSnapshot } from '../domain/plans.js';
import { cancellationRuleDetails, cancellationRules, ensureManualTask, initialDecisionForRule, type CancellationRule } from '../domain/aftercare.js';
import { queryAlipayTrade, sandboxReadiness, verifyAlipayNotification, yuanToMinor } from '../payment/alipay-sandbox.js';
import { evidenceSections, maskIdentifier, renderEvidenceHtml, sanitizeEvidence, type EvidenceDocument, type EvidenceSection } from '../domain/evidence.js';
import { recheckInput, requestOperationRecheck } from '../domain/operation-rechecks.js';

const paramsWithId = z.object({ id: z.string().uuid() });
const cursorQuery = z.object({ cursor: z.coerce.number().int().min(0).default(0) });
const revocationInput = z.object({ reason: z.string().trim().min(2).max(200) });
const queryRenewalInput = z.object({
  expectedVersion: z.number().int().positive(),
  orderIds: z.array(z.string().uuid()).min(1),
});
const merchantRuleInput = z.object({
  expectedVersion: z.number().int().positive(),
  rule: z.enum(cancellationRules),
});
const merchantDecisionInput = z.object({
  decision: z.enum(['approve', 'reject', 'delay']),
  reason: z.string().trim().min(2).max(200),
});
const manualTaskActionInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('claim') }),
  z.object({ action: z.literal('record_recheck'), note: z.string().trim().min(2).max(500) }),
]);
const evidenceExportInput = z.object({
  format: z.enum(['json', 'html']).default('json'),
  sections: z.array(z.enum(evidenceSections)).min(1).max(evidenceSections.length).default([...evidenceSections]),
});





type PaymentNotificationBody = {
  rawBody: string;
  rawPayload: Record<string, string>;
  values: Record<string, string>;
};

type EvidenceEventRow = {
  id: number;
  type: string;
  data: Record<string, unknown>;
  created_at: Date;
};

type EvidenceOperationRow = {
  id: string;
  type: string;
  state: string;
  purpose: string;
  result: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

type EvidencePaymentAttemptRow = {
  order_id: string;
  business_number: string;
  status: string;
  environment: string;
  provider: string;
  provider_trade_no: string | null;
  provider_status: string | null;
  handoff_ready_at: Date | null;
  sent_at: Date | null;
  observed_at: Date | null;
};

type ProposalRow = {
  id: string;
  plan_id: string;
  owner_id: string;
  type: 'purchase' | 'change';
  plan_version: number;
  snapshot: Record<string, any>;
  status: string;
  expires_at: Date;
};

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError(400, 'INVALID_INPUT', '请求参数不符合要求。', { fields: result.error.flatten() });
  }
  return result.data;
}

function requireWrite(request: FastifyRequest, reply: FastifyReply) {
  if (!requireSameOrigin(request, reply)) return;
  const user = requireUser(request, reply);
  if (!user) return;
  const key = idempotencyKey(request, reply);
  if (!key) return;
  return { user, key };
}

async function assertProposalActive(proposal: ProposalRow, expectedVersion: number, planVersion: number) {
  if (proposal.status !== 'pending') throw new AppError(409, 'PROPOSAL_NOT_ACTIVE', '方案已确认、过期或不再可用。');
  if (proposal.expires_at <= new Date()) throw new AppError(409, 'PROPOSAL_EXPIRED', '方案已过期，请重新预览。');
  if (proposal.plan_version !== expectedVersion || planVersion !== expectedVersion) {
    throw new AppError(409, 'VERSION_CONFLICT', '计划或方案版本已经变化，请重新预览。');
  }
}


function exactSameIds(left: string[], right: string[]) {
  return left.length === right.length && [...left].sort().every((id, index) => id === [...right].sort()[index]);
}

function buildEvidenceDocument(
  snapshot: PlanSnapshot,
  sections: EvidenceSection[],
  generatedAt: Date,
  expiresAt: Date,
  events: EvidenceEventRow[],
  operations: EvidenceOperationRow[],
  paymentAttempts: EvidencePaymentAttemptRow[],
): EvidenceDocument {
  const sectionSet = new Set(sections);
  const attemptsByOrder = new Map(paymentAttempts.map((attempt) => [attempt.order_id, attempt]));
  const document: EvidenceDocument = {
    title: '行止计划行迹',
    version: 1,
    planId: snapshot.id,
    generatedAt: generatedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    sections: [...sections],
  };
  if (sectionSet.has('summary')) {
    document.summary = {
      purpose: snapshot.purpose,
      version: snapshot.version,
      pausedItemIds: snapshot.pausedItemIds,
      items: snapshot.items,
      budget: snapshot.budget,
      pending: snapshot.pending,
    };
  }
  if (sectionSet.has('orders')) {
    document.orders = snapshot.orders.map((order) => {
      const attempt = attemptsByOrder.get(order.id);
      return {
        ...order,
        paymentAttempt: attempt ? {
          businessNumber: maskIdentifier(attempt.business_number),
          status: attempt.status,
          environment: attempt.environment,
          provider: attempt.provider,
          providerTradeNo: maskIdentifier(attempt.provider_trade_no),
          providerStatus: attempt.provider_status,
          handoffReadyAt: attempt.handoff_ready_at?.toISOString() ?? null,
          sentAt: attempt.sent_at?.toISOString() ?? null,
          observedAt: attempt.observed_at?.toISOString() ?? null,
        } : null,
      };
    });
  }
  if (sectionSet.has('authorizations')) document.authorizations = snapshot.authorizations;
  if (sectionSet.has('aftercare')) document.aftercare = snapshot.cancellations;
  if (sectionSet.has('events')) {
    document.events = events.map((event) => ({
      id: event.id,
      type: event.type,
      data: sanitizeEvidence(event.data),
      observedAt: event.created_at.toISOString(),
    }));
  }
  if (sectionSet.has('operations')) {
    document.operations = operations.map((operation) => ({
      id: operation.id,
      type: operation.type,
      state: operation.state,
      purpose: operation.purpose,
      result: sanitizeEvidence(operation.result),
      createdAt: operation.created_at.toISOString(),
      updatedAt: operation.updated_at.toISOString(),
    }));
  }
  return document;
}

export async function registerApi(app: FastifyInstance) {
  app.post('/api/sessions', async (request, reply) => {
    if (!requireSameOrigin(request, reply)) return;
    const input = parse(loginInput, request.body);
    const result = await query<{ id: string; email: string; display_name: string; role: 'consumer' | 'merchant_admin' | 'reviewer'; password_hash: string }>(
      'SELECT id, email, display_name, role, password_hash FROM users WHERE email = $1', [input.email.toLowerCase()],
    );
    const account = result.rows[0];
    if (!account || !(await verifyPassword(input.password, account.password_hash))) {
      return reply.code(401).send({ error: 'INVALID_CREDENTIALS', message: '账号或密码不正确。' });
    }
    const session = await createSession(account.id);
    reply.setCookie(sessionCookie, session.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.sessionCookieSecure,
      path: '/',
      expires: session.expiresAt,
    });
    return { user: { id: account.id, email: account.email, displayName: account.display_name, role: account.role } };
  });

  app.get('/api/session', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    return { user };
  });

  app.delete('/api/session', async (request, reply) => {
    if (!requireSameOrigin(request, reply)) return;
    const user = requireUser(request, reply);
    if (!user) return;
    await revokeSession(request.sessionId);
    reply.clearCookie(sessionCookie, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/api/catalog', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    return readCatalog();
  });

  app.get('/api/merchant/catalog', async (request, reply) => {
    const user = requireRole(request, reply, 'merchant_admin');
    if (!user) return;
    const result = await query<CatalogRow & { active: boolean }>(`SELECT id, merchant_id, code, name, kind, description, price_minor, currency, rule_label,
      rule_version, cancellation_fee_minor, cancellation_rule, simulation_mode, active
      FROM catalog_items WHERE merchant_id = $1 ORDER BY code`, [user.id]);
    return {
      items: result.rows.map((item) => ({
        id: item.id, code: item.code, name: item.name, priceMinor: item.price_minor,
        rule: item.cancellation_rule, ruleLabel: item.rule_label, ruleVersion: item.rule_version,
        cancellationFeeMinor: item.cancellation_fee_minor, active: item.active,
      })),
    };
  });

  app.put('/api/merchant/catalog/:id/rule', async (request, reply) => {
    const context = requireWrite(request, reply);
    if (!context) return;
    if (context.user.role !== 'merchant_admin') return reply.code(403).send({ error: 'FORBIDDEN', message: '只有商户管理员可以更新测试规则。' });
    const { id } = parse(paramsWithId, request.params);
    const input = parse(merchantRuleInput, request.body);
    const response = await transaction((client) => runIdempotent(client, context.user.id, `PUT /merchant/catalog/${id}/rule`, context.key, input, async () => {
      const result = await client.query<CatalogRow>(`SELECT id, merchant_id, code, name, kind, description, price_minor, currency, rule_label,
        rule_version, cancellation_fee_minor, cancellation_rule, simulation_mode
        FROM catalog_items WHERE id = $1 FOR UPDATE`, [id]);
      const item = result.rows[0];
      if (!item || item.merchant_id !== context.user.id) notFound('未找到可管理的商品。');
      if (item.rule_version !== input.expectedVersion) throw new AppError(409, 'RULE_VERSION_CONFLICT', '测试规则已被更新，请刷新后再提交。');
      const details = cancellationRuleDetails(input.rule, item.price_minor);
      await client.query(`UPDATE catalog_items
        SET cancellation_rule = $2, cancellation_fee_minor = $3, rule_label = $4, rule_version = rule_version + 1
        WHERE id = $1`, [item.id, input.rule, details.feeMinor, details.label]);
      return {
        itemId: item.id, rule: input.rule, ruleLabel: details.label, cancellationFeeMinor: details.feeMinor,
        ruleVersion: item.rule_version + 1,
      };
    }));
    return response;
  });

  app.get('/api/payment-readiness', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    return sandboxReadiness();
  });

  app.post('/api/plans', async (request, reply) => {
    const context = requireWrite(request, reply);
    if (!context) return;
    if (context.user.role !== 'consumer') return reply.code(403).send({ error: 'FORBIDDEN', message: '只有消费者可以创建计划。' });
    const input = parse(createPlanInput, request.body);
    const response = await transaction((client) => runIdempotent(client, context.user.id, 'POST /plans', context.key, input, async () => {
      const catalog = await client.query<CatalogRow>(`SELECT id, merchant_id, code, name, kind, description, price_minor, currency, rule_label,
        rule_version, cancellation_fee_minor, cancellation_rule, simulation_mode FROM catalog_items WHERE active = true AND id = ANY($1::uuid[])`, [input.itemIds]);
      if (catalog.rowCount !== new Set(input.itemIds).size) throw new AppError(422, 'CATALOG_CHANGED', '部分商品已不可用，请重新选择。');
      const byId = new Map(catalog.rows.map((item) => [item.id, item]));
      const planId = randomUUID();
      await client.query('INSERT INTO plans (id, owner_id, purpose) VALUES ($1, $2, $3)', [planId, context.user.id, input.purpose]);
      for (const [position, catalogId] of input.itemIds.entries()) {
        const item = byId.get(catalogId)!;
        await client.query(
          `INSERT INTO plan_items (id, plan_id, catalog_item_id, merchant_id, name, kind, price_minor, position)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [randomUUID(), planId, item.id, item.merchant_id, item.name, item.kind, item.price_minor, position],
        );
      }
      await appendEvent(client, planId, context.user.id, 'plan.created', { purpose: input.purpose, itemCount: input.itemIds.length });
      return { planId, version: 1 };
    }));
    return reply.code(201).send(response);
  });

  app.get('/api/plans', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    if (user.role === 'merchant_admin') return { plans: [] };
    const result = user.role === 'consumer'
      ? await query<{ id: string; purpose: string; version: number; updated_at: Date }>('SELECT id, purpose, version, updated_at FROM plans WHERE owner_id = $1 ORDER BY updated_at DESC', [user.id])
      : await query<{ id: string; purpose: string; version: number; updated_at: Date }>(`SELECT plans.id, plans.purpose, plans.version, plans.updated_at
          FROM plans JOIN review_scopes ON review_scopes.plan_id = plans.id WHERE review_scopes.reviewer_id = $1 ORDER BY plans.updated_at DESC`, [user.id]);
    return { plans: result.rows.map((plan) => ({ id: plan.id, purpose: plan.purpose, version: plan.version, updatedAt: plan.updated_at })) };
  });

  app.get('/api/plans/:id', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const { id } = parse(paramsWithId, request.params);
    return transaction((client) => planSnapshot(client, id, user));
  });

  app.post('/api/plans/:id/purchase-proposals', async (request, reply) => {
    const context = requireWrite(request, reply);
    if (!context) return;
    if (context.user.role !== 'consumer') return reply.code(403).send({ error: 'FORBIDDEN', message: '只有消费者可以预览购买方案。' });
    const { id: planId } = parse(paramsWithId, request.params);
    const input = parse(purchaseProposalInput, request.body);
    const response = await transaction((client) => runIdempotent(client, context.user.id, `POST /plans/${planId}/purchase-proposals`, context.key, input, async () => {
      return createPurchaseProposal(client, context.user, planId, input);
    }));
    return reply.code(201).send(response);
  });

  app.post('/api/purchase-proposals/:id/confirm', async (request, reply) => {
    const context = requireWrite(request, reply);
    if (!context) return;
    if (context.user.role !== 'consumer') return reply.code(403).send({ error: 'FORBIDDEN', message: '只有消费者可以确认购买。' });
    const { id: proposalId } = parse(paramsWithId, request.params);
    const input = parse(purchaseConfirmationInput, request.body);
    const response = await transaction((client) => runIdempotent(client, context.user.id, `POST /purchase-proposals/${proposalId}/confirm`, context.key, input, async () => {
      const proposal = await lockOwnedProposal(client,context.user,proposalId);
      if (!proposal || proposal.owner_id !== context.user.id || proposal.type !== 'purchase') notFound('未找到待确认的购买方案。');
      const plan = await ownedPlan(client, proposal.plan_id, context.user, true);
      await assertProposalActive(proposal, input.expectedVersion, plan.version);
      const quotedItems = proposal.snapshot.items as Array<{ planItemId: string; catalogItemId: string; name: string; priceMinor: number; ruleVersion: number }>;
      if (!exactSameIds(input.acceptedItemIds, quotedItems.map((item) => item.planItemId))) {
        throw new AppError(422, 'CONFIRMATION_SCOPE_MISMATCH', '确认范围必须与预览方案完全一致。');
      }
      if ((input.restoreItemIds ?? []).some((itemId) => !input.acceptedItemIds.includes(itemId))) {
        throw new AppError(422, 'RESTORE_SCOPE_MISMATCH', '恢复范围必须属于本次确认的购买范围。');
      }
      const latest = await client.query<{ id: string; price_minor: number; rule_version: number; active: boolean }>(
        'SELECT id, price_minor, rule_version, active FROM catalog_items WHERE id = ANY($1::uuid[])', [quotedItems.map((item) => item.catalogItemId)],
      );
      const latestById = new Map(latest.rows.map((item) => [item.id, item]));
      if (quotedItems.some((item) => {
        const current = latestById.get(item.catalogItemId);
        return !current || !current.active || current.price_minor !== item.priceMinor || current.rule_version !== item.ruleVersion;
      })) throw new AppError(409, 'QUOTE_STALE', '报价或规则已经变化，请重新预览。');
      const proposalTotal = Number(proposal.snapshot.totalMinor);
      if (input.purchaseLimitMinor < proposalTotal) throw new AppError(422, 'LIMIT_TOO_LOW', '计划总上限不能小于本次确认的购买金额。');
      const currentBudget = await budgetForPlan(client, plan.id);
      if (input.purchaseLimitMinor < currentBudget.paid + currentBudget.reserved) {
        throw new AppError(422, 'LIMIT_BELOW_HISTORY', '计划总上限不能低于已有支付与占用金额。');
      }
      const paused = new Set(listPausedIds(plan.paused_item_ids));
      for (const itemId of input.restoreItemIds ?? []) paused.delete(itemId);
      const confirmationId = randomUUID();
      const authorizationId = randomUUID();
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const snapshot = { proposal: proposal.snapshot, purchaseLimitMinor: input.purchaseLimitMinor, restoreItemIds: input.restoreItemIds ?? [] };
      await client.query('INSERT INTO confirmations (id, plan_id, owner_id, proposal_id, type, snapshot) VALUES ($1,$2,$3,$4,$5,$6)',
        [confirmationId, plan.id, context.user.id, proposal.id, 'purchase', snapshot]);
      await client.query("UPDATE authorizations SET status = 'paused', version = version + 1 WHERE plan_id = $1 AND type = 'purchase' AND status = 'active'", [plan.id]);
      await client.query(`INSERT INTO authorizations (id, plan_id, owner_id, confirmation_id, type, scope, purchase_limit_minor, expires_at)
        VALUES ($1,$2,$3,$4,'purchase',$5,$6,$7)`, [authorizationId, plan.id, context.user.id, confirmationId, { itemIds: input.acceptedItemIds }, input.purchaseLimitMinor, expiresAt]);
      await client.query(`UPDATE plans SET version = version + 1, purchase_limit_minor = $2, paused_item_ids = $3, updated_at = now() WHERE id = $1`,
        [plan.id, input.purchaseLimitMinor, JSON.stringify([...paused])]);
      await client.query("UPDATE proposals SET status = 'confirmed', confirmed_at = now() WHERE id = $1", [proposal.id]);
      const eventId=await appendEvent(client, plan.id, context.user.id, 'purchase.confirmed', { confirmationId, authorizationId, proposalId: proposal.id });
      const agentFollowupQueued=Boolean((await client.query('SELECT 1 FROM agent_wakeups WHERE event_id=$1',[eventId])).rowCount);
      return { confirmationId, purchaseAuthorizationId: authorizationId, expiresAt, planVersion: plan.version + 1, agentFollowupQueued };
    }));
    return reply.code(201).send(response);
  });

  app.post('/api/orders', async (request, reply) => {
    const context = requireWrite(request, reply);
    if (!context) return;
    if (context.user.role !== 'consumer') return reply.code(403).send({ error: 'FORBIDDEN', message: '只有消费者可以创建订单。' });
    const input = parse(createOrderInput, request.body);
    const response = await transaction((client) => runIdempotent(client, context.user.id, 'POST /orders', context.key, input, async () => {
      return createConfirmedOrder(client, context.user, input);
    }));
    return reply.code(202).send(response);
  });

  app.post('/api/orders/:id/payment-handoffs', async (request, reply) => {
    const context = requireWrite(request, reply);
    if (!context) return;
    if (context.user.role !== 'consumer') return reply.code(403).send({ error: 'FORBIDDEN', message: '只有消费者可以获取付款交接。' });
    const { id: orderId } = parse(paramsWithId, request.params);
    const response = await transaction((client) => runIdempotent(client, context.user.id, `POST /orders/${orderId}/payment-handoffs`, context.key, {}, async () => {
      return preparePaymentHandoff(client, context.user, orderId);
    }));
    return response;
  });

  app.post('/api/orders/:id/payment-rechecks', async (request, reply) => {
    const context = requireWrite(request, reply);
    if (!context) return;
    if (context.user.role !== 'consumer') return reply.code(403).send({ error: 'FORBIDDEN', message: '只有消费者可以复核沙箱付款。' });
    const { id: orderId } = parse(paramsWithId, request.params);

    const order = await transaction(async (client) => {
      const result = await client.query<{
        id: string; plan_id: string; owner_id: string; amount_minor: number; environment: string; payment_status: string;
        business_number: string; operation_id: string | null;
      }>(`SELECT orders.id, orders.plan_id, orders.owner_id, orders.amount_minor, orders.environment, orders.payment_status,
          payment_attempts.business_number,
          (SELECT id FROM operations WHERE entity_id = orders.id AND type = 'sandbox_payment_handoff' ORDER BY created_at DESC LIMIT 1) AS operation_id
        FROM orders JOIN payment_attempts ON payment_attempts.order_id = orders.id
        WHERE orders.id = $1`, [orderId]);
      const row = result.rows[0];
      if (!row || row.owner_id !== context.user.id) notFound('未找到可复核的沙箱订单。');
      if (row.environment !== 'sandbox') throw new AppError(422, 'PAYMENT_RECHECK_UNAVAILABLE', '本地模拟订单不调用支付宝查单。');
      return row;
    });

    if (!['pending', 'unknown'].includes(order.payment_status)) {
      return {
        orderId: order.id,
        environment: 'sandbox',
        paymentStatus: order.payment_status,
        source: 'persisted',
      };
    }

    const admission = await transaction(async (client) => {
      const cached = await client.query<{ response_payload: Record<string, unknown> }>(
        'SELECT response_payload FROM idempotency_records WHERE actor_id=$1 AND route=$2 AND idempotency_key=$3',
        [context.user.id, `POST /orders/${orderId}/payment-rechecks`, context.key]);
      if (cached.rows[0]) return { cached: cached.rows[0].response_payload, allowed: false };
      const reserved = await client.query(`UPDATE payment_attempts SET query_not_before=now()+interval '15 seconds'
        WHERE order_id=$1 AND (query_not_before IS NULL OR query_not_before <= now()) RETURNING id`, [orderId]);
      return { allowed: Boolean(reserved.rowCount) };
    });
    if (admission.cached) return admission.cached;
    if (!admission.allowed) return reply.code(202).send({ orderId, operationId: order.operation_id,
      status: 'accepted', source: 'persisted', paymentStatus: order.payment_status, retryAfterSeconds: 15 });

    let observed;
    try {
      observed = await queryAlipayTrade(order.business_number);
    } catch {
      throw new AppError(502, 'PAYMENT_QUERY_FAILED', '暂时无法从支付宝取得查单结果，请稍后重试。');
    }

    const response = await transaction((client) => runIdempotent(
      client,
      context.user.id,
      `POST /orders/${orderId}/payment-rechecks`,
      context.key,
      {},
      async () => {
        const currentResult = await client.query<{
          id: string; plan_id: string; amount_minor: number; payment_status: string;
        }>('SELECT id, plan_id, amount_minor, payment_status FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
        const current = currentResult.rows[0];
        if (!current) notFound('未找到可复核的沙箱订单。');
        if (!['pending', 'unknown'].includes(current.payment_status)) {
          return { orderId: current.id, environment: 'sandbox', paymentStatus: current.payment_status, source: 'persisted' };
        }

        const providerStatus = observed.tradeStatus ?? observed.subCode ?? observed.code ?? 'UNKNOWN';
        const amountMinor = observed.totalAmount !== undefined ? yuanToMinor(String(observed.totalAmount)) : undefined;
        const identityMatches = observed.code === '10000'
          && observed.outTradeNo === order.business_number
          && amountMinor === current.amount_minor
          && (!observed.sellerId || observed.sellerId === config.alipaySandbox.sellerId);
        const observedAt = new Date().toISOString();

        if (observed.code !== '10000') {
          if (observed.subCode === 'ACQ.TRADE_NOT_EXIST') {
            await client.query("UPDATE orders SET payment_status = 'pending', updated_at = now() WHERE id = $1", [orderId]);
            await client.query('UPDATE payment_attempts SET provider_status = $2, observed_at = now() WHERE order_id = $1', [orderId, providerStatus]);
            await client.query("UPDATE payment_attempts SET status = 'pending' WHERE order_id = $1", [orderId]);
            if (order.operation_id) {
              await client.query("UPDATE operations SET state = 'processing', result = $2, lease_until = NULL, updated_at = now() WHERE id = $1", [
                order.operation_id, { source: 'alipay_query', paymentStatus: 'pending', providerStatus, observedAt },
              ]);
            }
            await appendEvent(client, current.plan_id, context.user.id, 'sandbox.payment_query_pending', { orderId, providerStatus, observedAt });
            return { orderId, environment: 'sandbox', paymentStatus: 'pending', providerStatus, source: 'alipay_query', observedAt };
          }
          await client.query("UPDATE orders SET payment_status = 'unknown', updated_at = now() WHERE id = $1", [orderId]);
          await client.query("UPDATE payment_attempts SET status = 'unknown', provider_status = $2, observed_at = now() WHERE order_id = $1", [orderId, providerStatus]);
          if (order.operation_id) {
            await client.query("UPDATE operations SET state = 'unknown', result = $2, lease_until = NULL, updated_at = now() WHERE id = $1", [
              order.operation_id, { source: 'alipay_query', providerStatus, observedAt },
            ]);
          }
          await appendEvent(client, current.plan_id, context.user.id, 'sandbox.payment_query_unknown', { orderId, providerStatus, observedAt });
          return { orderId, environment: 'sandbox', paymentStatus: 'unknown', providerStatus, source: 'alipay_query', observedAt };
        }

        if (!identityMatches) {
          await client.query("UPDATE orders SET payment_status = 'unknown', updated_at = now() WHERE id = $1", [orderId]);
          await client.query("UPDATE payment_attempts SET status = 'unknown', provider_status = $2, observed_at = now() WHERE order_id = $1", [orderId, providerStatus]);
          if (order.operation_id) {
            await client.query("UPDATE operations SET state = 'unknown', result = $2, lease_until = NULL, updated_at = now() WHERE id = $1", [
              order.operation_id, { source: 'alipay_query', providerStatus, reason: '订单号、金额或卖家不匹配', observedAt },
            ]);
          }
          await appendEvent(client, current.plan_id, context.user.id, 'sandbox.payment_query_rejected', { orderId, providerStatus, observedAt });
          return { orderId, environment: 'sandbox', paymentStatus: 'unknown', providerStatus, source: 'alipay_query', observedAt };
        }

        if (observed.tradeStatus === 'TRADE_SUCCESS' || observed.tradeStatus === 'TRADE_FINISHED') {
          await client.query("UPDATE orders SET payment_status = 'paid', status = 'fulfilling', updated_at = now() WHERE id = $1", [orderId]);
          await client.query("UPDATE payment_attempts SET status = 'paid', provider_trade_no = $2, provider_status = $3, sent_at = COALESCE(sent_at, now()), observed_at = now() WHERE order_id = $1", [
            orderId, observed.tradeNo ?? null, observed.tradeStatus,
          ]);
          if (order.operation_id) {
            await client.query("UPDATE operations SET state = 'succeeded', result = $2, lease_until = NULL, updated_at = now() WHERE id = $1", [
              order.operation_id, { source: 'alipay_query', paymentStatus: 'paid', providerStatus, observedAt },
            ]);
          }
          await appendEvent(client, current.plan_id, context.user.id, 'sandbox.payment_query_confirmed', { orderId, tradeNo: observed.tradeNo ?? null, observedAt });
          return { orderId, environment: 'sandbox', paymentStatus: 'paid', providerStatus, source: 'alipay_query', observedAt };
        }

        if (observed.tradeStatus === 'TRADE_CLOSED') {
          await client.query("UPDATE orders SET payment_status = 'closed', status = 'cancelled', reserved_minor = 0, updated_at = now() WHERE id = $1", [orderId]);
          await client.query("UPDATE payment_attempts SET status = 'closed', provider_trade_no = $2, provider_status = $3, observed_at = now() WHERE order_id = $1", [
            orderId, observed.tradeNo ?? null, observed.tradeStatus,
          ]);
          if (order.operation_id) {
            await client.query("UPDATE operations SET state = 'succeeded', result = $2, lease_until = NULL, updated_at = now() WHERE id = $1", [
              order.operation_id, { source: 'alipay_query', paymentStatus: 'closed', providerStatus, observedAt },
            ]);
          }
          await appendEvent(client, current.plan_id, context.user.id, 'sandbox.payment_query_closed', { orderId, tradeNo: observed.tradeNo ?? null, observedAt });
          return { orderId, environment: 'sandbox', paymentStatus: 'closed', providerStatus, source: 'alipay_query', observedAt };
        }

        await client.query('UPDATE payment_attempts SET status = \'pending\', provider_status = $2, observed_at = now() WHERE order_id = $1', [orderId, providerStatus]);
        if (order.operation_id) {
          await client.query("UPDATE operations SET state = 'processing', result = $2, lease_until = NULL, updated_at = now() WHERE id = $1", [
            order.operation_id, { source: 'alipay_query', paymentStatus: 'pending', providerStatus, observedAt },
          ]);
        }
        await appendEvent(client, current.plan_id, context.user.id, 'sandbox.payment_query_pending', { orderId, providerStatus, observedAt });
        return { orderId, environment: 'sandbox', paymentStatus: 'pending', providerStatus, source: 'alipay_query', observedAt };
      },
    ));
    return response;
  });

  app.post('/api/payments/alipay/notify', async (request, reply) => {
    const body = request.body as Partial<PaymentNotificationBody>;
    const values = body?.values;
    const rawPayload = body?.rawPayload;
    const rawBody = body?.rawBody;
    const readiness = sandboxReadiness();
    if (!readiness.ready || !values || !rawPayload || !rawBody) {
      return reply.type('text/plain').code(503).send('fail');
    }
    const requiredFields = ['notify_id', 'sign', 'app_id', 'seller_id', 'out_trade_no', 'total_amount', 'trade_status'];
    if (requiredFields.some((field) => !values[field])) return reply.type('text/plain').code(400).send('fail');
    if (!verifyAlipayNotification(rawPayload)) return reply.type('text/plain').code(400).send('fail');

    const applied = await transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`alipay-notify:${values.notify_id}`]);
      const duplicate = await client.query<{ processing_state: string; order_id: string | null; payload: Record<string, string> }>(
        "SELECT processing_state, order_id, payload FROM payment_notifications WHERE environment = 'sandbox' AND provider = 'alipay' AND notification_id = $1 FOR UPDATE",
        [values.notify_id],
      );
      const previous = duplicate.rows[0];
      if (previous) {
        // An acknowledged conflict remains acknowledged; invalid quarantined input stays rejected.
        const sameFacts = ['app_id', 'seller_id', 'out_trade_no', 'total_amount', 'trade_status', 'trade_no']
          .every(field => previous.payload[field] === values[field]);
        const acceptedForReview = previous.processing_state === 'quarantined' && previous.order_id !== null
          && ['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(previous.payload.trade_status ?? '');
        return sameFacts && (previous.processing_state === 'applied' || acceptedForReview);
      }

      const orderResult = await client.query<{
        id: string; plan_id: string; merchant_id: string; amount_minor: number; payment_status: string; status: string; refunded_minor: number;
      }>(`SELECT orders.id, orders.plan_id, orders.amount_minor, orders.payment_status
          , orders.merchant_id, orders.status, orders.refunded_minor
          FROM orders JOIN payment_attempts ON payment_attempts.order_id = orders.id
          WHERE payment_attempts.business_number = $1 AND orders.environment = 'sandbox'
          FOR UPDATE OF orders, payment_attempts`, [values.out_trade_no]);
      const order = orderResult.rows[0];
      const amountMinor = yuanToMinor(values.total_amount);
      const matches = Boolean(order)
        && values.app_id === config.alipaySandbox.appId
        && values.seller_id === config.alipaySandbox.sellerId
        && amountMinor === order.amount_minor;
      if (!matches) {
        await client.query(`INSERT INTO payment_notifications (id, environment, provider, notification_id, raw_body, payload, signature_valid, processing_state)
          VALUES ($1,'sandbox','alipay',$2,$3,$4,true,'quarantined')`, [randomUUID(), values.notify_id, rawBody, values]);
        return false;
      }

      const status = values.trade_status;
      if (!['TRADE_SUCCESS', 'TRADE_FINISHED', 'TRADE_CLOSED', 'WAIT_BUYER_PAY'].includes(status)) {
        await client.query(`INSERT INTO payment_notifications (id, environment, provider, notification_id, raw_body, payload, signature_valid, processing_state, order_id)
          VALUES ($1,'sandbox','alipay',$2,$3,$4,true,'quarantined',$5)`, [randomUUID(), values.notify_id, rawBody, values, order.id]);
        return false;
      }

      if ((status === 'TRADE_SUCCESS' || status === 'TRADE_FINISHED')
        && (order.payment_status === 'closed' || order.payment_status === 'failed'
          || (order.payment_status !== 'paid' && order.refunded_minor > 0))) {
        await client.query(`INSERT INTO payment_notifications (id, environment, provider, notification_id, raw_body, payload, signature_valid, processing_state, order_id)
          VALUES ($1,'sandbox','alipay',$2,$3,$4,true,'quarantined',$5)`, [randomUUID(), values.notify_id, rawBody, values, order.id]);
        await ensureManualTask(client, {
          dedupeKey: `payment-conflict:${order.id}`, planId: order.plan_id, merchantId: order.merchant_id, orderId: order.id,
          type: 'operation_recheck', reason: '渠道付款通知与本地已关单、失败或退款事实冲突。',
          nextAction: '核对原付款业务编号及关单／退款事实；不得直接重新打开订单或重复记账。',
        });
        await appendEvent(client, order.plan_id, null, 'sandbox.payment_conflict_requires_review', {
          orderId: order.id, providerStatus: status, reason: '保留本地已确认事实并转人工复核',
        });
        return true;
      }

      await client.query(`INSERT INTO payment_notifications (id, environment, provider, notification_id, raw_body, payload, signature_valid, processing_state, order_id)
        VALUES ($1,'sandbox','alipay',$2,$3,$4,true,'applied',$5)`, [randomUUID(), values.notify_id, rawBody, values, order.id]);
      if (order.payment_status === 'paid') {
        await appendEvent(client, order.plan_id, null, 'sandbox.payment_observation_retained', {
          orderId: order.id, providerStatus: status, reason: '保留历史付款及已有取消退款状态' });
        return true;
      }
      if (status === 'TRADE_SUCCESS' || status === 'TRADE_FINISHED') {
        await client.query("UPDATE orders SET payment_status = 'paid', status = 'fulfilling', updated_at = now() WHERE id = $1", [order.id]);
        await client.query("UPDATE payment_attempts SET status = 'paid', provider_trade_no = $2, provider_status = $3, sent_at = COALESCE(sent_at, now()), observed_at = now() WHERE order_id = $1",
          [order.id, values.trade_no ?? null, status]);
        await client.query("UPDATE operations SET state = 'succeeded', result = $2, lease_until = NULL, updated_at = now() WHERE entity_id = $1 AND type = 'sandbox_payment_handoff'", [
          order.id, { source: 'alipay_sandbox_notify', paymentStatus: 'paid', observedAt: new Date().toISOString() },
        ]);
        await appendEvent(client, order.plan_id, null, 'sandbox.payment_confirmed', { orderId: order.id, tradeNo: values.trade_no ?? null, observedAt: new Date().toISOString() });
        return true;
      }
      if (status === 'TRADE_CLOSED') {
        await client.query("UPDATE orders SET payment_status = 'closed', status = 'cancelled', reserved_minor = 0, updated_at = now() WHERE id = $1", [order.id]);
        await client.query("UPDATE payment_attempts SET status = 'closed', provider_trade_no = $2, provider_status = $3, observed_at = now() WHERE order_id = $1",
          [order.id, values.trade_no ?? null, status]);
        await client.query("UPDATE operations SET state = 'succeeded', result = $2, lease_until = NULL, updated_at = now() WHERE entity_id = $1 AND type = 'sandbox_payment_handoff'", [
          order.id, { source: 'alipay_sandbox_notify', paymentStatus: 'closed', observedAt: new Date().toISOString() },
        ]);
        await appendEvent(client, order.plan_id, null, 'sandbox.payment_closed', { orderId: order.id, tradeNo: values.trade_no ?? null, observedAt: new Date().toISOString() });
        return true;
      }
      await client.query("UPDATE payment_attempts SET provider_status = $2, observed_at = now() WHERE order_id = $1", [order.id, status]);
      await appendEvent(client, order.plan_id, null, 'sandbox.payment_waiting', { orderId: order.id, observedAt: new Date().toISOString() });
      return true;
    });
    return reply.type('text/plain').code(applied ? 200 : 400).send(applied ? 'success' : 'fail');
  });

  app.post('/api/plans/:id/pause', async (request, reply) => {
    const context = requireWrite(request, reply);
    if (!context) return;
    if (context.user.role !== 'consumer') return reply.code(403).send({ error: 'FORBIDDEN', message: '只有消费者可以暂停计划。' });
    const { id: planId } = parse(paramsWithId, request.params);
    const input = parse(pausePlanInput, request.body);
    const response = await transaction((client) => runIdempotent(client, context.user.id, `POST /plans/${planId}/pause`, context.key, input, async () => {
      return pausePurchases(client, context.user, planId, input);
    }));
    return response;
  });

  app.get('/api/plans/:id/orders', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const { id } = parse(paramsWithId, request.params);
    const snapshot = await transaction((client) => planSnapshot(client, id, user));
    return { orders: snapshot.orders, budget: snapshot.budget, pending: snapshot.pending };
  });

  app.get('/api/orders/:id/cancellation-quote', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const { id } = parse(paramsWithId, request.params);
    return readCancellationQuote(user, id);
  });

  app.post('/api/plans/:id/change-proposals', async (request, reply) => {
    const context = requireWrite(request, reply);
    if (!context) return;
    if (context.user.role !== 'consumer') return reply.code(403).send({ error: 'FORBIDDEN', message: '只有消费者可以创建变更方案。' });
    const { id: planId } = parse(paramsWithId, request.params);
    const input = parse(changeProposalInput, request.body);
    const response = await transaction((client) => runIdempotent(client, context.user.id, `POST /plans/${planId}/change-proposals`, context.key, input, async () => {
      return createChangeProposal(client, context.user, planId, input);
    }));
    return reply.code(201).send(response);
  });

  app.post('/api/change-proposals/:id/confirm', async (request, reply) => {
    const context = requireWrite(request, reply);
    if (!context) return;
    if (context.user.role !== 'consumer') return reply.code(403).send({ error: 'FORBIDDEN', message: '只有消费者可以确认变更。' });
    const { id: proposalId } = parse(paramsWithId, request.params);
    const input = parse(changeConfirmationInput, request.body);
    const response = await transaction((client) => runIdempotent(client, context.user.id, `POST /change-proposals/${proposalId}/confirm`, context.key, input, async () => {
      const proposal = await lockOwnedProposal(client,context.user,proposalId);
      if (!proposal || proposal.owner_id !== context.user.id || proposal.type !== 'change') notFound('未找到待确认的变更方案。');
      const plan = await ownedPlan(client, proposal.plan_id, context.user, true);
      await assertProposalActive(proposal, input.expectedVersion, plan.version);
      if (Number(proposal.snapshot.totalFeeMinor) !== input.acceptedFeeMinor || Number(proposal.snapshot.totalRefundMinor) !== input.acceptedRefundMinor) {
        throw new AppError(422, 'CONFIRMATION_AMOUNT_MISMATCH', '确认金额必须与当前预览完全一致。');
      }
      const proposalOrderIds = (proposal.snapshot.items as Array<{ orderId: string | null; intent: string }>).filter((item) => ['close', 'cancel'].includes(item.intent) && item.orderId).map((item) => item.orderId!);
      if (!exactSameIds(input.aftercareOrderIds ?? [], proposalOrderIds) || !exactSameIds(input.queryOrderIds ?? [], proposalOrderIds)) {
        throw new AppError(422, 'AUTHORIZATION_SCOPE_MISMATCH', '善后与查询授权范围必须与变更中的实际订单一致。');
      }
      const confirmationId = randomUUID();
      const aftercareAuthorizationId = randomUUID();
      const queryAuthorizationId = randomUUID();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await client.query('INSERT INTO confirmations (id, plan_id, owner_id, proposal_id, type, snapshot) VALUES ($1,$2,$3,$4,$5,$6)',
        [confirmationId, plan.id, context.user.id, proposal.id, 'change', proposal.snapshot]);
      await client.query(`INSERT INTO authorizations (id, plan_id, owner_id, confirmation_id, type, scope, accepted_fee_minor, accepted_refund_minor, expires_at)
        VALUES ($1,$2,$3,$4,'aftercare',$5,$6,$7,$8), ($9,$2,$3,$4,'query',$10,$6,$7,$8)`,
        [aftercareAuthorizationId, plan.id, context.user.id, confirmationId, { orderIds: input.aftercareOrderIds ?? [] }, input.acceptedFeeMinor, input.acceptedRefundMinor, expiresAt,
          queryAuthorizationId, { orderIds: input.queryOrderIds ?? [] }]);
      await client.query("UPDATE proposals SET status = 'confirmed', confirmed_at = now() WHERE id = $1", [proposal.id]);
      const eventId=await appendEvent(client, plan.id, context.user.id, 'change.confirmed', { confirmationId, aftercareAuthorizationId, queryAuthorizationId, proposalId: proposal.id });
      const agentFollowupQueued=Boolean((await client.query('SELECT 1 FROM agent_wakeups WHERE event_id=$1',[eventId])).rowCount);
      return { confirmationId, aftercareAuthorizationId, queryAuthorizationId, expiresAt, agentFollowupQueued };
    }));
    return reply.code(201).send(response);
  });

  app.post('/api/change-proposals/:id/execute', async (request, reply) => {
    const context = requireWrite(request, reply);
    if (!context) return;
    if (context.user.role !== 'consumer') return reply.code(403).send({ error: 'FORBIDDEN', message: '只有消费者可以执行已确认变更。' });
    const { id: proposalId } = parse(paramsWithId, request.params);
    const response = await transaction((client) => runIdempotent(client, context.user.id, `POST /change-proposals/${proposalId}/execute`, context.key, {}, async () => {
      return submitConfirmedChange(client, context.user, proposalId);
    }));
    return reply.code(202).send(response);
  });

  app.get('/api/operations/:id', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const { id } = parse(paramsWithId, request.params);
    return readOperation(user, id);
  });

  app.get('/api/plans/:id/events', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const { id: planId } = parse(paramsWithId, request.params);
    const { cursor } = parse(cursorQuery, request.query);
    await transaction((client) => readablePlan(client, planId, user));
    const result = await query<{ id: number; type: string; data: Record<string, unknown>; created_at: Date }>(
      'SELECT id, type, data, created_at FROM events WHERE plan_id = $1 AND id > $2 ORDER BY id LIMIT 100', [planId, cursor]);
    const events = result.rows.map((event) => ({ id: event.id, type: event.type, data: event.data, observedAt: event.created_at }));
    return { events, nextCursor: events.at(-1)?.id ?? cursor };
  });

  app.post('/api/plans/:id/evidence-exports', async (request, reply) => {
    const context = requireWrite(request, reply);
    if (!context) return;
    if (context.user.role === 'merchant_admin') {
      return reply.code(403).send({ error: 'FORBIDDEN', message: '商户管理员不能导出消费者计划行迹。' });
    }
    const { id: planId } = parse(paramsWithId, request.params);
    const input = parse(evidenceExportInput, request.body ?? {});
    const sections = input.sections ?? [...evidenceSections];
    const response = await transaction((client) => runIdempotent(
      client,
      context.user.id,
      `POST /plans/${planId}/evidence-exports`,
      context.key,
      input,
      async () => {
        const snapshot = await planSnapshot(client, planId, context.user);
        const generatedAt = new Date();
        const expiresAt = new Date(generatedAt.getTime() + 24 * 60 * 60 * 1000);
        const orderIds = snapshot.orders.map((order) => order.id);
        const [eventsResult, operationsResult, attemptsResult] = await Promise.all([
          client.query<EvidenceEventRow>('SELECT id, type, data, created_at FROM events WHERE plan_id = $1 ORDER BY id', [planId]),
          client.query<EvidenceOperationRow>('SELECT id, type, state, purpose, result, created_at, updated_at FROM operations WHERE plan_id = $1 ORDER BY created_at', [planId]),
          client.query<EvidencePaymentAttemptRow>(`SELECT order_id, business_number, status, environment, provider, provider_trade_no,
            provider_status, handoff_ready_at, sent_at, observed_at FROM payment_attempts WHERE order_id = ANY($1::uuid[])`, [orderIds]),
        ]);
        const document = buildEvidenceDocument(
          snapshot,
          sections,
          generatedAt,
          expiresAt,
          eventsResult.rows,
          operationsResult.rows,
          attemptsResult.rows,
        );
        const content = input.format === 'html'
          ? renderEvidenceHtml(document)
          : JSON.stringify(document, null, 2);
        const exportId = randomUUID();
        await client.query(`INSERT INTO evidence_exports (id, plan_id, requester_id, format, scope, content, expires_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
          exportId, planId, context.user.id, input.format, { sections }, content, expiresAt,
        ]);
        return {
          exportId,
          planId,
          format: input.format,
          sections,
          createdAt: generatedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          downloadUrl: `/api/evidence-exports/${exportId}`,
        };
      },
    ));
    return reply.code(201).send(response);
  });

  app.get('/api/evidence-exports/:id', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return;
    const { id: exportId } = parse(paramsWithId, request.params);
    const result = await query<{
      id: string;
      plan_id: string;
      requester_id: string;
      format: 'json' | 'html';
      content: string;
      expires_at: Date;
    }>('SELECT id, plan_id, requester_id, format, content, expires_at FROM evidence_exports WHERE id = $1', [exportId]);
    const evidence = result.rows[0];
    if (!evidence) notFound('未找到该证据导出。');
    await transaction((client) => readablePlan(client, evidence.plan_id, user));
    if (evidence.expires_at <= new Date()) {
      throw new AppError(410, 'EVIDENCE_EXPORT_EXPIRED', '证据导出已过期，请重新生成。');
    }
    const contentType = evidence.format === 'html' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8';
    return reply
      .header('Cache-Control', 'private, no-store')
      .header('Content-Type', contentType)
      .header('Content-Disposition', `attachment; filename="xingzhi-${evidence.id}.${evidence.format}"`)
      .send(evidence.content);
  });

  app.post('/api/plans/:id/aftercare-query-revocations', async (request, reply) => {
    const context = requireWrite(request, reply);
    if (!context) return;
    if (context.user.role !== 'consumer') return reply.code(403).send({ error: 'FORBIDDEN', message: '只有消费者可以撤回受托权限。' });
    const { id: planId } = parse(paramsWithId, request.params);
    const input = parse(revocationInput, request.body);
    const response = await transaction((client) => runIdempotent(client, context.user.id, `POST /plans/${planId}/aftercare-query-revocations`, context.key, input, async () => {
      const plan = await ownedPlan(client, planId, context.user, true);
      const result = await client.query("UPDATE authorizations SET status = 'revoked', version = version + 1 WHERE plan_id = $1 AND type IN ('aftercare', 'query') AND status = 'active' RETURNING id", [plan.id]);
      await appendEvent(client, plan.id, context.user.id, 'aftercare_query.revoked', { reason: input.reason, authorizationIds: result.rows.map((row) => row.id) });
      return { revokedAuthorizationIds: result.rows.map((row) => row.id), message: '已停止尚未受理的受托动作；既有事实和商户职责仍会保留。' };
    }));
    return response;
  });

  app.post('/api/plans/:id/query-authorizations', async (request, reply) => {
    const context = requireWrite(request, reply);
    if (!context) return;
    if (context.user.role !== 'consumer') return reply.code(403).send({ error: 'FORBIDDEN', message: '只有消费者可以续期查询授权。' });
    const { id: planId } = parse(paramsWithId, request.params);
    const input = parse(queryRenewalInput, request.body);
    const response = await transaction((client) => runIdempotent(client, context.user.id, `POST /plans/${planId}/query-authorizations`, context.key, input, async () => {
      const plan = await ownedPlan(client, planId, context.user, true);
      if (plan.version !== input.expectedVersion) throw new AppError(409, 'VERSION_CONFLICT', '计划已变化，请刷新后再续期。');
      const orders = await client.query<{ id: string }>('SELECT id FROM orders WHERE plan_id = $1 AND id = ANY($2::uuid[])', [plan.id, input.orderIds]);
      if (orders.rowCount !== new Set(input.orderIds).size) throw new AppError(422, 'ORDER_NOT_IN_PLAN', '查询范围包含不属于本计划的订单。');
      const confirmationId = randomUUID();
      const authorizationId = randomUUID();
      const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const renewalProposalId = randomUUID();
      await client.query(`INSERT INTO proposals (id, plan_id, owner_id, type, plan_version, snapshot, status, expires_at, confirmed_at)
        VALUES ($1,$2,$3,'change',$4,$5,'confirmed',$6,now())`, [renewalProposalId, plan.id, context.user.id, plan.version, { type: 'query_renewal', orderIds: input.orderIds }, expiresAt]);
      await client.query('INSERT INTO confirmations (id, plan_id, owner_id, proposal_id, type, snapshot) VALUES ($1,$2,$3,$4,$5,$6)',
        [confirmationId, plan.id, context.user.id, renewalProposalId, 'query_renewal', { orderIds: input.orderIds, expiresAt }]);
      await client.query("UPDATE authorizations SET status = 'expired' WHERE plan_id = $1 AND type = 'query' AND status = 'active'", [plan.id]);
      await client.query("INSERT INTO authorizations (id, plan_id, owner_id, confirmation_id, type, scope, expires_at) VALUES ($1,$2,$3,$4,'query',$5,$6)",
        [authorizationId, plan.id, context.user.id, confirmationId, { orderIds: input.orderIds }, expiresAt]);
      await appendEvent(client, plan.id, context.user.id, 'query_authorization.renewed', { confirmationId, authorizationId, orderIds: input.orderIds });
      return { confirmationId, queryAuthorizationId: authorizationId, expiresAt };
    }));
    return reply.code(201).send(response);
  });

  app.get('/api/merchant/orders', async (request, reply) => {
    const user = requireRole(request, reply, 'merchant_admin');
    if (!user) return;
    const result = await query<{ id: string; item_name: string; amount_minor: number; refunded_minor: number; payment_status: string; status: string; owner_name: string }>(`
      SELECT orders.id, orders.item_name, orders.amount_minor, orders.refunded_minor, orders.payment_status, orders.status, users.display_name AS owner_name
      FROM orders JOIN users ON users.id = orders.owner_id WHERE orders.merchant_id = $1 ORDER BY orders.created_at DESC`, [user.id]);
    return { orders: result.rows.map((order) => ({
      id: order.id, itemName: order.item_name, amountMinor: order.amount_minor, refundedMinor: order.refunded_minor,
      paymentStatus: order.payment_status, status: order.status, consumer: order.owner_name,
    })) };
  });

  app.get('/api/merchant/cancellations', async (request, reply) => {
    const user = requireRole(request, reply, 'merchant_admin');
    if (!user) return;
    const result = await query<{
      id: string; plan_id: string; order_id: string; item_name: string; amount_minor: number; payment_status: string; order_status: string;
      consumer: string; accepted_fee_minor: number; accepted_refund_minor: number; rule_version: number; rule_preset: CancellationRule;
      status: string; decision: string | null; decision_reason: string | null; decided_at: Date | null; created_at: Date; updated_at: Date;
      refunded_minor: number; pending_refund_minor: number; batch_count: number;
    }>(`
      SELECT cancellation_requests.id, orders.plan_id, cancellation_requests.order_id, orders.item_name, orders.amount_minor,
        orders.payment_status, orders.status AS order_status, users.display_name AS consumer,
        cancellation_requests.accepted_fee_minor, cancellation_requests.accepted_refund_minor,
        cancellation_requests.rule_version, cancellation_requests.rule_preset, cancellation_requests.status,
        cancellation_requests.decision, cancellation_requests.decision_reason, cancellation_requests.decided_at,
        cancellation_requests.created_at, cancellation_requests.updated_at,
        COALESCE(SUM(CASE WHEN refund_batches.status = 'succeeded' THEN refund_batches.amount_minor ELSE 0 END), 0)::integer AS refunded_minor,
        COALESCE(SUM(CASE WHEN refund_batches.status IN ('pending', 'processing', 'unknown', 'pending_review') THEN refund_batches.amount_minor ELSE 0 END), 0)::integer AS pending_refund_minor,
        COUNT(refund_batches.id)::integer AS batch_count
      FROM cancellation_requests
      JOIN orders ON orders.id = cancellation_requests.order_id
      JOIN users ON users.id = orders.owner_id
      LEFT JOIN refund_batches ON refund_batches.cancellation_request_id = cancellation_requests.id
      WHERE orders.merchant_id = $1
      GROUP BY cancellation_requests.id, orders.plan_id, cancellation_requests.order_id, orders.item_name, orders.amount_minor,
        orders.payment_status, orders.status, users.display_name
      ORDER BY cancellation_requests.updated_at DESC
    `, [user.id]);
    return {
      cancellations: result.rows.map((item) => ({
        id: item.id, planId: item.plan_id, orderId: item.order_id, itemName: item.item_name, amountMinor: item.amount_minor,
        paymentStatus: item.payment_status, orderStatus: item.order_status, consumer: item.consumer,
        acceptedFeeMinor: item.accepted_fee_minor, acceptedRefundMinor: item.accepted_refund_minor,
        ruleVersion: item.rule_version, rulePreset: item.rule_preset, status: item.status,
        decision: item.decision, decisionReason: item.decision_reason, decidedAt: item.decided_at,
        refundedMinor: item.refunded_minor, pendingRefundMinor: item.pending_refund_minor, batchCount: item.batch_count,
        createdAt: item.created_at, updatedAt: item.updated_at,
      })),
    };
  });

  app.post('/api/merchant/cancellations/:id/decisions', async (request, reply) => {
    const context = requireWrite(request, reply);
    if (!context) return;
    if (context.user.role !== 'merchant_admin') return reply.code(403).send({ error: 'FORBIDDEN', message: '只有商户管理员可以处理取消申请。' });
    const { id: cancellationId } = parse(paramsWithId, request.params);
    const input = parse(merchantDecisionInput, request.body);
    const response = await transaction((client) => runIdempotent(client, context.user.id, `POST /merchant/cancellations/${cancellationId}/decisions`, context.key, input, async () => {
      const result = await client.query<{
        id: string; plan_id: string; order_id: string; owner_id: string; merchant_id: string; confirmation_id: string;
        status: string; rule_preset: CancellationRule;
      }>(`
        SELECT cancellation_requests.id, orders.plan_id, cancellation_requests.order_id, orders.owner_id, orders.merchant_id,
          cancellation_requests.confirmation_id, cancellation_requests.status, cancellation_requests.rule_preset
        FROM cancellation_requests JOIN orders ON orders.id = cancellation_requests.order_id
        WHERE cancellation_requests.id = $1 FOR UPDATE OF cancellation_requests, orders
      `, [cancellationId]);
      const cancellation = result.rows[0];
      if (!cancellation || cancellation.merchant_id !== context.user.id) notFound('未找到待处理的取消申请。');
      if (!['submitted', 'delayed'].includes(cancellation.status)) {
        throw new AppError(409, 'CANCELLATION_NOT_DECIDABLE', '该取消申请已经处理，不能再次作出决定。');
      }
      if (cancellation.status === 'submitted' && input.decision !== initialDecisionForRule(cancellation.rule_preset)) {
        throw new AppError(422, 'RULE_DECISION_MISMATCH', '当前测试规则要求使用对应的商户处理结果。');
      }
      if (cancellation.status === 'delayed' && input.decision === 'delay') {
        throw new AppError(409, 'CANCELLATION_ALREADY_DELAYED', '该取消申请已经处于延迟复核状态。');
      }

      const status = input.decision === 'approve' ? 'approved' : input.decision === 'reject' ? 'rejected' : 'delayed';
      await client.query(`UPDATE cancellation_requests
        SET status = $2, decision = $3, decision_reason = $4, decided_by = $5, decided_at = now(), updated_at = now()
        WHERE id = $1`, [cancellation.id, status, input.decision, input.reason, context.user.id]);
      if (input.decision === 'reject') {
        await client.query("UPDATE orders SET status = 'cancellation_rejected', updated_at = now() WHERE id = $1", [cancellation.order_id]);
      }

      const operation = await client.query<{ id: string }>(`
        SELECT id FROM operations WHERE entity_id = $1 AND type = 'merchant_cancellation_review' ORDER BY created_at LIMIT 1 FOR UPDATE
      `, [cancellation.id]);
      const operationId = operation.rows[0]?.id ?? await createOperation(client, {
        planId: cancellation.plan_id, ownerId: cancellation.owner_id, type: 'merchant_cancellation_review', entityId: cancellation.id,
        purpose: `merchant_cancellation:${cancellation.id}`,
      });
      const operationState = input.decision === 'delay' ? 'pending_review' : 'succeeded';
      await client.query(`UPDATE operations SET state = $2, result = $3, updated_at = now() WHERE id = $1`, [operationId, operationState, {
        decision: input.decision, reason: input.reason, decidedAt: new Date().toISOString(),
      }]);

      let manualTaskId: string | undefined;
      if (input.decision === 'delay') {
        const task = await ensureManualTask(client, {
          dedupeKey: `cancellation-delay:${cancellation.id}`, planId: cancellation.plan_id, merchantId: context.user.id,
          orderId: cancellation.order_id, cancellationRequestId: cancellation.id, operationId,
          type: 'cancellation_follow_up', reason: input.reason,
          nextAction: '复核原订单与已确认的取消申请，再作出批准或拒绝决定。',
        });
        manualTaskId = task.id;
      } else {
        await client.query(`UPDATE manual_tasks
          SET state = 'resolved', resolved_at = now(), updated_at = now()
          WHERE cancellation_request_id = $1 AND type = 'cancellation_follow_up' AND state <> 'resolved'`, [cancellation.id]);
      }
      await appendEvent(client, cancellation.plan_id, context.user.id, 'cancellation.decided', {
        cancellationId: cancellation.id, orderId: cancellation.order_id, operationId, decision: input.decision,
      });
      return { cancellationId: cancellation.id, status, decision: input.decision, operationId, manualTaskId };
    }));
    return response;
  });

  app.get('/api/merchant/cancellations/:id/refund-batches', async (request, reply) => {
    const user = requireRole(request, reply, 'merchant_admin');
    if (!user) return;
    const { id: cancellationId } = parse(paramsWithId, request.params);
    const cancellation = await query<{ id: string }>(`
      SELECT cancellation_requests.id FROM cancellation_requests JOIN orders ON orders.id = cancellation_requests.order_id
      WHERE cancellation_requests.id = $1 AND orders.merchant_id = $2`, [cancellationId, user.id]);
    if (!cancellation.rowCount) notFound('未找到本商户的取消申请。');
    const result = await query<{
      id: string; operation_id: string | null; business_number: string; batch_number: number; amount_minor: number; status: string;
      environment: string; provider: string; created_at: Date; updated_at: Date;
    }>(`SELECT id, operation_id, business_number, batch_number, amount_minor, status, environment, provider, created_at, updated_at
      FROM refund_batches WHERE cancellation_request_id = $1 ORDER BY batch_number`, [cancellationId]);
    return { batches: result.rows.map((batch) => ({
      id: batch.id, operationId: batch.operation_id, businessNumber: batch.business_number, batchNumber: batch.batch_number,
      amountMinor: batch.amount_minor, status: batch.status, environment: batch.environment, provider: batch.provider,
      createdAt: batch.created_at, updatedAt: batch.updated_at,
    })) };
  });

  app.post('/api/merchant/cancellations/:id/refund-batches', async (request, reply) => {
    const context = requireWrite(request, reply);
    if (!context) return;
    if (context.user.role !== 'merchant_admin') return reply.code(403).send({ error: 'FORBIDDEN', message: '只有商户管理员可以安排退款批次。' });
    const { id: cancellationId } = parse(paramsWithId, request.params);
    const response = await transaction((client) => runIdempotent(client, context.user.id, `POST /merchant/cancellations/${cancellationId}/refund-batches`, context.key, {}, async () => {
      const result = await client.query<{
        id: string; plan_id: string; confirmation_id: string; order_id: string; owner_id: string; merchant_id: string;
        amount_minor: number; refunded_minor: number; environment: 'simulation' | 'sandbox'; provider: 'simulation' | 'alipay';
        status: string; rule_preset: CancellationRule; accepted_fee_minor: number; accepted_refund_minor: number;
      }>(`
        SELECT cancellation_requests.id, orders.plan_id, cancellation_requests.confirmation_id, cancellation_requests.order_id,
          orders.owner_id, orders.merchant_id, orders.amount_minor, orders.refunded_minor, orders.environment, orders.provider,
          cancellation_requests.status, cancellation_requests.rule_preset,
          cancellation_requests.accepted_fee_minor, cancellation_requests.accepted_refund_minor
        FROM cancellation_requests JOIN orders ON orders.id = cancellation_requests.order_id
        WHERE cancellation_requests.id = $1 FOR UPDATE OF cancellation_requests, orders
      `, [cancellationId]);
      const cancellation = result.rows[0];
      if (!cancellation || cancellation.merchant_id !== context.user.id) notFound('未找到可退款的取消申请。');
      if (!['approved', 'refund_processing'].includes(cancellation.status)) {
        throw new AppError(422, 'REFUND_NOT_APPROVED', '只有商户已批准的取消申请可以安排退款。');
      }
      const isSandbox = cancellation.environment === 'sandbox';
      if (isSandbox && (!sandboxReadiness().ready || cancellation.provider !== 'alipay')) {
        throw new AppError(422, 'EXTERNAL_REFUND_NOT_READY', '沙箱退款配置或订单环境尚未就绪。');
      }
      if (!isSandbox && cancellation.provider !== 'simulation') throw new AppError(422, 'PAYMENT_ENVIRONMENT_MISMATCH', '退款环境不一致。');
      const details = cancellationRuleDetails(cancellation.rule_preset, cancellation.amount_minor);
      if (
        cancellation.accepted_fee_minor !== details.feeMinor
        || cancellation.accepted_refund_minor !== cancellation.amount_minor - details.feeMinor
      ) {
        throw new AppError(409, 'REFUND_RULE_SNAPSHOT_CONFLICT', '取消申请的规则快照与已确认金额不一致，不能继续安排退款。');
      }
      if (details.batchCount === 0 || cancellation.accepted_refund_minor <= 0) {
        throw new AppError(422, 'REFUND_NOT_AVAILABLE', '当前取消规则不允许创建退款批次。');
      }
      if (details.batchCount === 2 && cancellation.accepted_refund_minor % 2 !== 0) {
        throw new AppError(422, 'REFUND_BATCH_PLAN_INVALID', '分两批退款必须能均分已确认退款总额。');
      }

      const existing = await client.query<{
        id: string; operation_id: string | null; business_number: string; batch_number: number; amount_minor: number; status: string;
      }>(`SELECT id, operation_id, business_number, batch_number, amount_minor, status
        FROM refund_batches WHERE cancellation_request_id = $1 ORDER BY batch_number FOR UPDATE`, [cancellation.id]);
      const active = existing.rows.filter((batch) => ['pending', 'processing', 'unknown', 'pending_review'].includes(batch.status));
      if (active.length || existing.rows.length >= details.batchCount) {
        return {
          cancellationId: cancellation.id, reused: true,
          batches: existing.rows.map((batch) => ({
            id: batch.id, operationId: batch.operation_id, businessNumber: batch.business_number,
            batchNumber: batch.batch_number, amountMinor: batch.amount_minor, status: batch.status,
          })),
        };
      }
      if (isSandbox) {
        const recent = await client.query(`SELECT 1 FROM operations JOIN refund_batches ON refund_batches.operation_id=operations.id
          WHERE refund_batches.order_id=$1 AND operations.sent_at>now()-interval '3 seconds'`, [cancellation.order_id]);
        if (recent.rowCount) throw new AppError(429, 'REFUND_RATE_LIMITED', '同一订单的退款请求至少间隔 3 秒。');
      }
      const batchNumber = existing.rows.length + 1;
      const amountMinor = details.batchCount === 2 ? cancellation.accepted_refund_minor / 2 : cancellation.accepted_refund_minor;
      const allocatedMinor = sumMinor(existing.rows.map((batch) => batch.amount_minor));
      if (
        allocatedMinor + amountMinor > cancellation.accepted_refund_minor
        || cancellation.refunded_minor + amountMinor > cancellation.amount_minor
      ) {
        throw new AppError(409, 'REFUND_AMOUNT_EXCEEDED', '退款批次将超过已确认退款或原订单金额。');
      }
      const batchId = randomUUID();
      const businessNumber = isSandbox ? `XZ_RFD_${cancellation.id.replaceAll('-', '')}_${batchNumber}` : `SIM-RFD-${cancellation.id}-${batchNumber}`;
      await client.query(`INSERT INTO refund_batches (
        id, cancellation_request_id, order_id, merchant_id, environment, provider, batch_number, business_number, amount_minor
      ) VALUES ($1,$2,$3,$4,$8,$9,$5,$6,$7)`, [
        batchId, cancellation.id, cancellation.order_id, context.user.id, batchNumber, businessNumber, amountMinor, cancellation.environment, cancellation.provider,
      ]);
      const authorization = await client.query<{ id: string }>(`
        SELECT id FROM authorizations WHERE confirmation_id = $1 AND type = 'aftercare' ORDER BY created_at DESC LIMIT 1
      `, [cancellation.confirmation_id]);
      const operationId = await createOperationJob(client, {
        planId: cancellation.plan_id, ownerId: cancellation.owner_id, type: isSandbox ? 'sandbox_refund' : 'simulate_refund_batch', entityId: batchId,
        authorizationId: authorization.rows[0]?.id, purpose: `merchant_refund:${cancellation.id}:${batchNumber}`,
      });
      await client.query("UPDATE refund_batches SET operation_id = $2, updated_at = now() WHERE id = $1", [batchId, operationId]);
      await client.query("UPDATE cancellation_requests SET status = 'refund_processing', updated_at = now() WHERE id = $1", [cancellation.id]);
      await appendEvent(client, cancellation.plan_id, context.user.id, 'refund_batch.accepted', {
        cancellationId: cancellation.id, batchId, batchNumber, amountMinor, operationId, source: cancellation.environment,
      });
      return {
        cancellationId: cancellation.id, reused: false,
        batch: { id: batchId, operationId, businessNumber, batchNumber, amountMinor, status: 'pending', environment: cancellation.environment },
      };
    }));
    return reply.code(202).send(response);
  });

  app.get('/api/merchant/manual-tasks', async (request, reply) => {
    const user = requireRole(request, reply, 'merchant_admin');
    if (!user) return;
    const result = await query<{
      id: string; type: string; state: string; plan_id: string; order_id: string | null; cancellation_request_id: string | null;
      refund_batch_id: string | null; operation_id: string | null; reason: string; next_action: string; next_review_at: Date;
      claimed_by: string | null; claimed_at: Date | null; last_note: string | null; created_at: Date; updated_at: Date;
    }>(`SELECT id, type, state, plan_id, order_id, cancellation_request_id, refund_batch_id, operation_id, reason, next_action,
      next_review_at, claimed_by, claimed_at, last_note, created_at, updated_at
      FROM manual_tasks WHERE merchant_id = $1 ORDER BY state, next_review_at, created_at`, [user.id]);
    return { tasks: result.rows.map((task) => ({
      id: task.id, type: task.type, state: task.state, planId: task.plan_id, orderId: task.order_id,
      cancellationRequestId: task.cancellation_request_id, refundBatchId: task.refund_batch_id, operationId: task.operation_id,
      reason: task.reason, nextAction: task.next_action, nextReviewAt: task.next_review_at,
      claimedBy: task.claimed_by, claimedAt: task.claimed_at, lastNote: task.last_note,
      createdAt: task.created_at, updatedAt: task.updated_at,
    })) };
  });

  app.post('/api/merchant/manual-tasks/:id/actions', async (request, reply) => {
    const context = requireWrite(request, reply);
    if (!context) return;
    if (context.user.role !== 'merchant_admin') return reply.code(403).send({ error: 'FORBIDDEN', message: '只有商户管理员可以处理人工任务。' });
    const { id: taskId } = parse(paramsWithId, request.params);
    const input = parse(manualTaskActionInput, request.body);
    const response = await transaction((client) => runIdempotent(client, context.user.id, `POST /merchant/manual-tasks/${taskId}/actions`, context.key, input, async () => {
      const result = await client.query<{
        id: string; plan_id: string; merchant_id: string; state: string; claimed_by: string | null;
      }>('SELECT id, plan_id, merchant_id, state, claimed_by FROM manual_tasks WHERE id = $1 FOR UPDATE', [taskId]);
      const task = result.rows[0];
      if (!task || task.merchant_id !== context.user.id) notFound('未找到可处理的人工任务。');
      if (task.state === 'resolved') throw new AppError(409, 'MANUAL_TASK_RESOLVED', '该人工任务已经由对应业务事实关闭。');
      if (input.action === 'claim') {
        if (task.state === 'claimed' && task.claimed_by !== context.user.id) {
          throw new AppError(409, 'MANUAL_TASK_CLAIMED', '该人工任务已由其他商户人员领取。');
        }
        await client.query(`UPDATE manual_tasks
          SET state = 'claimed', claimed_by = $2, claimed_at = COALESCE(claimed_at, now()), updated_at = now()
          WHERE id = $1`, [task.id, context.user.id]);
        await appendEvent(client, task.plan_id, context.user.id, 'manual_task.claimed', { taskId: task.id });
        return { taskId: task.id, state: 'claimed' };
      }
      if (task.state !== 'claimed' || task.claimed_by !== context.user.id) {
        throw new AppError(409, 'MANUAL_TASK_NOT_CLAIMED', '请先领取该人工任务，再记录复核情况。');
      }
      await client.query(`UPDATE manual_tasks
        SET last_note = $2, next_review_at = now() + interval '1 day', updated_at = now()
        WHERE id = $1`, [task.id, input.note]);
      await appendEvent(client, task.plan_id, context.user.id, 'manual_task.recheck_recorded', { taskId: task.id });
      return { taskId: task.id, state: 'claimed', nextReviewAt: new Date(Date.now() + 24 * 60 * 60 * 1000) };
    }));
    return response;
  });

  app.post('/api/operations/:id/rechecks', async (request, reply) => {
    const context = requireWrite(request, reply);
    if (!context) return;
    const { id: operationId } = parse(paramsWithId, request.params);
    const input = parse(recheckInput, request.body);
    const response = await transaction((client) => runIdempotent(
      client,
      context.user.id,
      `POST /operations/${operationId}/rechecks`,
      context.key,
      input,
      () => requestOperationRecheck(client, context.user, operationId, input),
    ));
    return reply.code(202).send(response);
  });
}
