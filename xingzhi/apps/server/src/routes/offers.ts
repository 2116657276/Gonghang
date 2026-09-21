import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { offerSearchInput, offerQuote, offerView } from '@xingzhi/contracts';
import { query } from '../db/client.js';
import { AppError } from '../domain/errors.js';

export async function registerOfferApi(app: FastifyInstance, options: { db?: Pick<PoolClient, 'query'> }) {
  const db = options.db ?? { query };
  // Encapsulation keeps historical API error responses unchanged.
  app.setErrorHandler((error, request, reply) => {
    const code = error instanceof ZodError ? 'VALIDATION_ERROR'
      : error instanceof AppError ? error.code : 'INTERNAL_ERROR';
    if (!(error instanceof ZodError) && !(error instanceof AppError)) request.log.error(error);
    reply.code(error instanceof ZodError ? 400 : error instanceof AppError ? error.statusCode : 500)
      .send({ error: { code, message: error instanceof AppError ? error.message : code === 'VALIDATION_ERROR' ? '请求参数不符合要求。' : '服务暂时无法完成请求。' }, correlationId: randomUUID() });
  });
  app.addHook('preHandler', async (request) => {
    if (!request.authUser) throw new AppError(401, 'UNAUTHENTICATED', '请先登录。');
    if (request.authUser.role !== 'consumer') throw new AppError(403, 'RESOURCE_FORBIDDEN', '仅消费者可使用此入口。');
  });
  app.get('/api/offers', async (request) => {
    const input = offerSearchInput.parse(request.query);
    const result = await db.query(`SELECT id, code, name, description, category_code AS "categoryCode",
      location_label AS "locationLabel", tags, purchase_mode AS "purchaseMode",
      price_minor AS "displayPriceMinor", currency, rule_label AS "ruleLabel"
      FROM catalog_items WHERE active AND currency='CNY'
      AND (available_from IS NULL OR available_from <= $1::date)
      AND (available_to IS NULL OR available_to >= $1::date)
      AND ($2::text IS NULL OR category_code=$2) ORDER BY code`, [input.plannedOn, input.categoryCode ?? null]);
    return { data: { items: result.rows.map((row) => offerView.parse(row)) }, meta: {} };
  });
  app.get('/api/offers/:id', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = await db.query(`SELECT id,code,name,description,category_code AS "categoryCode",
      location_label AS "locationLabel",tags,purchase_mode AS "purchaseMode",
      price_minor AS "displayPriceMinor",currency,rule_label AS "ruleLabel"
      FROM catalog_items WHERE id=$1 AND active AND currency='CNY'`, [id]);
    const row = result.rows[0];
    if (!row) throw new AppError(404, 'RESOURCE_FORBIDDEN', '未找到可用候选。');
    return { data: offerView.parse(row), meta: {} };
  });
  app.get('/api/offers/:id/quote', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { plannedOn } = offerSearchInput.pick({ plannedOn: true }).parse(request.query);
    const result = await db.query(`SELECT q.id AS "quoteId", q.catalog_item_id AS "catalogItemId",
      q.provider, q.quote_source AS "quoteSource", q.quote_version AS "quoteVersion",
      q.price_minor AS "priceMinor", q.currency, to_char(q.service_on,'YYYY-MM-DD') AS "serviceOn",
      q.rule_version AS "ruleVersion", q.rule_snapshot AS "ruleSnapshot", q.valid_until AS "validUntil", q.status
      FROM offer_quotes q JOIN catalog_items c ON c.id=q.catalog_item_id
      WHERE c.id=$1 AND c.active AND c.purchase_mode='orderable' AND c.currency='CNY'
      AND (c.available_from IS NULL OR c.available_from <= $2::date)
      AND (c.available_to IS NULL OR c.available_to >= $2::date)
      AND (q.service_on IS NULL OR q.service_on=$2::date)
      AND q.status='valid' AND q.valid_until > now() AND q.rule_version=c.rule_version
      ORDER BY q.quote_version DESC LIMIT 1`, [id, plannedOn]);
    const row = result.rows[0];
    if (!row) throw new AppError(409, 'QUOTE_STALE', '没有适用于该日期的有效报价，请重新选择商品或等待报价更新。');
    const data = offerQuote.parse({ ...row, quoteVersion: Number(row.quoteVersion), priceMinor: Number(row.priceMinor),
      ruleVersion: Number(row.ruleVersion), validUntil: row.validUntil.toISOString() });
    return { data, meta: { quoteVersion: data.quoteVersion, source: data.quoteSource } };
  });
}
