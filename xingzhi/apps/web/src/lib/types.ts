export type Role = 'consumer' | 'merchant_admin' | 'reviewer';

export type User = { id: string; email: string; displayName: string; role: Role };

export type CatalogItem = {
  id: string;
  code: string;
  name: string;
  kind: string;
  description: string;
  priceMinor: number;
  ruleLabel: string;
  cancellationFeeMinor: number;
  simulationMode: 'SUCCESS' | 'PENDING' | 'UNKNOWN';
};

export type Plan = {
  id: string;
  purpose: string;
  version: number;
  purchaseLimitMinor: number;
  pausedItemIds: string[];
  items: Array<{ id: string; catalogItemId: string | null; name: string; kind: string; priceMinor: number; status: string; hasOrder: boolean }>;
  orders: Array<{ id: string; planItemId: string; itemName: string; amountMinor: number; refundedMinor: number; status: string; paymentStatus: string; simulationMode: string; environment: 'simulation' | 'sandbox'; provider: 'simulation' | 'alipay' }>;
  authorizations: Array<{ id: string; type: 'purchase' | 'aftercare' | 'query'; status: string; orderIds: string[]; expiresAt: string }>;
  cancellations: Array<{
    id: string; orderId: string; status: string; decision: string | null; decisionReason: string | null;
    acceptedFeeMinor: number; acceptedRefundMinor: number; refundedMinor: number; pendingRefundMinor: number; updatedAt: string;
    batches: Array<{ id: string; operationId: string | null; batchNumber: number; amountMinor: number; status: string; updatedAt: string }>;
    manualTasks: Array<{ id: string; type: string; state: string; reason: string; nextAction: string; nextReviewAt: string }>;
  }>;
  budget: { limitMinor: number; paidMinor: number; reservedMinor: number; remainingMinor: number };
  pending: string[];
};

export type PurchaseProposal = {
  proposalId: string;
  version: number;
  expiresAt: string;
  items: Array<{ planItemId: string; catalogItemId: string; name: string; priceMinor: number }>;
  totalMinor: number;
};

export type ChangeProposal = {
  proposalId: string;
  version: number;
  expiresAt: string;
  items: Array<{ planItemId: string; name: string; intent: string; orderId: string | null; paymentStatus: string | null; feeMinor: number; refundMinor: number }>;
  totalFeeMinor: number;
  totalRefundMinor: number;
};

export type AgentProposal = ((PurchaseProposal & {type:'purchase'}) | (ChangeProposal & {type:'change'})) & {
  status: string; confirmable: boolean; confirmationId: string | null;
};
export type AgentRun = {
  id: string; plan_id: string; state: 'RUNNING'|'WAITING_USER'|'WAITING_EXTERNAL'|'COMPLETED'|'FAILED'|'CANCELLED';
  output: string; error_code: string | null; proposal: AgentProposal | null;
  followupRootId: string;
  pendingFollowups: number;
  followupFailed: boolean;
  actions?:Array<{toolName:string;result:{message?:string;orderId?:string;environment?:string;requiresUserAction?:boolean;pausedItemIds?:string[];operationIds?:string[]}}>;
  parent_run_id?:string|null;
};

export type EventItem = { id: number; type: string; data: Record<string, unknown>; observedAt: string };

export type EvidenceExport = {
  exportId: string;
  planId: string;
  format: 'json' | 'html';
  sections: string[];
  createdAt: string;
  expiresAt: string;
  downloadUrl: string;
};

export type PaymentHandoff = {
  orderId: string;
  provider: 'alipay';
  handoffUrl: string;
  expiresAt: string;
  environment: 'sandbox';
};

export type MerchantCatalogItem = {
  id: string; code: string; name: string; priceMinor: number; rule: string; ruleLabel: string;
  ruleVersion: number; cancellationFeeMinor: number; active: boolean;
};

export type MerchantCancellation = {
  id: string; planId: string; orderId: string; itemName: string; amountMinor: number; paymentStatus: string; orderStatus: string;
  consumer: string; acceptedFeeMinor: number; acceptedRefundMinor: number; ruleVersion: number; rulePreset: string;
  status: string; decision: string | null; decisionReason: string | null; decidedAt: string | null;
  refundedMinor: number; pendingRefundMinor: number; batchCount: number; createdAt: string; updatedAt: string;
};

export type RefundBatch = {
  id: string; operationId: string | null; businessNumber: string; batchNumber: number; amountMinor: number;
  status: string; environment: string; provider: string; createdAt: string; updatedAt: string;
};

export type ManualTask = {
  id: string; type: string; state: string; planId: string; orderId: string | null; cancellationRequestId: string | null;
  refundBatchId: string | null; operationId: string | null; reason: string; nextAction: string; nextReviewAt: string;
  claimedBy: string | null; claimedAt: string | null; lastNote: string | null; createdAt: string; updatedAt: string;
};

export type OperationRecheck = {
  operationId: string; status: string; recheckOperationId?: string; manualTaskId?: string; reused?: boolean;
};
