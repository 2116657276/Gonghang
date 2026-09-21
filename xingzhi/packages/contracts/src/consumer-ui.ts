import type {
  BudgetAdjustmentConfirmationView,
  BudgetAdjustmentOption,
  BudgetAdjustmentProposalView,
  BudgetItemChangeInput,
  BudgetItemView,
  BudgetPeriodReview,
  FundingAssessment,
  OfferQuote,
  OfferView,
  PlanningDraftView,
} from './consumer-backend.js';

/** Shared response envelope used by the new consumer API. */
export type ApiEnvelope<T> = { data: T; meta: Record<string, unknown> };

export type ConsumerSessionUser = {
  id: string; email: string; displayName: string;
  role: 'consumer' | 'merchant_admin' | 'reviewer';
};
export type ConsumerPreferences = {
  defaultAccountId: string | null;
  notifications: { planning: boolean; orders: boolean; refunds: boolean };
  updatedAt: string | null;
};
export type LedgerEntry = {
  entryId: string; direction: 'inflow' | 'outflow'; amountMinor: number;
  occurredAt: string; postedAt: string | null; status: 'pending' | 'posted' | 'reversed';
  displayCategory: string | null; category: string | null; orderId: string | null;
};
export type FinanceAccountFacts = {
  account: { accountId: string; provider: string; accountType: string; maskedIdentifier: string; displayName: string;
    currency: 'CNY'; source: string; status: 'linked' | 'revoked'; financialVersion: number };
  latestSnapshot: null | { asOf: string; availableBalanceMinor: number | null };
  cashBasis: { confirmedCashMinor: number | null; asOf: string | null; dataStatus: 'observed' | 'unknown'; reasonCodes: string[] };
  ledger: LedgerEntry[];
  obligations: { items: Array<{ id: string; label: string; dueOn: string; remainingDueMinor?: number | null;
    amountDueMinor: number | null; status: string }>; remainingDueMinor: number | null; dataStatus: string };
  displayOnly: { expectedIncomeMinor: number; pendingInflowMinor: number; pendingOutflowMinor: number; pendingRefundMinor: number };
};

export type BudgetItem = BudgetItemView;
export type BudgetItemInput = BudgetItemChangeInput;
export type BudgetPeriod = {
  period: { periodId: string; accountId: string; monthStart: string; monthEnd: string;
    status: 'draft' | 'active' | 'closed'; savingsTargetMinor: number; periodVersion: number };
  items: BudgetItem[];
  basis: { financialVersion: number; periodVersion: number; asOf?: string | null; confirmedCashMinor: number | null;
    savingsTargetMinor: number; essentialRemainingMinor: number; adjustablePlannedMinor: number; committedOrdersMinor: number;
    expectedIncomeMinor: number; pendingRefundMinor: number; minimumProjectedCashMinor: number | null;
    minimumCashOn: string | null; dataStatus: string };
  forecast: { status: 'allowed' | 'needs_adjustment' | 'blocked' | 'unknown'; shortfallMinor: number | null;
    affectedDates: string[]; reasonCodes: string[] };
};
export type AgentRun = { id: string; budgetPeriodId: string | null; state: string; output: string; errorCode: string | null;
  createdAt?: string; finishedAt?: string | null; artifacts: Array<{ type: 'planning_draft'; draftId: string }> };
export type AgentRunSummary = Pick<AgentRun, 'id' | 'budgetPeriodId' | 'state' | 'errorCode'> & {
  createdAt: string; finishedAt: string | null };
export type PlanningDraft = PlanningDraftView;
export type Offer = OfferView;
export type { FundingAssessment, OfferQuote };

export type PurchaseIntent = { purchaseIntentId: string; periodId: string; budgetItemId: string; quoteId: string;
  assessmentId: string; status: 'proposed' | 'confirmed' | 'ordered' | 'expired' | 'rejected'; acceptedAmountMinor: number | null;
  expiresAt: string; createdAt: string; itemTitle: string; plannedOn: string; userEstimatedAmountMinor: number;
  offerName: string; quotedAmountMinor: number; quoteVersion: number; financialVersion: number; periodVersion: number;
  orderId: string | null };
export type PurchaseIntentProposal = { purchaseIntentId: string; periodId: string; budgetItemId: string; status: 'proposed';
  expiresAt: string; funding: { financialVersion: number; periodVersion: number; status: 'allowed' } };
export type ConsumerOrder = { orderId: string; purchaseIntentId: string; budgetPeriodId: string; itemName: string;
  amountMinor: number; currency: 'CNY'; environment: 'simulation' | 'sandbox'; provider: 'simulation' | 'alipay';
  status: string; paymentStatus: 'pending' | 'paid' | 'unknown' | 'closed' | 'failed'; refundedMinor: number;
  createdAt: string; updatedAt: string; operationId?: string | null; operationState?: string | null;
  operations?: Array<{ operationId: string; operationState: string; operationType: string; purpose: string;
    createdAt: string; updatedAt: string }> };
export type OrderAftercare = {
  order: Pick<ConsumerOrder, 'orderId' | 'status' | 'paymentStatus' | 'amountMinor' | 'refundedMinor'>;
  previews: Array<{ previewId: string; action: 'close' | 'cancel'; status: string; feeMinor: number;
    refundMinor: number; expiresAt: string; confirmedAt: string | null; createdAt: string }>;
  cancellations: Array<{ requestId: string; status: string; decision: string | null; decisionReason: string | null;
    feeMinor: number; refundMinor: number; createdAt: string; updatedAt: string }>;
  batches: Array<{ batchId: string; operationId: string | null; batchNumber: number; amountMinor: number;
    status: string; environment: string; provider: string; createdAt: string; updatedAt: string }>;
  moneyEvents: Array<{ eventId: string; eventType: string; amountMinor: number; verificationState: string;
    occurredAt: string; source: string }>;
};
export type AftercarePreview = { previewId: string; orderId: string; action: 'close' | 'cancel'; orderStatus: string;
  paymentStatus: string; ruleVersion: number; feeMinor: number; expectedRefundMinor: number; expiresAt: string; status: 'proposed' };
export type AftercareConfirmation = { orderId: string; operationId: string | null; operationIds: string[];
  state: 'accepted'; action: 'close' | 'cancel'; reused: boolean };
export type PaymentHandoff = { orderId: string; operationId: string; environment: 'simulation' | 'sandbox';
  provider: 'simulation' | 'alipay'; paymentStatus: string; requiresUserAction: boolean; reused: boolean;
  handoffUrl?: string; expiresAt?: string };
export type PaymentRecheck = { orderId: string; operationId?: string | null; environment: 'sandbox'; paymentStatus: string;
  providerStatus?: string; source: string; observedAt?: string; retryAfterSeconds?: number };
export type PaymentReadiness = { mode: 'simulation' | 'sandbox'; ready: boolean; missing: string[] };
export type RuntimeStatus = { version: string; environment: string;
  payment: { mode: 'simulation' | 'sandbox'; ready: boolean; missingCount: number }; ai: { ready: boolean };
  worker: { status: 'healthy' | 'delayed' | 'offline'; lastSeenAt: string | null; ageSeconds: number | null };
  dataSource: { types: string[]; latestSyncAt: string | null } | null };
export type Operation = { id?: string; operationId?: string; type: string; state: string; purpose?: string;
  result?: Record<string, unknown> | null; createdAt?: string; updatedAt?: string };
export type PeriodEvent = { id: string; type: string; data: Record<string, unknown>; observedAt: string };
export type AdjustmentOption = BudgetAdjustmentOption;
export type Adjustment = BudgetAdjustmentProposalView;
export type AdjustmentConfirmation = BudgetAdjustmentConfirmationView;
export type AdjustmentDetail = { adjustmentId: string; periodId: string; status: string; reason: string;
  proposedChanges: { emergency: Adjustment['emergency']; baseline: AdjustmentOption['assessment']; options: AdjustmentOption[] };
  expiresAt: string; confirmedAt: string | null;
  cancellations: Array<{ cancellationRequestId: string; orderId: string; status: string; decision: string | null;
    decisionReason: string | null; acceptedFeeMinor: number; acceptedRefundMinor: number; channelRefundSucceededMinor: number }> };
export type PeriodReview = BudgetPeriodReview;
