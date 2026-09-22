import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { merchantDecisionInput, merchantTaskActionInput } from '@xingzhi/contracts';
import { z, ZodError } from 'zod';
import { isTrustedWriteRequest } from '../auth/guards.js';
import { transaction } from '../db/client.js';
import { AppError } from '../domain/errors.js';
import { runIdempotent } from '../domain/idempotency.js';
import { recheckInput, requestOperationRecheck } from '../domain/operation-rechecks.js';
import {
  actMerchantConsumerTask, decideMerchantConsumerCancellation, listMerchantConsumerCancellations,
  listMerchantConsumerOrders, listMerchantConsumerRefunds, listMerchantConsumerTasks,
  readMerchantConsumerOrder, scheduleMerchantConsumerRefund,
} from '../domain/merchant-consumer.js';

const idPath = z.object({ id: z.string().uuid() }).strict();
function writeKey(request: FastifyRequest) {
  if (!isTrustedWriteRequest(request)) throw new AppError(403, 'RESOURCE_FORBIDDEN', '请求来源不被允许。');
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.trim().length < 8 || key.length > 200) {
    throw new AppError(400, 'VALIDATION_ERROR', '写入操作需要有效的 Idempotency-Key。');
  }
  return key;
}

export async function registerMerchantConsumerApi(app: FastifyInstance) {
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
  app.addHook('preHandler', async request => {
    if (!request.authUser) throw new AppError(401, 'UNAUTHENTICATED', '请先登录。');
    if (request.authUser.role !== 'merchant_admin') {
      throw new AppError(403, 'RESOURCE_FORBIDDEN', '仅商户管理员可处理本人商品的新订单。');
    }
  });
  app.get('/api/merchant/consumer-orders', async request => ({
    data: { orders: await transaction(client => listMerchantConsumerOrders(client, request.authUser!.id)) }, meta: {},
  }));
  app.get('/api/merchant/consumer-orders/:id', async request => {
    const { id } = idPath.parse(request.params);
    return { data: await transaction(client => readMerchantConsumerOrder(client, request.authUser!.id, id)), meta: {} };
  });
  app.get('/api/merchant/consumer-cancellations', async request => ({ data: {
    cancellations: await transaction(client => listMerchantConsumerCancellations(client, request.authUser!.id)),
  }, meta: {} }));
  app.post('/api/merchant/consumer-cancellations/:id/decisions', async (request, reply) => {
    const { id } = idPath.parse(request.params); const input = merchantDecisionInput.parse(request.body);
    const key = writeKey(request);
    const response = await transaction(client => runIdempotent(client, request.authUser!.id,
      `POST /api/merchant/consumer-cancellations/${id}/decisions`, key, input,
      async () => ({ data: await decideMerchantConsumerCancellation(client, request.authUser!.id, id, input), meta: {} })));
    return reply.send(response);
  });
  app.get('/api/merchant/consumer-cancellations/:id/refund-batches', async request => {
    const { id } = idPath.parse(request.params);
    return { data: { batches: await transaction(client => listMerchantConsumerRefunds(client,
      request.authUser!.id, id)) }, meta: {} };
  });
  app.post('/api/merchant/consumer-cancellations/:id/refund-batches', async (request, reply) => {
    const { id } = idPath.parse(request.params); const key = writeKey(request);
    const response = await transaction(client => runIdempotent(client, request.authUser!.id,
      `POST /api/merchant/consumer-cancellations/${id}/refund-batches`, key, {},
      async () => ({ data: await scheduleMerchantConsumerRefund(client, request.authUser!.id, id), meta: {} })));
    return reply.code(202).send(response);
  });
  app.get('/api/merchant/consumer-manual-tasks', async request => ({ data: {
    tasks: await transaction(client => listMerchantConsumerTasks(client, request.authUser!.id)),
  }, meta: {} }));
  app.post('/api/merchant/consumer-manual-tasks/:id/actions', async request => {
    const { id } = idPath.parse(request.params); const input = merchantTaskActionInput.parse(request.body);
    const key = writeKey(request);
    return transaction(client => runIdempotent(client, request.authUser!.id,
      `POST /api/merchant/consumer-manual-tasks/${id}/actions`, key, input,
      async () => ({ data: await actMerchantConsumerTask(client, request.authUser!.id, id, input), meta: {} })));
  });
  app.post('/api/merchant/consumer-operations/:id/rechecks', async (request, reply) => {
    const { id } = idPath.parse(request.params); const input = recheckInput.parse(request.body);
    const key = writeKey(request);
    const response = await transaction(client => runIdempotent(client, request.authUser!.id,
      `POST /api/merchant/consumer-operations/${id}/rechecks`, key, input,
      async () => ({ data: await requestOperationRecheck(client, request.authUser!, id, input), meta: {} })));
    return reply.code(202).send(response);
  });
}
