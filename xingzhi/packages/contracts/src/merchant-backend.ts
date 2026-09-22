import { z } from 'zod';

export const merchantDecisionInput = z.object({
  decision: z.enum(['approve', 'reject', 'delay']),
  reason: z.string().trim().min(2).max(200),
}).strict();
export const merchantTaskActionInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('claim') }).strict(),
  z.object({ action: z.literal('record_recheck'), note: z.string().trim().min(2).max(500) }).strict(),
]);
export const merchantOrderScope = z.enum(['legacy', 'consumer']);
const instant = z.coerce.date().transform(value => value.toISOString());
export const merchantOrderSummary = z.object({
  id: z.string().uuid(), scope: merchantOrderScope, planId: z.string().uuid().nullable(),
  budgetPeriodId: z.string().uuid().nullable(), itemName: z.string(),
  amountMinor: z.number().int(), refundedMinor: z.number().int(),
  paymentStatus: z.enum(['pending', 'paid', 'unknown', 'closed', 'failed']),
  status: z.string(), environment: z.enum(['simulation', 'sandbox']),
  consumer: z.string(), createdAt: instant,
});
export const merchantRefundBatch = z.object({
  id: z.string().uuid(), operationId: z.string().uuid().nullable(), businessNumber: z.string(),
  batchNumber: z.number().int(), amountMinor: z.number().int(), status: z.string(),
  environment: z.string(), provider: z.string(), createdAt: instant, updatedAt: instant,
});
export const merchantCancellation = z.object({
  id: z.string().uuid(), scope: merchantOrderScope, planId: z.string().uuid().nullable(),
  budgetPeriodId: z.string().uuid().nullable(), orderId: z.string().uuid(),
  itemName: z.string(), amountMinor: z.number().int(), paymentStatus: z.string(),
  orderStatus: z.string(), consumer: z.string(), acceptedFeeMinor: z.number().int(),
  acceptedRefundMinor: z.number().int(), ruleVersion: z.number().int(), rulePreset: z.string(),
  status: z.string(), decision: z.string().nullable(), decisionReason: z.string().nullable(),
  decidedAt: instant.nullable(), refundedMinor: z.number().int(), pendingRefundMinor: z.number().int(),
  batchCount: z.number().int(), createdAt: instant, updatedAt: instant,
});
export const merchantManualTask = z.object({
  id: z.string().uuid(), type: z.string(), state: z.string(), scope: merchantOrderScope,
  planId: z.string().uuid().nullable(), budgetPeriodId: z.string().uuid().nullable(),
  orderId: z.string().uuid().nullable(), cancellationRequestId: z.string().uuid().nullable(),
  refundBatchId: z.string().uuid().nullable(), operationId: z.string().uuid().nullable(),
  reason: z.string(), nextAction: z.string(), nextReviewAt: instant,
  claimedBy: z.string().uuid().nullable(), claimedAt: instant.nullable(), lastNote: z.string().nullable(),
  createdAt: instant, updatedAt: instant,
});
export const merchantOrderDetail = z.object({
  order: merchantOrderSummary,
  confirmation: z.object({
    purchaseIntentId: z.string().uuid().nullable(), confirmationId: z.string().uuid().nullable(),
    quoteId: z.string().uuid().nullable(), financialVersion: z.number().nullable(),
    periodVersion: z.number().nullable(), quoteVersion: z.number().nullable(),
    acceptedAmountMinor: z.number().nullable(), confirmedAt: instant.nullable(),
  }),
  payment: z.object({businessNumber: z.string(), status: z.string(),
    providerStatus: z.string().nullable(), updatedAt: instant}).nullable(),
  cancellations: z.array(merchantCancellation), refunds: z.array(merchantRefundBatch),
  operations: z.array(z.object({operationId: z.string().uuid(), type: z.string(), state: z.string(),
    attemptCount: z.number().int(), createdAt: instant, updatedAt: instant})),
  timeline: z.array(z.object({type: z.string(), referenceId: z.string(),
    status: z.string(), observedAt: instant})),
});
export type MerchantOrderSummary = z.output<typeof merchantOrderSummary>;
export type MerchantOrderDetail = z.output<typeof merchantOrderDetail>;
export type MerchantCancellation = z.output<typeof merchantCancellation>;
export type MerchantRefundBatch = z.output<typeof merchantRefundBatch>;
export type MerchantManualTask = z.output<typeof merchantManualTask>;
export type MerchantDecisionInput = z.infer<typeof merchantDecisionInput>;
export type MerchantTaskActionInput = z.infer<typeof merchantTaskActionInput>;
