import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { budgetAdjustmentConfirmInput, emergencyAssessInput } from '@xingzhi/contracts';
import { config } from '../config.js';
import { transaction } from '../db/client.js';
import { confirmBudgetAdjustment, createBudgetAdjustment } from '../domain/budget-adjustments.js';
import { AppError } from '../domain/errors.js';
import { runIdempotent } from '../domain/idempotency.js';

const adjustmentPath = z.object({ id: z.string().uuid() }).strict();
const eventQuery = z.object({ cursor: z.coerce.number().int().nonnegative().default(0) }).strict();

function writeKey(request: FastifyRequest) {
  if (request.headers.origin !== config.webOrigin) {
    throw new AppError(403, 'RESOURCE_FORBIDDEN', '请求来源不被允许。');
  }
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.trim().length < 8 || key.length > 200) {
    throw new AppError(400, 'VALIDATION_ERROR', '调整操作需要有效的 Idempotency-Key。');
  }
  return key;
}

export async function registerBudgetAdjustmentApi(app: FastifyInstance) {
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
      throw new AppError(403, 'RESOURCE_FORBIDDEN', '仅消费者可评估和确认本人调整。');
    }
  });
  app.post('/api/emergencies/assess', async (request, reply) => {
    const input = emergencyAssessInput.parse(request.body);
    const key = writeKey(request);
    const response = await transaction((client) => runIdempotent(client, request.authUser!.id,
      'POST /api/emergencies/assess', key, input, async () => {
        const data = await createBudgetAdjustment(client, request.authUser!.id, input);
        return { data, meta: { financialVersion: data.basisFinancialVersion,
          periodVersion: data.basisPeriodVersion, expiresAt: data.expiresAt } };
      }));
    return reply.code(201).send(response);
  });
  app.post('/api/adjustments/:id/confirm', async (request, reply) => {
    const { id } = adjustmentPath.parse(request.params);
    const input = budgetAdjustmentConfirmInput.parse(request.body);
    const key = writeKey(request);
    const response = await transaction((client) => runIdempotent(client, request.authUser!.id,
      `POST /api/adjustments/${id}/confirm`, key, input, async () => {
        const data = await confirmBudgetAdjustment(client, request.authUser!.id, id, input);
        return { data, meta: { financialVersion: data.financialVersion,
          periodVersion: data.periodVersion } };
      }));
    return reply.code(201).send(response);
  });
  app.get('/api/adjustments/:id', async (request) => {
    const { id } = adjustmentPath.parse(request.params);
    const result = await transaction(async (client) => {
      const adjustment = (await client.query<{
        adjustmentId: string; periodId: string; status: string; reason: string;
        proposedChanges: Record<string, unknown>; expiresAt: Date; confirmedAt: Date | null;
      }>(`SELECT id AS "adjustmentId",period_id AS "periodId",status,reason,
          proposed_changes AS "proposedChanges",expires_at AS "expiresAt",
          confirmed_at AS "confirmedAt"
        FROM budget_adjustment_proposals WHERE id=$1 AND owner_id=$2`,
      [id, request.authUser!.id])).rows[0];
      if (!adjustment) throw new AppError(404, 'RESOURCE_FORBIDDEN', '未找到本人的调整方案。');
      const cancellations = (await client.query(`SELECT c.id AS "cancellationRequestId",
          c.order_id AS "orderId",c.status,c.decision,c.decision_reason AS "decisionReason",
          c.accepted_fee_minor AS "acceptedFeeMinor",c.accepted_refund_minor AS "acceptedRefundMinor",
          COALESCE(SUM(b.amount_minor) FILTER (WHERE b.status='succeeded'),0)::integer AS "channelRefundSucceededMinor"
        FROM cancellation_requests c LEFT JOIN refund_batches b ON b.cancellation_request_id=c.id
        WHERE c.budget_adjustment_id=$1 AND c.owner_id=$2
        GROUP BY c.id ORDER BY c.created_at,c.id`, [id, request.authUser!.id])).rows;
      return { ...adjustment, expiresAt: adjustment.expiresAt.toISOString(),
        confirmedAt: adjustment.confirmedAt?.toISOString() ?? null, cancellations };
    });
    return { data: result, meta: {} };
  });
  app.get('/api/budget-periods/:id/events', async (request) => {
    const { id } = adjustmentPath.parse(request.params);
    const { cursor } = eventQuery.parse(request.query);
    const data = await transaction(async (client) => {
      const owned = await client.query('SELECT 1 FROM budget_periods WHERE id=$1 AND owner_id=$2',
        [id, request.authUser!.id]);
      if (!owned.rowCount) throw new AppError(404, 'RESOURCE_FORBIDDEN', '未找到本人的预算周期。');
      const rows = (await client.query<{ id: string; type: string; data: Record<string, unknown>;
        observedAt: Date }>(`SELECT id::text,type,data,created_at AS "observedAt"
        FROM budget_events WHERE period_id=$1 AND owner_id=$2 AND id>$3
        ORDER BY id LIMIT 100`, [id, request.authUser!.id, cursor])).rows;
      return rows.map((row) => ({ ...row, observedAt: row.observedAt.toISOString() }));
    });
    return { data: { events: data }, meta: { nextCursor: data.at(-1)?.id ?? String(cursor) } };
  });
}
