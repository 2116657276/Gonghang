import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import {
  budgetPeriodCreateInput, budgetPeriodActivationInput, budgetPeriodCloseInput, savingsTargetChangeInput,
  budgetItemChangeInput,
} from '@xingzhi/contracts';
import { isTrustedWriteRequest } from '../auth/guards.js';
import { query, transaction } from '../db/client.js';
import { AppError } from '../domain/errors.js';
import { runIdempotent } from '../domain/idempotency.js';
import {
  createBudgetPeriod, readBudgetPeriod, activateBudgetPeriod, changeSavingsTarget,
} from '../domain/budget-periods.js';
import { forecastBudgetCashflow, previewBudgetItemChange, previewBudgetItemImpact } from '../domain/budget-cashflow.js';

const periodPath = z.object({ id: z.string().uuid() }).strict();
const itemImpactPath = z.object({ id: z.string().uuid(), itemId: z.string().uuid() }).strict();
function keyForWrite(request: FastifyRequest) {
  if (!isTrustedWriteRequest(request)) {
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
  app.get('/api/budget-periods/:id/rolling-cashflow', async (request) => {
    const { id } = periodPath.parse(request.params);
    const result = await transaction((client) => forecastBudgetCashflow(
      client, request.authUser!.id, id, { rolling30: true },
    ));
    return { data: { periodId: result.periodId, accountId: result.accountId,
      financialVersion: result.financialVersion, periodVersion: result.periodVersion,
      asOf: result.asOf, conditionalIncomeMinor: result.conditionalIncomeMinor,
      forecast: result.forecast },
    meta: { financialVersion: result.financialVersion, periodVersion: result.periodVersion,
      asOf: result.asOf } };
  });
  app.get('/api/budget-periods/:id/items/:itemId/impact', async (request) => {
    const { id, itemId } = itemImpactPath.parse(request.params);
    const result = await transaction((client) => previewBudgetItemImpact(
      client, request.authUser!.id, id, itemId,
    ));
    return { data: result, meta: { financialVersion: result.financialVersion,
      periodVersion: result.periodVersion } };
  });
  app.post('/api/budget-periods/:id/items/change-preview', async (request) => {
    const { id } = periodPath.parse(request.params);
    const input = budgetItemChangeInput.parse(request.body);
    if (input.periodId !== id) throw new AppError(400, 'VALIDATION_ERROR', '路径周期必须与预览项目一致。');
    const result = await transaction((client) => previewBudgetItemChange(
      client, request.authUser!.id, id, input,
    ));
    return { data: result, meta: { financialVersion: result.financialVersion,
      periodVersion: result.periodVersion } };
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
  app.post('/api/budget-periods/:id/closures', async (request) => {
    const { id } = periodPath.parse(request.params);
    const input = budgetPeriodCloseInput.parse(request.body);
    const key = keyForWrite(request);
    return transaction((client) => runIdempotent(client, request.authUser!.id,
      `POST /api/budget-periods/${id}/closures`, key, input, async () => {
        const period = (await client.query<{ status: string; version: string; monthEnd: string; alreadyEnded: boolean }>(
          `SELECT status,version,to_char(month_end,'YYYY-MM-DD') AS "monthEnd",
            ((now() AT TIME ZONE 'Asia/Shanghai')::date > month_end) AS "alreadyEnded"
          FROM budget_periods WHERE id=$1 AND owner_id=$2 FOR UPDATE`, [id, request.authUser!.id])).rows[0];
        if (!period) throw new AppError(404, 'RESOURCE_FORBIDDEN', '未找到本人预算周期。');
        if (period.status === 'closed') return response(await readBudgetPeriod(client, request.authUser!.id, id));
        if (period.status !== 'active') throw new AppError(409, 'PERIOD_NOT_ACTIVE', '只有执行中的预算周期可以结束。');
        if (Number(period.version) !== input.expectedPeriodVersion) {
          throw new AppError(409, 'PERIOD_VERSION_CONFLICT', '预算周期已经变化，请刷新后重新确认。');
        }
        if (!period.alreadyEnded) throw new AppError(409, 'PERIOD_NOT_ENDED', `本周期将在 ${period.monthEnd} 结束，结束后才能归档。`);
        const blockers = (await client.query<{ kind: string; count: string }>(`SELECT kind,count(*)::text FROM (
            SELECT 'purchase_intent' AS kind FROM purchase_intents WHERE period_id=$1 AND owner_id=$2 AND status='proposed'
            UNION ALL SELECT 'order' FROM orders WHERE budget_period_id=$1 AND owner_id=$2 AND payment_status IN ('pending','unknown')
            UNION ALL SELECT 'cancellation' FROM cancellation_requests c JOIN orders o ON o.id=c.order_id
              WHERE o.budget_period_id=$1 AND c.owner_id=$2 AND c.status IN ('submitted','approved','delayed','refund_processing','pending_review')
            UNION ALL SELECT 'adjustment' FROM budget_adjustment_proposals WHERE period_id=$1 AND owner_id=$2
              AND status IN ('proposed','confirmed','executing','pending_review')
            UNION ALL SELECT 'operation' FROM operations WHERE budget_period_id=$1 AND owner_id=$2
              AND state IN ('accepted','processing','unknown','pending_review')
          ) pending GROUP BY kind`, [id, request.authUser!.id])).rows;
        if (blockers.length) throw new AppError(409, 'PERIOD_CLOSE_BLOCKED', '仍有待确认、支付、退款或复核事项，处理完成后才能归档。',
          { blockers: blockers.map(value => ({ kind: value.kind, count: Number(value.count) })) });
        await client.query(`UPDATE budget_periods SET status='closed',closed_at=now() WHERE id=$1 AND owner_id=$2`,
          [id, request.authUser!.id]);
        await client.query(`INSERT INTO budget_events(owner_id,period_id,actor_id,type,data)
          VALUES($1,$2,$1,'budget_period_closed',$3::jsonb)`, [request.authUser!.id, id,
          JSON.stringify({ reason: input.reason, previousVersion: input.expectedPeriodVersion })]);
        return response(await readBudgetPeriod(client, request.authUser!.id, id));
      }));
  });
}
