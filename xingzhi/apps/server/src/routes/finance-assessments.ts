import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { ZodError } from 'zod';
import { assessPurchaseInput } from '@xingzhi/contracts';
import { isTrustedWriteRequest } from '../auth/guards.js';
import { transaction } from '../db/client.js';
import { AppError } from '../domain/errors.js';
import { runIdempotent } from '../domain/idempotency.js';
import { assessPurchasePreview } from '../domain/purchase-assessment.js';

type TransactionRunner = <T>(run: (client: PoolClient) => Promise<T>) => Promise<T>;

function writeKey(request: FastifyRequest) {
  if (!isTrustedWriteRequest(request)) {
    throw new AppError(403, 'RESOURCE_FORBIDDEN', '请求来源不被允许。');
  }
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.trim().length < 8 || key.length > 200) {
    throw new AppError(400, 'VALIDATION_ERROR', '购买评估需要有效的 Idempotency-Key。');
  }
  return key;
}

export async function registerFinanceAssessmentApi(app: FastifyInstance,
  options: { transaction?: TransactionRunner } = {}) {
  const runTransaction = options.transaction ?? transaction;
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
      throw new AppError(403, 'RESOURCE_FORBIDDEN', '仅消费者可评估本人计划购买。');
    }
  });
  app.post('/api/finance/assessments', async (request, reply) => {
    const input = assessPurchaseInput.parse(request.body);
    const key = writeKey(request);
    const result = await runTransaction((client) => runIdempotent(
      client, request.authUser!.id, 'POST /api/finance/assessments', key,
      input, async () => ({ data: await assessPurchasePreview(client, request.authUser!.id, input), meta: {} }),
    ));
    return reply.code(201).send(result);
  });
}
