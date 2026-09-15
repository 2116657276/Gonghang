import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z, ZodError } from 'zod';
import {
  planningDraftAssessment,
  planningDraftInput,
  planningDraftView,
  type PlanningDraftInput,
  type PlanningDraftItem,
  type PlanningDraftView,
} from '@xingzhi/contracts';
import { config } from '../config.js';
import { query, transaction } from '../db/client.js';
import { AppError } from '../domain/errors.js';
import { runIdempotent } from '../domain/idempotency.js';
import type { PlanningDraftPort } from '../domain/planning-draft-port.js';

type TransactionRunner = <T>(run: (client: PoolClient) => Promise<T>) => Promise<T>;
type QueryClient = Pick<PoolClient, 'query'>;

const idPath = z.object({ id: z.string().uuid() }).strict();

export const unavailablePlanningDraftPort: PlanningDraftPort = {
  async assessPlanningDraft() {
    throw new AppError(409, 'FINANCE_BASIS_UNKNOWN', '逐日资金评估尚未接入，请稍后重试。');
  },
};

function writeKey(request: FastifyRequest) {
  if (request.headers.origin !== config.webOrigin) {
    throw new AppError(403, 'RESOURCE_FORBIDDEN', '请求来源不被允许。');
  }
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.trim().length < 8 || key.length > 200) {
    throw new AppError(400, 'VALIDATION_ERROR', '写入操作需要有效的 Idempotency-Key。');
  }
  return key;
}

function referencedCatalog(items: PlanningDraftItem[]) {
  return items.flatMap((item) => [
    item.catalogItemId ? { id: item.catalogItemId, plannedOn: item.plannedOn } : null,
    item.suggestion?.catalogItemId
      ? { id: item.suggestion.catalogItemId, plannedOn: item.suggestion.plannedOn ?? item.plannedOn }
      : null,
  ]).filter((reference): reference is { id: string; plannedOn: string | null } => reference !== null);
}

async function validateCatalogReferences(client: QueryClient, items: PlanningDraftItem[]) {
  const references = referencedCatalog(items);
  if (!references.length) return;
  const ids = [...new Set(references.map((reference) => reference.id))];
  const result = await client.query<{ id: string; active: boolean; availableFrom: string | null; availableTo: string | null }>(
    `SELECT id, active, to_char(available_from,'YYYY-MM-DD') AS "availableFrom",
      to_char(available_to,'YYYY-MM-DD') AS "availableTo"
      FROM catalog_items WHERE id=ANY($1::uuid[])`,
    [ids],
  );
  const byId = new Map(result.rows.map((row) => [row.id, row]));
  for (const reference of references) {
    const item = byId.get(reference.id);
    const dateUnavailable = reference.plannedOn !== null && item
      && ((item.availableFrom !== null && reference.plannedOn < item.availableFrom)
        || (item.availableTo !== null && reference.plannedOn > item.availableTo));
    if (!item || !item.active || dateUnavailable) {
      throw new AppError(409, 'QUOTE_STALE', '草稿引用的登记商品已不可用，请重新检索候选。');
    }
  }
}

function missingFields(items: PlanningDraftItem[]) {
  return items.flatMap((item, index) => [
    item.plannedOn === null ? `items.${index}.plannedOn` : null,
    item.userEstimatedAmountMinor === null ? `items.${index}.userEstimatedAmountMinor` : null,
    item.priority === null ? `items.${index}.priority` : null,
  ]).filter((field): field is string => field !== null);
}

function draftResponse(data: PlanningDraftView) {
  return {
    data,
    meta: {
      financialVersion: data.basisFinancialVersion,
      periodVersion: data.basisPeriodVersion,
    },
  };
}

async function createDraft(
  client: PoolClient,
  port: PlanningDraftPort,
  ownerId: string,
  input: PlanningDraftInput,
) {
  await validateCatalogReferences(client, input.items);
  const assessment = input.periodId === null ? null : planningDraftAssessment.parse(
    await port.assessPlanningDraft(
      client,
      ownerId,
      input.periodId,
      input.expectedFinancialVersion!,
      input.expectedPeriodVersion!,
      input.items,
    ),
  );
  const data = planningDraftView.parse({
    draftId: randomUUID(),
    periodId: input.periodId,
    status: 'draft',
    basisFinancialVersion: input.expectedFinancialVersion,
    basisPeriodVersion: input.expectedPeriodVersion,
    items: input.items,
    missingFields: missingFields(input.items),
    assessment,
  });
  await client.query(
    `INSERT INTO planning_drafts
      (id,owner_id,period_id,basis_financial_version,basis_period_version,model_source,validated_payload,status)
      VALUES($1,$2,$3,$4,$5,'validated_structured_v1',$6,'draft')`,
    [data.draftId, ownerId, data.periodId, data.basisFinancialVersion,
      data.basisPeriodVersion, { items: data.items, missingFields: data.missingFields, assessment: data.assessment }],
  );
  return draftResponse(data);
}

function storedDraft(row: {
  id: string;
  periodId: string | null;
  basisFinancialVersion: string | number | null;
  basisPeriodVersion: string | number | null;
  status: string;
  validatedPayload: Record<string, unknown>;
}) {
  return planningDraftView.parse({
    draftId: row.id,
    periodId: row.periodId,
    status: row.status,
    basisFinancialVersion: row.basisFinancialVersion === null ? null : Number(row.basisFinancialVersion),
    basisPeriodVersion: row.basisPeriodVersion === null ? null : Number(row.basisPeriodVersion),
    ...row.validatedPayload,
  });
}

export async function registerPlanningDraftApi(app: FastifyInstance, options: {
  planningDraftPort?: PlanningDraftPort;
  transaction?: TransactionRunner;
  db?: QueryClient;
} = {}) {
  const port = options.planningDraftPort ?? unavailablePlanningDraftPort;
  const runTransaction = options.transaction ?? transaction;
  const db = options.db ?? { query };

  app.setErrorHandler((error, request, reply) => {
    const code = error instanceof ZodError ? 'VALIDATION_ERROR'
      : error instanceof AppError ? error.code : 'INTERNAL_ERROR';
    if (!(error instanceof ZodError) && !(error instanceof AppError)) request.log.error(error);
    return reply.code(error instanceof ZodError ? 400 : error instanceof AppError ? error.statusCode : 500)
      .send({
        error: {
          code,
          message: error instanceof AppError ? error.message
            : code === 'VALIDATION_ERROR' ? '请求参数不符合要求。' : '服务暂时无法完成请求。',
          ...(error instanceof AppError && error.details ? { details: error.details } : {}),
        },
        correlationId: randomUUID(),
      });
  });
  app.addHook('preHandler', async (request) => {
    if (!request.authUser) throw new AppError(401, 'UNAUTHENTICATED', '请先登录。');
    if (request.authUser.role !== 'consumer') {
      throw new AppError(403, 'RESOURCE_FORBIDDEN', '仅消费者可使用规划草稿。');
    }
  });

  app.post('/api/ai/planning-drafts', async (request, reply) => {
    const input = planningDraftInput.parse(request.body);
    const key = writeKey(request);
    const response = await runTransaction((client) => runIdempotent(
      client,
      request.authUser!.id,
      'POST /api/ai/planning-drafts',
      key,
      input,
      async () => createDraft(client, port, request.authUser!.id, input),
    ));
    return reply.code(201).send(response);
  });

  app.get('/api/ai/planning-drafts/:id', async (request) => {
    const { id } = idPath.parse(request.params);
    const result = await db.query<{
      id: string;
      periodId: string | null;
      basisFinancialVersion: string | null;
      basisPeriodVersion: string | null;
      status: string;
      validatedPayload: Record<string, unknown>;
    }>(`SELECT id,period_id AS "periodId",basis_financial_version AS "basisFinancialVersion",
      basis_period_version AS "basisPeriodVersion",status,validated_payload AS "validatedPayload"
      FROM planning_drafts WHERE id=$1 AND owner_id=$2`, [id, request.authUser!.id]);
    const row = result.rows[0];
    if (!row) throw new AppError(404, 'RESOURCE_FORBIDDEN', '未找到该规划草稿。');
    return draftResponse(storedDraft(row));
  });
}
