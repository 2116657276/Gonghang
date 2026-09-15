import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import {
  budgetPeriodCreateInput, budgetPeriodActivationInput, savingsTargetChangeInput,
} from '@xingzhi/contracts';
import { config } from '../config.js';
import { query, transaction } from '../db/client.js';
import { AppError } from '../domain/errors.js';
import { runIdempotent } from '../domain/idempotency.js';
import {
  createBudgetPeriod, readBudgetPeriod, activateBudgetPeriod, changeSavingsTarget,
} from '../domain/budget-periods.js';

const periodPath = z.object({ id: z.string().uuid() }).strict();
function keyForWrite(request: FastifyRequest) {
  if (request.headers.origin !== config.webOrigin) {
    throw new AppError(403, 'RESOURCE_FORBIDDEN', '请求来源不被允许。');
  }
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.trim().length < 8 || key.length > 200) {
    throw new AppError(400, 'VALIDATION_ERROR', '写入操作需要有效的 Idempotency-Key。');
  }
  return key;
}
function response(result: Awaited<ReturnType<typeof readBudgetPeriod>>) {
  return { data: result, meta: { financialVersion: result.basis.financialVersion,
    periodVersion: result.basis.periodVersion, asOf: result.basis.asOf } };
}

export async function registerBudgetPeriodApi(app: FastifyInstance) {
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
      throw new AppError(403, 'RESOURCE_FORBIDDEN', '仅消费者可管理本人预算。');
    }
  });
  app.get('/api/budget-periods', async (request) => {
    const periods = (await query<{ id: string }>(`SELECT id FROM budget_periods WHERE owner_id=$1
      ORDER BY month_start DESC,id`, [request.authUser!.id])).rows;
    const results = [];
    for (const period of periods) {
      results.push(await transaction((client) => readBudgetPeriod(client, request.authUser!.id, period.id)));
    }
    return { data: { periods: results }, meta: {} };
  });
  app.get('/api/budget-periods/:id', async (request) => {
    const { id } = periodPath.parse(request.params);
    return response(await transaction((client) => readBudgetPeriod(client, request.authUser!.id, id)));
  });
  app.post('/api/budget-periods', async (request, reply) => {
    const input = budgetPeriodCreateInput.parse(request.body);
    const key = keyForWrite(request);
    const result = await transaction((client) => runIdempotent(client, request.authUser!.id,
      'POST /api/budget-periods', key, input,
      async () => response(await createBudgetPeriod(client, request.authUser!.id, input))));
    return reply.code(201).send(result);
  });
  app.post('/api/budget-periods/:id/activations', async (request) => {
    const { id } = periodPath.parse(request.params);
    const input = budgetPeriodActivationInput.parse(request.body);
    const key = keyForWrite(request);
    return transaction((client) => runIdempotent(client, request.authUser!.id,
      `POST /api/budget-periods/${id}/activations`, key, input,
      async () => response(await activateBudgetPeriod(client, request.authUser!.id, id, input))));
  });
  app.patch('/api/budget-periods/:id/savings-target', async (request) => {
    const { id } = periodPath.parse(request.params);
    const input = savingsTargetChangeInput.parse(request.body);
    const key = keyForWrite(request);
    return transaction((client) => runIdempotent(client, request.authUser!.id,
      `PATCH /api/budget-periods/${id}/savings-target`, key, input,
      async () => {
        const result = await changeSavingsTarget(client, request.authUser!.id, id, input);
        return { ...response(result), data: { ...result, targetChangeId: result.targetChangeId } };
      }));
  });
}
