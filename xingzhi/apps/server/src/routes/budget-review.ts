import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { budgetEvidenceExportInput, budgetEvidenceExportView } from '@xingzhi/contracts';
import { z, ZodError } from 'zod';
import { isTrustedWriteRequest } from '../auth/guards.js';
import { transaction } from '../db/client.js';
import { AppError } from '../domain/errors.js';
import { runIdempotent } from '../domain/idempotency.js';
import { createBudgetEvidenceExport, listBudgetReviews, readBudgetEvidenceExport,
  readBudgetReviewEvidence } from '../domain/budget-review.js';

const idPath = z.object({ id: z.string().uuid() }).strict();
function writeKey(request: FastifyRequest) {
  if (!isTrustedWriteRequest(request)) throw new AppError(403, 'RESOURCE_FORBIDDEN', '请求来源不被允许。');
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.trim().length < 8 || key.length > 200) {
    throw new AppError(400, 'VALIDATION_ERROR', '写入操作需要有效的 Idempotency-Key。');
  }
  return key;
}

export async function registerBudgetReviewApi(app: FastifyInstance) {
  app.setErrorHandler((error, request, reply) => {
    const code = error instanceof ZodError ? 'VALIDATION_ERROR'
      : error instanceof AppError ? error.code : 'INTERNAL_ERROR';
    if (!(error instanceof ZodError) && !(error instanceof AppError)) request.log.error(error);
    return reply.code(error instanceof ZodError ? 400 : error instanceof AppError ? error.statusCode : 500)
      .send({ error: { code, message: error instanceof AppError ? error.message
        : code === 'VALIDATION_ERROR' ? '请求参数不符合要求。' : '服务暂时无法完成请求.' },
      correlationId: randomUUID() });
  });
  app.addHook('preHandler', async request => {
    if (!request.authUser) throw new AppError(401, 'UNAUTHENTICATED', '请先登录。');
    if (request.authUser.role !== 'reviewer') {
      throw new AppError(403, 'RESOURCE_FORBIDDEN', '仅审核者可以读取分配给本人的预算证据。');
    }
  });
  app.get('/api/reviewer/budget-periods', async request => ({ data: {
    periods: await transaction(client => listBudgetReviews(client, request.authUser!.id)),
  }, meta: {} }));
  app.get('/api/reviewer/budget-periods/:id', async request => {
    const { id } = idPath.parse(request.params);
    return { data: await transaction(client => readBudgetReviewEvidence(client, request.authUser!.id, id)), meta: {} };
  });
  app.post('/api/reviewer/budget-periods/:id/evidence-exports', async (request, reply) => {
    const { id } = idPath.parse(request.params); const input = budgetEvidenceExportInput.parse(request.body);
    const key = writeKey(request);
    const response = await transaction(client => runIdempotent(client, request.authUser!.id,
      `POST /api/reviewer/budget-periods/${id}/evidence-exports`, key, input,
      async () => ({ data: budgetEvidenceExportView.parse(await createBudgetEvidenceExport(client,
        request.authUser!.id, id, input.format)), meta: {} })));
    return reply.code(201).send(response);
  });
  app.get('/api/reviewer/evidence-exports/:id', async (request, reply) => {
    const { id } = idPath.parse(request.params);
    const value = await transaction(client => readBudgetEvidenceExport(client, request.authUser!.id, id));
    return reply.type(value.format === 'json' ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8')
      .send(value.content);
  });
}
