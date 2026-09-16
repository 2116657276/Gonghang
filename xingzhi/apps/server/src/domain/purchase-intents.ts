import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  purchaseIntentView,
  type PurchaseIntentCreateInput,
  type PurchaseIntentView,
} from '@xingzhi/contracts';
import { AppError } from './errors.js';
import { readPurchaseItem, readPurchaseQuote, safePurchaseMinor } from './purchase-assessment.js';

type AssessmentRow = {
  accountId: string;
  periodId: string;
  budgetItemId: string;
  quoteId: string;
  financialVersion: string;
  periodVersion: string;
  quoteVersion: string;
  replacedEstimateMinor: string;
  quotedAmountMinor: string;
  incrementalImpactMinor: string;
  status: 'allowed' | 'needs_adjustment' | 'blocked' | 'unknown';
  shortfallMinor: string;
  affectedDates: string[];
  reasonCodes: string[];
  expiresAt: Date;
};

function rejectAssessment(status: AssessmentRow['status']): never {
  const code = status === 'blocked' ? 'INSUFFICIENT_FUNDS'
    : status === 'needs_adjustment' ? 'SAVINGS_TARGET_AT_RISK'
      : 'FINANCE_BASIS_UNKNOWN';
  throw new AppError(409, code, '该资金评估不能进入购买确认，请先调整计划或刷新资金依据。', { status });
}

export async function createPurchaseIntent(
  client: PoolClient,
  ownerId: string,
  idempotencyKey: string,
  input: PurchaseIntentCreateInput,
  now = new Date(),
): Promise<PurchaseIntentView> {
  const item = await readPurchaseItem(client, ownerId, input.periodId, input.budgetItemId, true);
  const quote = await readPurchaseQuote(client, input.quoteId, item, now, true);
  if (safePurchaseMinor(quote.quoteVersion) !== input.expectedQuoteVersion) {
    throw new AppError(409, 'QUOTE_STALE', '报价版本已变化，请重新获取报价和资金评估。');
  }

  const basis = (await client.query<{
    accountStatus: string;
    financialVersion: string;
    periodStatus: string;
    periodVersion: string;
  }>(`SELECT a.status AS "accountStatus",a.financial_version AS "financialVersion",
      p.status AS "periodStatus",p.version AS "periodVersion"
    FROM budget_periods p JOIN finance_accounts a ON a.id=p.primary_account_id
    WHERE p.id=$1 AND p.owner_id=$2 AND a.id=$3`, [input.periodId, ownerId, item.accountId])).rows[0];
  if (!basis || basis.accountStatus !== 'linked') {
    throw new AppError(409, 'FINANCE_SCOPE_REVOKED', '账户授权已撤回，不能建立新的购买意图。');
  }
  if (basis.periodStatus !== 'active'
    || safePurchaseMinor(basis.financialVersion) !== input.expectedFinancialVersion
    || safePurchaseMinor(basis.periodVersion) !== input.expectedPeriodVersion) {
    throw new AppError(409, 'VERSION_CONFLICT', '资金或预算版本已变化，请重新评估。');
  }

  const assessment = (await client.query<AssessmentRow>(`SELECT
      account_id AS "accountId",period_id AS "periodId",budget_item_id AS "budgetItemId",
      quote_id AS "quoteId",financial_version AS "financialVersion",
      period_version AS "periodVersion",quote_version AS "quoteVersion",
      replaced_estimate_minor AS "replacedEstimateMinor",
      quoted_amount_minor AS "quotedAmountMinor",
      incremental_impact_minor AS "incrementalImpactMinor",status,
      shortfall_minor AS "shortfallMinor",affected_dates AS "affectedDates",
      reason_codes AS "reasonCodes",expires_at AS "expiresAt"
    FROM funding_assessments WHERE id=$1 AND owner_id=$2`, [input.assessmentId, ownerId])).rows[0];
  if (!assessment) throw new AppError(404, 'RESOURCE_FORBIDDEN', '未找到本人的购买评估。');
  if (assessment.periodId !== input.periodId || assessment.budgetItemId !== input.budgetItemId
    || assessment.quoteId !== input.quoteId || assessment.accountId !== item.accountId) {
    throw new AppError(409, 'CONFIRMATION_SCOPE_MISMATCH', '评估、预算项目和报价不属于同一确认范围。');
  }
  if (safePurchaseMinor(assessment.financialVersion) !== input.expectedFinancialVersion
    || safePurchaseMinor(assessment.periodVersion) !== input.expectedPeriodVersion) {
    throw new AppError(409, 'VERSION_CONFLICT', '评估依据版本与当前请求不一致。');
  }
  if (safePurchaseMinor(assessment.quoteVersion) !== input.expectedQuoteVersion
    || safePurchaseMinor(assessment.quotedAmountMinor) !== safePurchaseMinor(quote.priceMinor)
    || safePurchaseMinor(assessment.replacedEstimateMinor) !== safePurchaseMinor(item.estimateMinor)) {
    throw new AppError(409, 'QUOTE_STALE', '评估中的估价或报价已经失效，请重新评估。');
  }
  if (assessment.status !== 'allowed') rejectAssessment(assessment.status);
  if (assessment.expiresAt <= now) {
    throw new AppError(409, 'VERSION_CONFLICT', '购买评估已过期，请重新评估。');
  }

  const purchaseIntentId = randomUUID();
  const inserted = (await client.query<{ createdAt: Date }>(`INSERT INTO purchase_intents
      (id,owner_id,period_id,budget_item_id,quote_id,assessment_id,financial_version,
        period_version,quote_version,expires_at,idempotency_key)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING created_at AS "createdAt"`, [purchaseIntentId, ownerId, input.periodId,
    input.budgetItemId, input.quoteId, input.assessmentId, input.expectedFinancialVersion,
    input.expectedPeriodVersion, input.expectedQuoteVersion, assessment.expiresAt,
    idempotencyKey])).rows[0]!;

  const result = purchaseIntentView.parse({
    purchaseIntentId,
    periodId: input.periodId,
    budgetItemId: input.budgetItemId,
    quoteId: input.quoteId,
    assessmentId: input.assessmentId,
    status: 'proposed',
    item: {
      title: item.title,
      plannedOn: item.plannedOn,
      userEstimatedAmountMinor: safePurchaseMinor(item.estimateMinor),
    },
    offer: {
      catalogItemId: quote.catalogItemId,
      name: quote.catalogName,
      provider: quote.provider,
      quoteSource: quote.quoteSource,
      quotedAmountMinor: safePurchaseMinor(quote.priceMinor),
      currency: quote.currency,
      quoteVersion: safePurchaseMinor(quote.quoteVersion),
      ruleVersion: safePurchaseMinor(quote.ruleVersion),
      ruleLabel: quote.ruleLabel,
      ruleSnapshot: quote.ruleSnapshot,
    },
    funding: {
      status: 'allowed',
      financialVersion: safePurchaseMinor(assessment.financialVersion),
      periodVersion: safePurchaseMinor(assessment.periodVersion),
      incrementalImpactMinor: safePurchaseMinor(assessment.incrementalImpactMinor),
      shortfallMinor: safePurchaseMinor(assessment.shortfallMinor),
      affectedDates: assessment.affectedDates,
      reasonCodes: assessment.reasonCodes,
    },
    confirmationRequired: true,
    expiresAt: assessment.expiresAt.toISOString(),
    createdAt: inserted.createdAt.toISOString(),
  });
  await client.query(`INSERT INTO budget_events (owner_id,period_id,actor_id,type,data)
    VALUES($1,$2,$1,'purchase_intent_proposed',$3::jsonb)`, [ownerId, input.periodId,
    JSON.stringify({ purchaseIntentId, budgetItemId: input.budgetItemId,
      quoteId: input.quoteId, assessmentId: input.assessmentId,
      userEstimatedAmountMinor: result.item.userEstimatedAmountMinor,
      quotedAmountMinor: result.offer.quotedAmountMinor,
      incrementalImpactMinor: result.funding.incrementalImpactMinor }),
  ]);
  return result;
}
