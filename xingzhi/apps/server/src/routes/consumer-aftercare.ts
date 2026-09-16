import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { aftercareConfirmationInput, aftercarePreviewInput } from '@xingzhi/contracts';
import { config } from '../config.js';
import { transaction } from '../db/client.js';
import { confirmAftercare, createAftercarePreview } from '../domain/consumer-aftercare.js';
import { AppError } from '../domain/errors.js';
import { runIdempotent } from '../domain/idempotency.js';

const orderPath = z.object({ id: z.string().uuid() }).strict();

function writeKey(request: FastifyRequest) {
  if (request.headers.origin !== config.webOrigin) {
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
}
