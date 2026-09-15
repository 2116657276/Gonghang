import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z, ZodError } from 'zod';
import {
  budgetItemCancelInput,
  budgetItemChangeInput,
  offerQuote,
  offerView,
  type BudgetItemMutationResult,
} from '@xingzhi/contracts';
import { config } from '../config.js';
import { transaction } from '../db/client.js';
import type { BudgetItemPort } from '../domain/budget-port.js';
import { AppError } from '../domain/errors.js';
import { runIdempotent } from '../domain/idempotency.js';

type TransactionRunner = <T>(run: (client: PoolClient) => Promise<T>) => Promise<T>;

const pathPeriod = z.object({ id: z.string().uuid() }).strict();
const pathItem = z.object({ id: z.string().uuid(), itemId: z.string().uuid() }).strict();

export const unavailableBudgetItemPort: BudgetItemPort = {
  async applyBudgetItemChange() {
    throw new AppError(409, 'FINANCE_BASIS_UNKNOWN', '资金项目写入能力尚未接入，请稍后重试。');
  },
  async cancelBudgetItem() {
    throw new AppError(409, 'FINANCE_BASIS_UNKNOWN', '资金项目写入能力尚未接入，请稍后重试。');
  },
};

function writeContext(request: FastifyRequest) {
  if (request.headers.origin !== config.webOrigin) {
    throw new AppError(403, 'RESOURCE_FORBIDDEN', '请求来源不被允许。');
  }
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.trim().length < 8 || key.length > 200) {
    throw new AppError(400, 'VALIDATION_ERROR', '写入操作需要有效的 Idempotency-Key。');
  }
  return key;
}

async function candidateOffers(client: PoolClient, result: BudgetItemMutationResult) {
  if (result.item.status !== 'planned') return [];
  const rows = await client.query(`SELECT c.id, c.code, c.name, c.description,
      c.category_code AS "categoryCode", c.location_label AS "locationLabel", c.tags,
      c.purchase_mode AS "purchaseMode", c.price_minor AS "displayPriceMinor",
      c.currency, c.rule_label AS "ruleLabel", q.id AS "quoteId",
      q.provider, q.quote_source AS "quoteSource", q.quote_version AS "quoteVersion",
      q.price_minor AS "priceMinor", q.service_on AS "serviceOn",
      q.rule_version AS "quoteRuleVersion", q.rule_snapshot AS "ruleSnapshot",
      q.valid_until AS "validUntil", q.status AS "quoteStatus"
    FROM catalog_items c
    JOIN LATERAL (
      SELECT * FROM offer_quotes candidate
      WHERE candidate.catalog_item_id=c.id
        AND candidate.status='valid' AND candidate.valid_until > now()
        AND (candidate.service_on IS NULL OR candidate.service_on=$1::date)
        AND candidate.rule_version=c.rule_version
      ORDER BY candidate.quote_version DESC LIMIT 1
    ) q ON true
    WHERE c.active AND c.purchase_mode='orderable' AND c.currency='CNY'
      AND (c.available_from IS NULL OR c.available_from <= $1::date)
      AND (c.available_to IS NULL OR c.available_to >= $1::date)
      AND ($2::text IS NULL OR c.category_code=$2)
    ORDER BY q.price_minor, c.code LIMIT 10`, [result.item.plannedOn, result.item.categoryCode]);
  return rows.rows.map((row) => ({
    offer: offerView.parse({
      id: row.id, code: row.code, name: row.name, description: row.description,
      categoryCode: row.categoryCode, locationLabel: row.locationLabel, tags: row.tags,
      purchaseMode: row.purchaseMode, displayPriceMinor: Number(row.displayPriceMinor),
      currency: row.currency, ruleLabel: row.ruleLabel,
    }),
    quote: offerQuote.parse({
      quoteId: row.quoteId, catalogItemId: row.id, provider: row.provider,
      quoteSource: row.quoteSource, quoteVersion: Number(row.quoteVersion),
      priceMinor: Number(row.priceMinor), currency: row.currency,
      serviceOn: row.serviceOn ? row.serviceOn.toISOString().slice(0, 10) : null,
      ruleVersion: Number(row.quoteRuleVersion), ruleSnapshot: row.ruleSnapshot,
      validUntil: row.validUntil.toISOString(), status: row.quoteStatus,
    }),
  }));
}

async function responseWithCandidates(client: PoolClient, result: BudgetItemMutationResult) {
  return {
    data: { ...result, candidateOffers: await candidateOffers(client, result) },
    meta: {
      financialVersion: result.basis.financialVersion,
      periodVersion: result.basis.periodVersion,
      asOf: result.basis.asOf,
    },
  };
}

export async function registerBudgetItemApi(app: FastifyInstance, options: {
  budgetItemPort?: BudgetItemPort;
  transaction?: TransactionRunner;
} = {}) {
  const budgetItemPort = options.budgetItemPort ?? unavailableBudgetItemPort;
  const runTransaction = options.transaction ?? transaction;

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
      throw new AppError(403, 'RESOURCE_FORBIDDEN', '仅消费者可修改预算项目。');
    }
  });

  app.post('/api/budget-periods/:id/items', async (request, reply) => {
    const { id: periodId } = pathPeriod.parse(request.params);
    const input = budgetItemChangeInput.parse(request.body);
    if (input.periodId !== periodId || input.itemId !== null) {
      throw new AppError(400, 'VALIDATION_ERROR', '路径周期必须与正文一致，新增项目的 itemId 必须为 null。');
    }
    const key = writeContext(request);
    const route = `POST /api/budget-periods/${periodId}/items`;
    const response = await runTransaction((client) => runIdempotent(
      client, request.authUser!.id, route, key, input,
      async () => responseWithCandidates(client, await budgetItemPort.applyBudgetItemChange(client, request.authUser!.id, input)),
    ));
    return reply.code(201).send(response);
  });

  app.patch('/api/budget-periods/:id/items/:itemId', async (request) => {
    const path = pathItem.parse(request.params);
    const input = budgetItemChangeInput.parse(request.body);
    if (input.periodId !== path.id || input.itemId !== path.itemId) {
      throw new AppError(400, 'VALIDATION_ERROR', '路径中的周期和项目必须与正文一致。');
    }
    const key = writeContext(request);
    const route = `PATCH /api/budget-periods/${path.id}/items/${path.itemId}`;
    return runTransaction((client) => runIdempotent(
      client, request.authUser!.id, route, key, input,
      async () => responseWithCandidates(client, await budgetItemPort.applyBudgetItemChange(client, request.authUser!.id, input)),
    ));
  });

  app.post('/api/budget-periods/:id/items/:itemId/cancellations', async (request) => {
    const path = pathItem.parse(request.params);
    const input = budgetItemCancelInput.parse(request.body);
    if (input.periodId !== path.id || input.itemId !== path.itemId) {
      throw new AppError(400, 'VALIDATION_ERROR', '路径中的周期和项目必须与正文一致。');
    }
    const key = writeContext(request);
    const route = `POST /api/budget-periods/${path.id}/items/${path.itemId}/cancellations`;
    return runTransaction((client) => runIdempotent(
      client, request.authUser!.id, route, key, input,
      async () => responseWithCandidates(client, await budgetItemPort.cancelBudgetItem(client, request.authUser!.id, input)),
    ));
  });
}
