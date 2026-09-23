import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { budgetLedgerLinkInput, budgetLedgerUnlinkInput } from '@xingzhi/contracts';
import { isTrustedWriteRequest } from '../auth/guards.js';
import { query, transaction } from '../db/client.js';
import { AppError } from '../domain/errors.js';
import { runIdempotent } from '../domain/idempotency.js';
import { linkBudgetLedgerEntry, readBudgetLedgerLinks,
  unlinkBudgetLedgerEntry } from '../domain/budget-ledger-links.js';

const periodPath = z.object({ id: z.string().uuid() }).strict();
const linkPath = z.object({ id: z.string().uuid(), linkId: z.string().uuid() }).strict();
function keyForWrite(request: FastifyRequest) {
  if (!isTrustedWriteRequest(request)) throw new AppError(403, 'RESOURCE_FORBIDDEN', '请求来源不被允许。');
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.trim().length < 8 || key.length > 200) {
    throw new AppError(400, 'VALIDATION_ERROR', '请提供有效的 Idempotency-Key。');
  }
  return key;
}

export async function registerBudgetLedgerLinkApi(app: FastifyInstance) {
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
      throw new AppError(403, 'RESOURCE_FORBIDDEN', '仅消费者可以管理本人计划关联。');
    }
  });
  app.get('/api/budget-periods/:id/ledger-links', async (request) => {
    const { id } = periodPath.parse(request.params);
    return { data: await readBudgetLedgerLinks({ query }, request.authUser!.id, id), meta: {} };
  });
  app.post('/api/budget-periods/:id/ledger-links', async (request) => {
    const { id } = periodPath.parse(request.params);
    const input = budgetLedgerLinkInput.parse(request.body);
    const key = keyForWrite(request);
    return transaction((client) => runIdempotent(client, request.authUser!.id,
      `POST /api/budget-periods/${id}/ledger-links`, key, input,
      async () => ({ data: await linkBudgetLedgerEntry(client, request.authUser!.id, id, input), meta: {} })));
  });
  app.post('/api/budget-periods/:id/ledger-links/:linkId/unlinks', async (request) => {
    const { id, linkId } = linkPath.parse(request.params);
    const input = budgetLedgerUnlinkInput.parse(request.body);
    const key = keyForWrite(request);
    return transaction((client) => runIdempotent(client, request.authUser!.id,
      `POST /api/budget-periods/${id}/ledger-links/${linkId}/unlinks`, key, input,
      async () => ({ data: await unlinkBudgetLedgerEntry(client, request.authUser!.id,
        id, linkId, input.expectedPeriodVersion), meta: {} })));
  });
}
