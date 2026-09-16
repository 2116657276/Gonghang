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

export const financeAccountRevocationInput = z.object({
  expectedStatus: z.literal('linked'),
}).strict();
export type FinanceAccountRevocationInput = z.infer<typeof financeAccountRevocationInput>;

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

export const budgetPeriodActivationInput = z.object({
  expectedFinancialVersion: version,
  expectedPeriodVersion: version,
  confirmedNecessities: z.literal(true),
}).strict();
export type BudgetPeriodActivationInput = z.infer<typeof budgetPeriodActivationInput>;

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

export const purchaseIntentView = z.object({
  purchaseIntentId: uuid,
  periodId: uuid,
  budgetItemId: uuid,
  quoteId: uuid,
  assessmentId: uuid,
  status: z.literal('proposed'),
  item: z.object({
    title: z.string().min(1),
    plannedOn: date,
    userEstimatedAmountMinor: nonnegativeMinor,
  }).strict(),
  offer: z.object({
    catalogItemId: uuid,
    name: z.string().min(1),
    provider: z.string().trim().min(2).max(80),
    quoteSource: z.enum(['demo', 'channel_api']),
    quotedAmountMinor: positiveMinor,
    currency: z.literal('CNY'),
    quoteVersion: version,
    ruleVersion: version,
    ruleLabel: z.string().min(1),
    ruleSnapshot: z.record(z.unknown()),
  }).strict(),
  funding: z.object({
    status: z.literal('allowed'),
    financialVersion: version,
    periodVersion: version,
    incrementalImpactMinor: z.number().int().safe(),
    shortfallMinor: nonnegativeMinor,
    affectedDates: z.array(date),
    reasonCodes: z.array(z.string().trim().min(1).max(80)),
  }).strict(),
  confirmationRequired: z.literal(true),
  expiresAt: instant,
  createdAt: instant,
}).strict();

export const consumerOrderView = z.object({
  orderId: uuid,
  purchaseIntentId: uuid,
  budgetPeriodId: uuid,
  itemName: z.string().min(1),
  amountMinor: positiveMinor,
  currency: z.literal('CNY'),
  environment: z.enum(['simulation', 'sandbox']),
  provider: z.enum(['simulation', 'alipay']),
  status: z.enum(['created', 'fulfilling', 'cancellation_processing', 'fulfilled', 'cancelled', 'cancellation_rejected']),
  paymentStatus: z.enum(['pending', 'paid', 'unknown', 'closed', 'failed']),
  refundedMinor: nonnegativeMinor,
  createdAt: instant,
  updatedAt: instant,
}).strict();

export const purchaseIntentConfirmationView = z.object({
  purchaseIntentId: uuid,
  status: z.literal('ordered'),
  order: consumerOrderView,
  financialVersion: version,
  periodVersion: version,
  paymentHandoffRequired: z.literal(true),
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

export const budgetAdjustmentAssessment = z.object({
  status: z.enum(fundingStatuses),
  shortfallMinor: nonnegativeMinor.nullable(),
  affectedDates: z.array(date),
  reasonCodes: z.array(z.string().trim().min(1).max(80)),
}).strict();

export const budgetAdjustmentOption = z.object({
  optionId: uuid,
  label: z.string().trim().min(1).max(200),
  changes: z.array(z.discriminatedUnion('action', [
    z.object({ budgetItemId: uuid, action: z.literal('cancel') }).strict(),
    z.object({
      budgetItemId: uuid,
      orderId: uuid,
      action: z.literal('cancel_order'),
      ruleVersion: version,
      cancellationRule: z.enum(['full_refund', 'fee_80', 'two_batches', 'reject', 'delay']),
      feeMinor: nonnegativeMinor,
      refundableMinor: nonnegativeMinor,
    }).strict(),
  ])),
  assessment: budgetAdjustmentAssessment,
}).strict();

export const budgetAdjustmentProposalView = z.object({
  adjustmentId: uuid,
  periodId: uuid,
  status: z.literal('proposed'),
  basisFinancialVersion: version,
  basisPeriodVersion: version,
  emergency: z.object({
    amountMinor: positiveMinor,
    plannedOn: date,
    reason: z.string().trim().min(2).max(200),
  }).strict(),
  baseline: budgetAdjustmentAssessment,
  options: z.array(budgetAdjustmentOption).min(1),
  expiresAt: instant,
}).strict();

export const budgetAdjustmentConfirmationView = z.object({
  adjustmentId: uuid,
  status: z.enum(['executing', 'complete', 'pending_review']),
  acceptedOptionId: uuid,
  emergencyItem: budgetItemView,
  cancelledItemIds: z.array(uuid),
  cancellationRequestIds: z.array(uuid),
  financialVersion: version,
  periodVersion: version,
}).strict();

export const planningDraftSuggestion = z.object({
  title: z.string().trim().min(1).max(120).nullable(),
  plannedOn: date.nullable(),
  estimatedAmountMinor: positiveMinor.nullable(),
  priority: z.enum(budgetItemPriorities).nullable(),
  catalogItemId: uuid.nullable(),
  reason: z.string().trim().min(2).max(300),
}).strict();

export const planningDraftItem = z.object({
  title: z.string().trim().min(1).max(120),
  plannedOn: date.nullable(),
  userEstimatedAmountMinor: positiveMinor.nullable(),
  priority: z.enum(budgetItemPriorities).nullable(),
  requirements: z.array(z.string().trim().min(1).max(200)).max(20),
  catalogItemId: uuid.nullable(),
  suggestion: planningDraftSuggestion.nullable(),
}).strict();

export const planningDraftInput = z.object({
  periodId: uuid.nullable(),
  expectedFinancialVersion: version.nullable(),
  expectedPeriodVersion: version.nullable(),
  items: z.array(planningDraftItem).min(1).max(20),
}).strict().superRefine((input, context) => {
  const empty = input.periodId === null
    && input.expectedFinancialVersion === null
    && input.expectedPeriodVersion === null;
  const complete = input.periodId !== null
    && input.expectedFinancialVersion !== null
    && input.expectedPeriodVersion !== null;
  if (!empty && !complete) context.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['periodId'],
    message: '周期和两个依据版本必须同时为空或同时提供。',
  });
});

export const planningDraftAssessment = z.object({
  status: z.enum(fundingStatuses),
  shortfallMinor: nonnegativeMinor.nullable(),
  affectedDates: z.array(date),
  reasonCodes: z.array(z.string().trim().min(1).max(80)),
}).strict().refine((assessment) => assessment.shortfallMinor !== null || assessment.status === 'unknown', {
  path: ['shortfallMinor'], message: '只有未知评估可以没有明确缺口金额。',
});

export const planningDraftView = z.object({
  draftId: uuid,
  periodId: uuid.nullable(),
  status: z.enum(['draft', 'accepted', 'discarded', 'stale']),
  basisFinancialVersion: version.nullable(),
  basisPeriodVersion: version.nullable(),
  items: z.array(planningDraftItem).min(1).max(20),
  missingFields: z.array(z.string().trim().min(1).max(120)).max(60),
  assessment: planningDraftAssessment.nullable(),
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

export const budgetPeriodReview = z.object({
  periodId: uuid,
  accountId: uuid,
  accountSource: z.enum(['demo', 'bank_api']),
  periodStatus: z.enum(budgetPeriodStatuses),
  monthStart: date,
  monthEnd: date,
  timezone: z.literal('Asia/Shanghai'),
  originalSavingsTargetMinor: nonnegativeMinor,
  currentSavingsTargetMinor: nonnegativeMinor,
  targetChangeCount: z.number().int().nonnegative().safe(),
  confirmedPeriodOutflowMinor: nonnegativeMinor,
  confirmedPeriodInflowMinor: nonnegativeMinor,
  classifiedUnexpectedExpenseMinor: nonnegativeMinor,
  confirmedOrderPaymentsMinor: nonnegativeMinor,
  confirmedRefundReceivedMinor: nonnegativeMinor,
  refundRequestedMinor: nonnegativeMinor,
  refundChannelVerifiedMinor: nonnegativeMinor,
  channelRefundSucceededMinor: nonnegativeMinor,
  refundAwaitingArrivalMinor: nonnegativeMinor,
  currentConfirmedCashMinor: nonnegativeMinor.nullable(),
  currentCashAsOf: instant.nullable(),
  periodEndUnspentCashMinor: nonnegativeMinor.nullable(),
  periodEndTargetGapMinor: nonnegativeMinor.nullable(),
  reviewStatus: z.enum(['provisional', 'complete', 'unknown']),
  unknownIssues: z.array(z.string().trim().min(1).max(80)),
}).strict();

export const consumerApiErrorCodes = [
  'UNAUTHENTICATED', 'RESOURCE_FORBIDDEN', 'VALIDATION_ERROR', 'FINANCE_SCOPE_REVOKED',
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
export type PurchaseIntentView = z.infer<typeof purchaseIntentView>;
export type ConsumerOrderView = z.infer<typeof consumerOrderView>;
export type PurchaseIntentConfirmationView = z.infer<typeof purchaseIntentConfirmationView>;
export type VerifiedMoneyEvent = z.infer<typeof verifiedMoneyEvent>;
export type BudgetPeriodReview = z.infer<typeof budgetPeriodReview>;
export type OfferQuote = z.infer<typeof offerQuote>;
export type BudgetItemView = z.infer<typeof budgetItemView>;
export type BudgetAdjustmentConfirmInput = z.infer<typeof budgetAdjustmentConfirmInput>;
export type BudgetAdjustmentOption = z.infer<typeof budgetAdjustmentOption>;
export type BudgetAdjustmentProposalView = z.infer<typeof budgetAdjustmentProposalView>;
export type BudgetAdjustmentConfirmationView = z.infer<typeof budgetAdjustmentConfirmationView>;
export type PlanningDraftInput = z.infer<typeof planningDraftInput>;
export type PlanningDraftItem = z.infer<typeof planningDraftItem>;
export type PlanningDraftAssessment = z.infer<typeof planningDraftAssessment>;
export type PlanningDraftView = z.infer<typeof planningDraftView>;

export const budgetItemCancelInput = z.object({
  periodId: uuid,
  itemId: uuid,
  expectedPeriodVersion: version,
  reason: z.string().trim().min(2).max(200),
}).strict();
export type BudgetItemCancelInput = z.infer<typeof budgetItemCancelInput>;
export type BudgetItemMutationResult = { item: BudgetItemView; basis: BudgetBasis };

export const offerSearchInput = z.object({
  plannedOn: date,
  categoryCode: z.string().trim().min(1).max(80).optional(),
}).strict();
export const offerView = z.object({
  id: uuid, code: z.string(), name: z.string(), description: z.string(),
  categoryCode: z.string().nullable(), locationLabel: z.string().nullable(),
  tags: z.array(z.string()), purchaseMode: z.enum(['listing', 'orderable']),
  displayPriceMinor: nonnegativeMinor, currency: z.literal('CNY'),
  ruleLabel: z.string(),
}).strict();
export type OfferView = z.infer<typeof offerView>;
