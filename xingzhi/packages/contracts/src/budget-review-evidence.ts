import { z } from 'zod';

const instant = z.coerce.date().transform(value => value.toISOString());
const minor = z.number().int().nonnegative().safe();

export const budgetEvidenceExportInput = z.object({
  format: z.enum(['json', 'html']).default('json'),
}).strict();

// New reviewer DTOs deliberately exclude user identities, full bank identifiers,
// raw channel/model payloads and raw idempotency keys.
export const budgetReviewSummary = z.object({
  periodId: z.string().uuid(), monthStart: z.string(), monthEnd: z.string(),
  status: z.enum(['draft', 'active', 'closed']), periodVersion: z.number().int().positive().safe(),
  savingsTargetMinor: minor, accountSource: z.enum(['demo', 'bank_api']),
  accountStatus: z.enum(['linked', 'revoked']), updatedAt: instant,
});

export const budgetReviewOrder = z.object({
  orderId: z.string().uuid(), purchaseIntentId: z.string().uuid(), quoteId: z.string().uuid(),
  merchantAssignment: z.enum(['captured', 'unresolved']),
  amountMinor: minor, refundedMinor: minor, currency: z.literal('CNY'),
  environment: z.enum(['simulation', 'sandbox']), provider: z.enum(['simulation', 'alipay']),
  status: z.string(), paymentStatus: z.enum(['pending', 'paid', 'unknown', 'closed', 'failed']),
  confirmedAt: instant, financialVersion: z.number().int().positive().safe(),
  periodVersion: z.number().int().positive().safe(), quoteVersion: z.number().int().positive().safe(),
  createdAt: instant, updatedAt: instant,
});

export const budgetReviewEvent = z.object({
  referenceId: z.string(), type: z.string(), observedAt: instant,
  actorRole: z.enum(['consumer', 'merchant_admin', 'reviewer', 'system', 'unknown']),
  actorRef: z.string().nullable(), orderId: z.string().uuid().nullable(),
  operationId: z.string().uuid().nullable(), state: z.string().nullable(),
  amountMinor: minor.nullable(), source: z.string().nullable(),
});

export const budgetReviewEvidence = z.object({
  version: z.literal(1), generatedAt: instant, period: budgetReviewSummary,
  orders: z.array(budgetReviewOrder),
  // Explicit source facts; channel confirmation is distinct from ledger posting.
  moneyEvents: z.array(z.object({
    eventId: z.string().uuid(), orderId: z.string().uuid(), eventType: z.string(),
    amountMinor: minor, verificationState: z.enum(['unverified', 'verified', 'unknown']),
    source: z.enum(['demo', 'bank_api']), ledgerEntryId: z.string().uuid().nullable(), observedAt: instant,
  })),
  operations: z.array(z.object({
    operationId: z.string().uuid(), entityId: z.string().uuid(), type: z.string(), state: z.string(),
    attemptCount: z.number().int().nonnegative(), businessNumberRef: z.string().nullable(),
    idempotencyRecordRef: z.string().nullable(), createdAt: instant, updatedAt: instant,
  })),
  timeline: z.array(budgetReviewEvent), missingEvidence: z.array(z.string()),
});

export const budgetEvidenceExportView = z.object({
  exportId: z.string().uuid(), periodId: z.string().uuid(), format: z.enum(['json', 'html']),
  createdAt: instant, expiresAt: instant, downloadUrl: z.string(),
});

export type BudgetReviewSummary = z.output<typeof budgetReviewSummary>;
export type BudgetReviewOrder = z.output<typeof budgetReviewOrder>;
export type BudgetReviewEvidence = z.output<typeof budgetReviewEvidence>;
export type BudgetEvidenceExportInput = z.infer<typeof budgetEvidenceExportInput>;
export type BudgetEvidenceExportView = z.output<typeof budgetEvidenceExportView>;
