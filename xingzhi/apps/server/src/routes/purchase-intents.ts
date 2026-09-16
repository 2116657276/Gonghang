import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { z } from 'zod';
import { purchaseIntentConfirmInput, purchaseIntentCreateInput, purchaseIntentRejectInput } from '@xingzhi/contracts';
import { config } from '../config.js';
import { transaction } from '../db/client.js';
import { AppError } from '../domain/errors.js';
import { runIdempotent } from '../domain/idempotency.js';
import { createPurchaseIntent } from '../domain/purchase-intents.js';
import { confirmPurchaseIntent, readConsumerOrder } from '../domain/consumer-orders.js';
import { rejectPurchaseIntent } from '../domain/purchase-intent-lifecycle.js';

const intentPath = z.object({ id: z.string().uuid() }).strict();

function writeKey(request: FastifyRequest) {
  if (request.headers.origin !== config.webOrigin) {
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
    const data = await transaction((client) => readConsumerOrder(client, request.authUser!.id, id));
    return { data, meta: {} };
  });
}
