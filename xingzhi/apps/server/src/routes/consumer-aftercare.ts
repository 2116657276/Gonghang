import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { aftercareConfirmationInput, aftercarePreviewInput } from '@xingzhi/contracts';
import { isTrustedWriteRequest } from '../auth/guards.js';
import { transaction } from '../db/client.js';
import { confirmAftercare, createAftercarePreview } from '../domain/consumer-aftercare.js';
import { AppError } from '../domain/errors.js';
import { runIdempotent } from '../domain/idempotency.js';
import { createOperationJob } from '../domain/jobs.js';
import { sandboxReadiness } from '../payment/alipay-sandbox.js';

const orderPath = z.object({ id: z.string().uuid() }).strict();

function writeKey(request: FastifyRequest) {
  if (!isTrustedWriteRequest(request)) {
    throw new AppError(403, 'RESOURCE_FORBIDDEN', '请求来源不被允许。');
  }
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.trim().length < 8 || key.length > 200) {
    throw new AppError(400, 'VALIDATION_ERROR', '善后操作需要有效的 Idempotency-Key。');
  }
  return key;
}

export async function registerConsumerAftercareApi(app: FastifyInstance) {
  app.setErrorHandler((error, request, reply) => {
    const code = error instanceof ZodError ? 'VALIDATION_ERROR'
      : error instanceof AppError ? error.code : 'INTERNAL_ERROR';
    if (!(error instanceof ZodError) && !(error instanceof AppError)) request.log.error(error);
    return reply.code(error instanceof ZodError ? 400 : error instanceof AppError ? error.statusCode : 500)
      .send({ error: { code, message: error instanceof AppError ? error.message
        : code === 'VALIDATION_ERROR' ? '请求参数不符合要求。' : '服务暂时无法完成请求.',
      ...(error instanceof AppError && error.details ? { details: error.details } : {}) },
      correlationId: randomUUID() });
  });
  app.addHook('preHandler', async (request) => {
    if (!request.authUser) throw new AppError(401, 'UNAUTHENTICATED', '请先登录。');
    if (request.authUser.role !== 'consumer') {
      throw new AppError(403, 'RESOURCE_FORBIDDEN', '仅消费者本人可处理订单善后。');
    }
  });
  app.get('/api/orders/:id/aftercare', async (request) => {
    const { id } = orderPath.parse(request.params);
    const data = await transaction(async (client) => {
      const order = (await client.query<{ orderId: string; status: string; paymentStatus: string;
        amountMinor: number; refundedMinor: number }>(`SELECT id AS "orderId",status,
          payment_status AS "paymentStatus",amount_minor AS "amountMinor",
          refunded_minor AS "refundedMinor" FROM orders
        WHERE id=$1 AND owner_id=$2 AND purchase_intent_id IS NOT NULL`,
      [id, request.authUser!.id])).rows[0];
      if (!order) throw new AppError(404, 'RESOURCE_FORBIDDEN', '未找到本人新消费者订单。');
      const previews = (await client.query<{ previewId: string; action: string; status: string;
        feeMinor: number; refundMinor: number; expiresAt: Date; confirmedAt: Date | null; createdAt: Date }>(
        `SELECT id AS "previewId",action,status,accepted_fee_minor AS "feeMinor",
          accepted_refund_minor AS "refundMinor",expires_at AS "expiresAt",
          confirmed_at AS "confirmedAt",created_at AS "createdAt"
        FROM consumer_aftercare_previews WHERE order_id=$1 AND owner_id=$2 ORDER BY created_at DESC`,
      [id, request.authUser!.id])).rows;
      const cancellations = (await client.query<{ requestId: string; status: string; decision: string | null;
        decisionReason: string | null; feeMinor: number; refundMinor: number; createdAt: Date; updatedAt: Date }>(
        `SELECT id AS "requestId",status,decision,decision_reason AS "decisionReason",
          accepted_fee_minor AS "feeMinor",accepted_refund_minor AS "refundMinor",
          created_at AS "createdAt",updated_at AS "updatedAt"
        FROM cancellation_requests WHERE order_id=$1 AND owner_id=$2 ORDER BY created_at DESC`,
      [id, request.authUser!.id])).rows;
      const batches = (await client.query<{ batchId: string; operationId: string | null; batchNumber: number;
        amountMinor: number; status: string; environment: string; provider: string; createdAt: Date; updatedAt: Date }>(
        `SELECT id AS "batchId",operation_id AS "operationId",batch_number AS "batchNumber",
          amount_minor AS "amountMinor",status,environment,provider,created_at AS "createdAt",updated_at AS "updatedAt"
        FROM refund_batches WHERE order_id=$1 ORDER BY batch_number`, [id])).rows;
      const moneyEvents = (await client.query<{ eventId: string; eventType: string; amountMinor: number;
        verificationState: string; occurredAt: Date; source: string }>(`SELECT id AS "eventId",
          event_type AS "eventType",amount_minor AS "amountMinor",verification_state AS "verificationState",
          occurred_at AS "occurredAt",source FROM finance_money_events
        WHERE order_id=$1 AND owner_id=$2 AND event_type LIKE 'refund_%' ORDER BY occurred_at`,
      [id, request.authUser!.id])).rows;
      return {
        order: { ...order, amountMinor: Number(order.amountMinor), refundedMinor: Number(order.refundedMinor) },
        previews: previews.map(value => ({ ...value, feeMinor: Number(value.feeMinor), refundMinor: Number(value.refundMinor),
          expiresAt: value.expiresAt.toISOString(), confirmedAt: value.confirmedAt?.toISOString() ?? null,
          createdAt: value.createdAt.toISOString() })),
        cancellations: cancellations.map(value => ({ ...value, feeMinor: Number(value.feeMinor),
          refundMinor: Number(value.refundMinor), createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString() })),
        batches: batches.map(value => ({ ...value, amountMinor: Number(value.amountMinor),
          createdAt: value.createdAt.toISOString(), updatedAt: value.updatedAt.toISOString() })),
        moneyEvents: moneyEvents.map(value => ({ ...value, amountMinor: Number(value.amountMinor), occurredAt: value.occurredAt.toISOString() })),
      };
    });
    return { data, meta: {} };
  });
  app.post('/api/orders/:id/aftercare-previews', async (request, reply) => {
    const { id } = orderPath.parse(request.params);
    const input = aftercarePreviewInput.parse(request.body);
    const key = writeKey(request);
    const response = await transaction((client) => runIdempotent(client, request.authUser!.id,
      `POST /api/orders/${id}/aftercare-previews`, key, input,
      async () => ({ data: await createAftercarePreview(client, request.authUser!.id, id, input), meta: {} })));
    return reply.code(201).send(response);
  });
  app.post('/api/orders/:id/aftercare-confirmations', async (request, reply) => {
    const { id } = orderPath.parse(request.params);
    const input = aftercareConfirmationInput.parse(request.body);
    const key = writeKey(request);
    const response = await transaction((client) => runIdempotent(client, request.authUser!.id,
      `POST /api/orders/${id}/aftercare-confirmations`, key, input,
      async () => ({ data: await confirmAftercare(client, request.authUser!.id, id, input), meta: {} })));
    return reply.code(202).send(response);
  });
  app.post('/api/orders/:id/refund-rechecks', async (request, reply) => {
    const { id } = orderPath.parse(request.params);
    const key = writeKey(request);
    const response = await transaction((client) => runIdempotent(client, request.authUser!.id,
      `POST /api/orders/${id}/refund-rechecks`, key, {}, async () => {
        const batch = (await client.query<{ batchId: string; periodId: string; status: string;
          environment: string; operationId: string | null }>(`SELECT b.id AS "batchId",
            o.budget_period_id AS "periodId",b.status,b.environment,b.operation_id AS "operationId"
          FROM refund_batches b JOIN orders o ON o.id=b.order_id
          WHERE b.order_id=$1 AND o.owner_id=$2 AND o.purchase_intent_id IS NOT NULL
          ORDER BY b.batch_number DESC LIMIT 1 FOR UPDATE OF b`, [id, request.authUser!.id])).rows[0];
        if (!batch) throw new AppError(409, 'REFUND_RECHECK_UNAVAILABLE', '该订单还没有可复核的退款批次。');
        if (batch.status === 'succeeded') return { data: { orderId: id, batchId: batch.batchId,
          status: 'succeeded', operationId: batch.operationId, reused: true }, meta: {} };
        if (batch.environment !== 'sandbox') throw new AppError(422, 'REFUND_RECHECK_UNAVAILABLE',
          '本地模拟退款由后台任务处理，请查看运行状态或处理记录。');
        if (!sandboxReadiness().ready) throw new AppError(422, 'PAYMENT_SANDBOX_NOT_READY', '支付宝沙箱查询配置尚未就绪。');
        const existing = (await client.query<{ id: string; state: string }>(`SELECT id,state FROM operations
          WHERE budget_period_id=$1 AND owner_id=$2 AND entity_id=$3
            AND type IN ('sandbox_refund','sandbox_refund_recheck') AND state IN ('accepted','processing')
          ORDER BY created_at DESC LIMIT 1`, [batch.periodId, request.authUser!.id, batch.batchId])).rows[0];
        if (existing) return { data: { orderId: id, batchId: batch.batchId,
          status: existing.state, operationId: existing.id, reused: true }, meta: {} };
        const operationId = await createOperationJob(client, { budgetPeriodId: batch.periodId,
          ownerId: request.authUser!.id, type: 'sandbox_refund_recheck', entityId: batch.batchId,
          purpose: `消费者主动复核原退款批次:${batch.batchId}` });
        return { data: { orderId: id, batchId: batch.batchId, status: 'accepted', operationId, reused: false }, meta: {} };
      }));
    return reply.code(202).send(response);
  });
}
