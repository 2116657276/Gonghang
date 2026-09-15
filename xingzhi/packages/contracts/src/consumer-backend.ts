import { z } from 'zod';

// Shared A/B boundary for the new consumer workflow. Legacy plan contracts
// remain in index.ts for previously accepted orders and aftercare.
const uuid = z.string().uuid();
const version = z.number().int().positive().safe();
const positiveMinor = z.number().int().positive().safe();
const nonnegativeMinor = z.number().int().nonnegative().safe();
// Legacy orders.amount_minor is still INTEGER; widening it would change the
// existing pg runtime's number handling, so new orderable quotes use this cap.
const orderableMinor = positiveMinor.max(2_147_483_647);
const instant = z.string().datetime({ offset: true });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, '日期必须是有效的 YYYY-MM-DD。');

export const fundingStatuses = ['allowed', 'needs_adjustment', 'blocked', 'unknown'] as const;
export const budgetItemKinds = ['expected_income', 'essential_expense', 'planned_spend'] as const;
export const budgetItemPriorities = ['required', 'adjustable'] as const;
export const budgetItemStatuses = ['planned', 'committed', 'settled', 'cancelled'] as const;
export const quoteStatuses = ['valid', 'expired', 'withdrawn'] as const;
export const purchaseIntentStatuses = ['proposed', 'confirmed', 'ordered', 'expired', 'rejected'] as const;
export const budgetPeriodStatuses = ['draft', 'active', 'closed'] as const;

export const offerQuote = z.object({
  quoteId: uuid,
  catalogItemId: uuid,
  provider: z.string().trim().min(2).max(80),
  quoteSource: z.enum(['demo', 'channel_api']),
  quoteVersion: version,
  priceMinor: orderableMinor,
  currency: z.literal('CNY'),
  serviceOn: date.nullable(),
  ruleVersion: version,
  ruleSnapshot: z.record(z.unknown()),
  validUntil: instant,
  status: z.enum(quoteStatuses),
}).strict();

export const budgetItemView = z.object({
  itemId: uuid,
  periodId: uuid,
  kind: z.enum(budgetItemKinds),
  title: z.string().min(1),
  categoryCode: z.string().nullable(),
  plannedOn: date,
  userEstimatedAmountMinor: positiveMinor,
  priority: z.enum(budgetItemPriorities),
  status: z.enum(budgetItemStatuses),
  itemVersion: version,
  linkedQuote: offerQuote.nullable(),
}).strict();

export const budgetPeriodCreateInput = z.object({
  accountId: uuid,
  monthStart: date,
  savingsTargetMinor: nonnegativeMinor,
  expectedFinancialVersion: version,
}).strict().refine((input) => input.monthStart.endsWith('-01'), {
  path: ['monthStart'], message: '预算周期必须从月初开始。',
});

export const savingsTargetChangeInput = z.object({
  newTargetMinor: nonnegativeMinor,
  expectedPeriodVersion: version,
  reason: z.string().trim().min(2).max(200),
  confirmedByUser: z.literal(true),
}).strict();

export const budgetItemChangeInput = z.object({
  periodId: uuid,
  itemId: uuid.nullable(),
  expectedPeriodVersion: version,
  kind: z.enum(budgetItemKinds),
  title: z.string().trim().min(1).max(120),
  categoryCode: z.string().trim().min(1).max(80).nullable(),
  plannedOn: date,
  userEstimatedAmountMinor: positiveMinor,
  priority: z.enum(budgetItemPriorities),
  changeReason: z.string().trim().min(2).max(200),
}).strict().refine((input) => input.kind !== 'essential_expense' || input.priority === 'required', {
  path: ['priority'], message: '必要支出必须标记为 required。',
});

export const budgetBasis = z.object({
  accountId: uuid,
  periodId: uuid,
  currency: z.literal('CNY'),
  financialVersion: version,
  periodVersion: version,
  basisSnapshotId: uuid.nullable(),
  asOf: instant.nullable(),
  confirmedCashMinor: nonnegativeMinor.nullable(),
  savingsTargetMinor: nonnegativeMinor,
  essentialRemainingMinor: nonnegativeMinor,
  adjustablePlannedMinor: nonnegativeMinor,
  committedOrdersMinor: nonnegativeMinor,
  expectedIncomeMinor: nonnegativeMinor,
  pendingRefundMinor: nonnegativeMinor,
  minimumProjectedCashMinor: z.number().int().safe().nullable(),
  minimumCashOn: date.nullable(),
  dataStatus: z.enum(['observed', 'incomplete', 'unknown']),
}).strict();

export const assessPurchaseInput = z.object({
  periodId: uuid,
  budgetItemId: uuid,
  quoteId: uuid,
  expectedFinancialVersion: version,
  expectedPeriodVersion: version,
  expectedQuoteVersion: version,
  mode: z.literal('preview'),
}).strict();

export const fundingAssessment = z.object({
  assessmentId: uuid,
  accountId: uuid,
  periodId: uuid,
  budgetItemId: uuid,
  quoteId: uuid,
  basisSnapshotId: uuid,
  financialVersion: version,
  periodVersion: version,
  quoteVersion: version,
  quotedAmountMinor: positiveMinor,
  replacedEstimateMinor: nonnegativeMinor,
  incrementalImpactMinor: z.number().int().safe(),
  status: z.enum(fundingStatuses),
  shortfallMinor: nonnegativeMinor,
  affectedDates: z.array(date),
  reasonCodes: z.array(z.string().trim().min(1).max(80)),
  expiresAt: instant,
}).strict().refine((result) => result.incrementalImpactMinor ===
  result.quotedAmountMinor - result.replacedEstimateMinor, {
  path: ['incrementalImpactMinor'], message: '报价影响只能是成交候选价与用户估价的差额。',
});

export const purchaseIntentCreateInput = z.object({
  periodId: uuid,
  budgetItemId: uuid,
  quoteId: uuid,
  assessmentId: uuid,
  expectedFinancialVersion: version,
  expectedPeriodVersion: version,
  expectedQuoteVersion: version,
}).strict();

export const purchaseIntentConfirmInput = z.object({
  acceptedAmountMinor: positiveMinor,
  expectedFinancialVersion: version,
  expectedPeriodVersion: version,
  expectedQuoteVersion: version,
  confirmedByUser: z.literal(true),
}).strict();

export const emergencyAssessInput = z.object({
  periodId: uuid,
  amountMinor: positiveMinor,
  plannedOn: date,
  reason: z.string().trim().min(2).max(200),
  expectedFinancialVersion: version,
  expectedPeriodVersion: version,
}).strict();

export const budgetAdjustmentConfirmInput = z.object({
  acceptedOptionId: uuid,
  expectedFinancialVersion: version,
  expectedPeriodVersion: version,
  confirmedByUser: z.literal(true),
}).strict();

export const planningDraftInput = z.object({
  periodId: uuid,
  goalText: z.string().trim().min(2).max(500),
  constraints: z.array(z.string().trim().min(1).max(200)).max(20),
  expectedFinancialVersion: version,
  expectedPeriodVersion: version,
}).strict();

export const verifiedMoneyEvent = z.object({
  orderId: uuid,
  provider: z.string().trim().min(2).max(80),
  providerEventId: z.string().trim().min(1).max(200),
  eventType: z.enum([
    'payment_pending', 'payment_posted', 'payment_failed',
    'refund_requested', 'refund_verified', 'refund_posted', 'result_unknown',
  ]),
  amountMinor: positiveMinor,
  currency: z.literal('CNY'),
  occurredAt: instant,
  verificationState: z.enum(['unverified', 'verified', 'unknown']),
  source: z.enum(['demo', 'bank_api']),
}).strict().refine((event) => !['payment_posted', 'refund_posted'].includes(event.eventType)
  || event.verificationState === 'verified', {
  path: ['verificationState'],
  message: '只有已核验事件才能记为支付或退款到账。',
});

export const consumerApiErrorCodes = [
  'UNAUTHENTICATED', 'RESOURCE_FORBIDDEN', 'VALIDATION_ERROR',
  'AMOUNT_OUT_OF_RANGE', 'IDEMPOTENCY_CONFLICT', 'VERSION_CONFLICT',
  'QUOTE_STALE', 'ITEM_NOT_ORDERABLE', 'INSUFFICIENT_FUNDS',
  'SAVINGS_TARGET_AT_RISK', 'FINANCE_BASIS_UNKNOWN',
  'PROVIDER_RESULT_UNKNOWN', 'CONFIRMATION_REQUIRED',
  'CONFIRMATION_SCOPE_MISMATCH',
] as const;

export const consumerApiError = z.object({
  error: z.object({
    code: z.enum(consumerApiErrorCodes),
    message: z.string().min(1),
    details: z.record(z.unknown()).optional(),
  }).strict(),
  correlationId: uuid,
}).strict();

export type BudgetPeriodCreateInput = z.infer<typeof budgetPeriodCreateInput>;
export type BudgetItemChangeInput = z.infer<typeof budgetItemChangeInput>;
export type BudgetBasis = z.infer<typeof budgetBasis>;
export type AssessPurchaseInput = z.infer<typeof assessPurchaseInput>;
export type FundingAssessment = z.infer<typeof fundingAssessment>;
export type PurchaseIntentCreateInput = z.infer<typeof purchaseIntentCreateInput>;
export type PurchaseIntentConfirmInput = z.infer<typeof purchaseIntentConfirmInput>;
export type VerifiedMoneyEvent = z.infer<typeof verifiedMoneyEvent>;
export type OfferQuote = z.infer<typeof offerQuote>;
export type BudgetItemView = z.infer<typeof budgetItemView>;
export type BudgetAdjustmentConfirmInput = z.infer<typeof budgetAdjustmentConfirmInput>;
