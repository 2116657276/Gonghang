import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { query } from '../db/client.js';
import { AppError } from '../domain/errors.js';
import { reviewBudgetPeriod } from '../domain/budget-period-review.js';
import type { FinanceDb } from '../domain/finance-facts.js';

const path = z.object({ id: z.string().uuid() }).strict();

export async function registerBudgetPeriodReviewApi(app: FastifyInstance,
  options: { db?: FinanceDb } = {}) {
  const db = options.db ?? { query };
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
      throw new AppError(403, 'RESOURCE_FORBIDDEN', '仅消费者可查看本人月度复盘。');
    }
  });
  app.get('/api/budget-periods/:id/review', async (request) => {
    const { id } = path.parse(request.params);
    return { data: await reviewBudgetPeriod(db, request.authUser!.id, id), meta: {} };
  });
}
