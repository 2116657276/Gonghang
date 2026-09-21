import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { z } from 'zod';
import { consumerOrderView, purchaseIntentConfirmInput, purchaseIntentCreateInput, purchaseIntentRejectInput } from '@xingzhi/contracts';
import { isTrustedWriteRequest } from '../auth/guards.js';
import { transaction } from '../db/client.js';
import { AppError } from '../domain/errors.js';
import { runIdempotent } from '../domain/idempotency.js';
import { createPurchaseIntent } from '../domain/purchase-intents.js';
import { confirmPurchaseIntent, readConsumerOrder } from '../domain/consumer-orders.js';
import { rejectPurchaseIntent } from '../domain/purchase-intent-lifecycle.js';

const intentPath = z.object({ id: z.string().uuid() }).strict();

function writeKey(request: FastifyRequest) {
  if (!isTrustedWriteRequest(request)) {
    throw new AppError(403, 'RESOURCE_FORBIDDEN', '请求来源不被允许。');
  }
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.trim().length < 8 || key.length > 200) {
    throw new AppError(400, 'VALIDATION_ERROR', '购买意图需要有效的 Idempotency-Key。');
  }
  return key;
}

export async function registerPurchaseIntentApi(app: FastifyInstance) {
  app.setErrorHandler((error, request, reply) => {
    const code = error instanceof ZodError ? 'VALIDATION_ERROR'
      : error instanceof AppError ? error.code : 'INTERNAL_ERROR';
    if (!(error instanceof ZodError) && !(error instanceof AppError)) request.log.error(error);
    return reply.code(error instanceof ZodError ? 400 : error instanceof AppError ? error.statusCode : 500)
      .send({ error: { code, message: error instanceof AppError ? error.message
        : code === 'VALIDATION_ERROR' ? '请求参数不符合要求。' : '服务暂时无法完成请求。',
      ...(error instanceof AppError && error.details ? { details: error.details } : {}) },
      correlationId: randomUUID() });
  });
  app.addHook('preHandler', async (request) => {
    if (!request.authUser) throw new AppError(401, 'UNAUTHENTICATED', '请先登录。');
    if (request.authUser.role !== 'consumer') {
      throw new AppError(403, 'RESOURCE_FORBIDDEN', '仅消费者可建立本人购买意图。');
    }
  });
  async function readIntent(ownerId: string, id?: string) {
    const rows = (await transaction((client) => client.query<{
      purchaseIntentId: string; periodId: string; budgetItemId: string; quoteId: string;
      assessmentId: string; status: string; acceptedAmountMinor: number | null;
      expiresAt: Date; createdAt: Date; itemTitle: string; plannedOn: string;
      userEstimatedAmountMinor: number; offerName: string; quotedAmountMinor: number;
      quoteVersion: string; financialVersion: string; periodVersion: string; orderId: string | null;
    }>(`SELECT intent.id AS "purchaseIntentId",intent.period_id AS "periodId",
        intent.budget_item_id AS "budgetItemId",intent.quote_id AS "quoteId",
        intent.assessment_id AS "assessmentId",intent.status,
        intent.accepted_amount_minor AS "acceptedAmountMinor",intent.expires_at AS "expiresAt",
        intent.created_at AS "createdAt",item.title AS "itemTitle",
        to_char(item.planned_on,'YYYY-MM-DD') AS "plannedOn",
        item.user_estimated_amount_minor AS "userEstimatedAmountMinor",catalog.name AS "offerName",
        quote.price_minor AS "quotedAmountMinor",quote.quote_version AS "quoteVersion",
        assessment.financial_version AS "financialVersion",assessment.period_version AS "periodVersion",
        orders.id AS "orderId"
      FROM purchase_intents intent
      JOIN budget_items item ON item.id=intent.budget_item_id AND item.owner_id=intent.owner_id
      JOIN offer_quotes quote ON quote.id=intent.quote_id
      JOIN catalog_items catalog ON catalog.id=quote.catalog_item_id
      JOIN funding_assessments assessment ON assessment.id=intent.assessment_id AND assessment.owner_id=intent.owner_id
      LEFT JOIN orders ON orders.purchase_intent_id=intent.id AND orders.owner_id=intent.owner_id
      WHERE intent.owner_id=$1 AND ($2::uuid IS NULL OR intent.id=$2)
      ORDER BY intent.created_at DESC,intent.id`, [ownerId, id ?? null]))).rows;
    return rows.map((row) => ({ ...row, quotedAmountMinor: Number(row.quotedAmountMinor),
      userEstimatedAmountMinor: Number(row.userEstimatedAmountMinor),
      acceptedAmountMinor: row.acceptedAmountMinor === null ? null : Number(row.acceptedAmountMinor),
      quoteVersion: Number(row.quoteVersion), financialVersion: Number(row.financialVersion),
      periodVersion: Number(row.periodVersion), plannedOn: row.plannedOn,
      expiresAt: row.expiresAt.toISOString(), createdAt: row.createdAt.toISOString() }));
  }

  app.get('/api/purchase-intents', async (request) => ({
    data: { intents: await readIntent(request.authUser!.id) }, meta: {},
  }));
  app.get('/api/purchase-intents/:id', async (request) => {
    const { id } = intentPath.parse(request.params);
    const intent = (await readIntent(request.authUser!.id, id))[0];
    if (!intent) throw new AppError(404, 'RESOURCE_FORBIDDEN', '未找到本人的购买意图。');
    return { data: intent, meta: {} };
  });

  app.get('/api/orders', async (request) => {
    const rows = (await transaction((client) => client.query<{
      orderId: string; purchaseIntentId: string; budgetPeriodId: string; itemName: string;
      amountMinor: number; currency: string; environment: string; provider: string;
      status: string; paymentStatus: string; refundedMinor: number; createdAt: Date;
      updatedAt: Date; operationId: string | null; operationState: string | null;
    }>(`SELECT orders.id AS "orderId",orders.purchase_intent_id AS "purchaseIntentId",
        orders.budget_period_id AS "budgetPeriodId",orders.item_name AS "itemName",
        orders.amount_minor AS "amountMinor",orders.currency,orders.environment,orders.provider,
        orders.status,orders.payment_status AS "paymentStatus",orders.refunded_minor AS "refundedMinor",
        orders.created_at AS "createdAt",orders.updated_at AS "updatedAt",
        operation.id AS "operationId",operation.state AS "operationState"
      FROM orders LEFT JOIN LATERAL (
        SELECT operations.id,operations.state FROM operations
        WHERE operations.owner_id=orders.owner_id AND (
          operations.entity_id=orders.id OR operations.aftercare_preview_id IN (
            SELECT preview.id FROM consumer_aftercare_previews preview WHERE preview.order_id=orders.id
          )
        ) ORDER BY operations.created_at DESC LIMIT 1
      ) operation ON true
      WHERE orders.owner_id=$1 AND orders.purchase_intent_id IS NOT NULL
      ORDER BY orders.created_at DESC,orders.id`, [request.authUser!.id]))).rows;
    const orders = rows.map((row) => {
      const { operationId, operationState, ...order } = row;
      return { ...consumerOrderView.parse({ ...order,
        amountMinor: Number(order.amountMinor), refundedMinor: Number(order.refundedMinor),
        createdAt: order.createdAt.toISOString(), updatedAt: order.updatedAt.toISOString() }),
        operationId, operationState };
    });
    return { data: { orders }, meta: {} };
  });
  app.post('/api/purchase-intents', async (request, reply) => {
    const input = purchaseIntentCreateInput.parse(request.body);
    const key = writeKey(request);
    const response = await transaction((client) => runIdempotent(
      client, request.authUser!.id, 'POST /api/purchase-intents', key, input,
      async () => {
        const data = await createPurchaseIntent(client, request.authUser!.id, key, input);
        return { data, meta: { financialVersion: data.funding.financialVersion,
          periodVersion: data.funding.periodVersion, quoteVersion: data.offer.quoteVersion,
          expiresAt: data.expiresAt } };
      },
    ));
    return reply.code(201).send(response);
  });
  app.post('/api/purchase-intents/:id/confirm', async (request, reply) => {
    const { id } = intentPath.parse(request.params);
    const input = purchaseIntentConfirmInput.parse(request.body);
    const key = writeKey(request);
    const response = await transaction((client) => runIdempotent(
      client, request.authUser!.id, `POST /api/purchase-intents/${id}/confirm`, key, input,
      async () => {
        const data = await confirmPurchaseIntent(client, request.authUser!.id, id, input);
        return { data, meta: { financialVersion: data.financialVersion,
          periodVersion: data.periodVersion } };
      },
    ));
    return reply.code(201).send(response);
  });
  app.post('/api/purchase-intents/:id/rejections', async (request) => {
    const { id } = intentPath.parse(request.params);
    const input = purchaseIntentRejectInput.parse(request.body);
    const key = writeKey(request);
    return transaction((client) => runIdempotent(
      client, request.authUser!.id, `POST /api/purchase-intents/${id}/rejections`, key, input,
      async () => ({ data: await rejectPurchaseIntent(client, request.authUser!.id, id), meta: {} }),
    ));
  });
  app.get('/api/orders/:id', async (request) => {
    const { id } = intentPath.parse(request.params);
    const data = await transaction(async (client) => {
      const order = await readConsumerOrder(client, request.authUser!.id, id);
      const operations = (await client.query<{ operationId: string; operationState: string; operationType: string;
        purpose: string; createdAt: Date; updatedAt: Date }>(
        `SELECT operations.id AS "operationId",operations.state AS "operationState",
          operations.type AS "operationType",operations.purpose,operations.created_at AS "createdAt",
          operations.updated_at AS "updatedAt"
        FROM operations WHERE operations.owner_id=$1 AND (
          operations.entity_id=$2 OR operations.aftercare_preview_id IN (
            SELECT preview.id FROM consumer_aftercare_previews preview WHERE preview.order_id=$2
          )
        ) ORDER BY operations.created_at DESC`,
        [request.authUser!.id, id],
      )).rows.map(value => ({ ...value, createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString() }));
      return { ...order, operationId: operations[0]?.operationId ?? null,
        operationState: operations[0]?.operationState ?? null, operations };
    });
    return { data, meta: {} };
  });
}
