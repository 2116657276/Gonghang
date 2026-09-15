import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { fundingAssessment, type AssessPurchaseInput, type FundingAssessment } from '@xingzhi/contracts';
import { AppError } from './errors.js';
import { forecastBudgetCashflow } from './budget-cashflow.js';
import type { PlanningOptionChange } from './budget-cashflow.js';

export type PurchaseItemRow = {
  id: string; accountId: string; periodId: string; kind: string; status: string;
  plannedOn: string; categoryCode: string | null; estimateMinor: string;
};
export type PurchaseQuoteRow = {
  id: string; catalogItemId: string; quoteVersion: string; priceMinor: string;
  currency: string; serviceOn: string | null; ruleVersion: string;
  quoteSource: string; providerQuoteRef: string | null; validUntil: Date;
  status: string; catalogActive: boolean; purchaseMode: string;
  catalogCurrency: string; catalogRuleVersion: number;
  availableFrom: string | null; availableTo: string | null; catalogCategoryCode: string | null;
};

export function safePurchaseMinor(value: number | string) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) {
    throw new AppError(409, 'FINANCE_BASIS_UNKNOWN', '资金金额超出可安全计算范围。');
  }
  return amount;
}

export async function readPurchaseItem(client: PoolClient, ownerId: string, periodId: string, budgetItemId: string,
  lock = false, allowedIntentId?: string) {
  const item = (await client.query<PurchaseItemRow>(`SELECT id,account_id AS "accountId",period_id AS "periodId",
    kind,status,to_char(planned_on,'YYYY-MM-DD') AS "plannedOn",
    category_code AS "categoryCode",user_estimated_amount_minor AS "estimateMinor"
    FROM budget_items WHERE id=$1 AND owner_id=$2 AND period_id=$3 ${lock ? 'FOR UPDATE' : ''}`,
  [budgetItemId, ownerId, periodId])).rows[0];
  if (!item) throw new AppError(404, 'RESOURCE_FORBIDDEN', '未找到本人预算项目。');
  if (item.kind !== 'planned_spend' || item.status !== 'planned') {
    throw new AppError(409, 'ITEM_NOT_ORDERABLE', '只有尚未下单的计划支出可购买。');
  }
  const existing = await client.query(`SELECT 1 FROM purchase_intents
    WHERE budget_item_id=$1 AND owner_id=$2 AND status IN ('proposed','confirmed','ordered')
      AND ($3::uuid IS NULL OR id<>$3::uuid) LIMIT 1`,
  [budgetItemId, ownerId, allowedIntentId ?? null]);
  if (existing.rowCount) {
    throw new AppError(409, 'ITEM_NOT_ORDERABLE', '该项目已有购买意图，不可重复预留。');
  }
  return item;
}

export async function readPurchaseQuote(client: PoolClient, quoteId: string, item: PurchaseItemRow,
  now: Date, lock = false) {
  const quote = (await client.query<PurchaseQuoteRow>(`SELECT q.id,q.catalog_item_id AS "catalogItemId",
    q.quote_version AS "quoteVersion",q.price_minor AS "priceMinor",q.currency,
    to_char(q.service_on,'YYYY-MM-DD') AS "serviceOn",q.rule_version AS "ruleVersion",
    q.quote_source AS "quoteSource",q.provider_quote_ref AS "providerQuoteRef",
    q.valid_until AS "validUntil",q.status,c.active AS "catalogActive",
    c.purchase_mode AS "purchaseMode",c.currency AS "catalogCurrency",
    c.rule_version AS "catalogRuleVersion",
    to_char(c.available_from,'YYYY-MM-DD') AS "availableFrom",
    to_char(c.available_to,'YYYY-MM-DD') AS "availableTo",
    c.category_code AS "catalogCategoryCode"
    FROM offer_quotes q JOIN catalog_items c ON c.id=q.catalog_item_id
    WHERE q.id=$1 ${lock ? 'FOR UPDATE OF q,c' : ''}`, [quoteId])).rows[0];
  if (!quote || quote.status !== 'valid' || quote.validUntil <= now
    || !quote.catalogActive || quote.purchaseMode !== 'orderable'
    || quote.currency !== 'CNY' || quote.catalogCurrency !== 'CNY'
    || quote.quoteSource === 'channel_api' && !quote.providerQuoteRef
    || safePurchaseMinor(quote.priceMinor) > 2_147_483_647
    || safePurchaseMinor(quote.ruleVersion) !== quote.catalogRuleVersion
    || quote.serviceOn !== null && quote.serviceOn !== item.plannedOn
    || quote.availableFrom !== null && item.plannedOn < quote.availableFrom
    || quote.availableTo !== null && item.plannedOn > quote.availableTo) {
    throw new AppError(409, 'QUOTE_STALE', '报价或商品条件已失效，请重新获取报价。');
  }
  if (item.categoryCode && quote.catalogCategoryCode && item.categoryCode !== quote.catalogCategoryCode) {
    throw new AppError(409, 'ITEM_NOT_ORDERABLE', '报价商品与计划项目类别不匹配。');
  }
  const newer = await client.query(`SELECT 1 FROM offer_quotes
    WHERE catalog_item_id=$1 AND quote_version>$2 AND status='valid' AND valid_until>$3
      AND (service_on IS NULL OR service_on=$4::date) LIMIT 1`,
  [quote.catalogItemId, quote.quoteVersion, now, item.plannedOn]);
  if (newer.rowCount) throw new AppError(409, 'QUOTE_STALE', '已有更新的报价，请重新获取。');
  return quote;
}

export async function assessPurchasePreview(client: PoolClient, ownerId: string,
  input: AssessPurchaseInput, now = new Date()): Promise<FundingAssessment> {
  const item = await readPurchaseItem(client, ownerId, input.periodId, input.budgetItemId);
  const quote = await readPurchaseQuote(client, input.quoteId, item, now);
  if (safePurchaseMinor(quote.quoteVersion) !== input.expectedQuoteVersion) {
    throw new AppError(409, 'QUOTE_STALE', '报价版本已变化，请刷新后重试。');
  }
  const quotedAmountMinor = safePurchaseMinor(quote.priceMinor);
  const replacedEstimateMinor = safePurchaseMinor(item.estimateMinor);
  const result = await forecastBudgetCashflow(client, ownerId, input.periodId, {
    expectedFinancialVersion: input.expectedFinancialVersion,
    expectedPeriodVersion: input.expectedPeriodVersion, now,
    replacement: { budgetItemId: item.id, quotedAmountMinor, quoteId: quote.id },
  });
  if (result.accountId !== item.accountId || result.basisSnapshotId === null) {
    throw new AppError(409, 'FINANCE_BASIS_UNKNOWN', '缺少可追溯的本人账户资金快照。');
  }
  const expiresAt = new Date(Math.min(now.getTime() + 5 * 60_000, quote.validUntil.getTime()));
  if (expiresAt <= now) throw new AppError(409, 'QUOTE_STALE', '报价已经过期。');
  const assessment = fundingAssessment.parse({
    assessmentId: randomUUID(), accountId: result.accountId, periodId: input.periodId,
    budgetItemId: item.id, quoteId: quote.id, basisSnapshotId: result.basisSnapshotId,
    financialVersion: result.financialVersion, periodVersion: result.periodVersion,
    quoteVersion: safePurchaseMinor(quote.quoteVersion), quotedAmountMinor,
    replacedEstimateMinor, incrementalImpactMinor: quotedAmountMinor - replacedEstimateMinor,
    status: result.forecast.status,
    // The existing shared DTO/column is non-null; for unknown this is NOT a quantified 0 gap.
    shortfallMinor: result.forecast.shortfallMinor ?? 0,
    affectedDates: result.forecast.affectedDates,
    reasonCodes: result.forecast.reasonCodes,
    expiresAt: expiresAt.toISOString(),
  });
  await client.query(`INSERT INTO funding_assessments
    (id,owner_id,period_id,account_id,budget_item_id,quote_id,financial_version,
      period_version,quote_version,replaced_estimate_minor,quoted_amount_minor,
      incremental_impact_minor,status,shortfall_minor,affected_dates,reason_codes,
      basis_snapshot_id,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::date[],$16::text[],$17,$18)`, [
    assessment.assessmentId, ownerId, assessment.periodId, assessment.accountId,
    assessment.budgetItemId, assessment.quoteId, assessment.financialVersion,
    assessment.periodVersion, assessment.quoteVersion, assessment.replacedEstimateMinor,
    assessment.quotedAmountMinor, assessment.incrementalImpactMinor, assessment.status,
    assessment.shortfallMinor, assessment.affectedDates, assessment.reasonCodes,
    assessment.basisSnapshotId, assessment.expiresAt,
  ]);
  return assessment;
}

export async function assessUnexpectedSpend(client: PoolClient, ownerId: string, periodId: string,
  input: { amountMinor: number; spendOn: string; expectedFinancialVersion: number;
    expectedPeriodVersion: number }, now = new Date()) {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new AppError(400, 'VALIDATION_ERROR', '意外支出金额必须为正整数分。');
  }
  return forecastBudgetCashflow(client, ownerId, periodId, {
    expectedFinancialVersion: input.expectedFinancialVersion,
    expectedPeriodVersion: input.expectedPeriodVersion, now,
    extraEvents: [{ on: input.spendOn, deltaMinor: -input.amountMinor,
      kind: 'planned_expense', referenceId: 'unexpected-spend-preview' }],
  });
}

/** B05 may compare options in memory; no cancellation or target change is applied here. */
export async function assessAdjustmentOption(client: PoolClient, ownerId: string, periodId: string,
  input: { changes: PlanningOptionChange[]; unexpectedSpend?: { amountMinor: number; spendOn: string };
    expectedFinancialVersion: number; expectedPeriodVersion: number }, now = new Date()) {
  if (input.unexpectedSpend && (!Number.isSafeInteger(input.unexpectedSpend.amountMinor)
    || input.unexpectedSpend.amountMinor <= 0)) {
    throw new AppError(400, 'VALIDATION_ERROR', '意外支出金额必须为正整数分。');
  }
  return forecastBudgetCashflow(client, ownerId, periodId, {
    expectedFinancialVersion: input.expectedFinancialVersion,
    expectedPeriodVersion: input.expectedPeriodVersion, now, optionChanges: input.changes,
    extraEvents: input.unexpectedSpend ? [{ on: input.unexpectedSpend.spendOn,
      deltaMinor: -input.unexpectedSpend.amountMinor, kind: 'planned_expense',
      referenceId: 'unexpected-spend-option' }] : [],
  });
}
