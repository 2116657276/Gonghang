import { z } from 'zod';

export const roles = ['consumer', 'merchant_admin', 'reviewer'] as const;
export type Role = (typeof roles)[number];

export const planItemKinds = ['transport', 'stay', 'activity', 'unbooked'] as const;
export type PlanItemKind = (typeof planItemKinds)[number];

const uniqueUuidArray = (minimum = 0) => z.array(z.string().uuid()).min(minimum).refine(
  (values) => new Set(values).size === values.length,
  { message: '标识不能重复。' },
);

export const purchaseProposalInput = z.object({
  itemIds: uniqueUuidArray(1),
});

export const purchaseConfirmationInput = z.object({
  expectedVersion: z.number().int().positive(),
  acceptedItemIds: uniqueUuidArray(1),
  purchaseLimitMinor: z.number().int().positive().max(1_000_000),
  restoreItemIds: uniqueUuidArray().default([]),
});

export const createPlanInput = z.object({
  purpose: z.string().trim().min(2).max(120),
  itemIds: uniqueUuidArray(1),
});

export const createOrderInput = z.object({
  confirmationId: z.string().uuid(),
  planItemId: z.string().uuid(),
});

export const pausePlanInput = z.object({
  expectedVersion: z.number().int().positive(),
  itemIds: uniqueUuidArray().default([]),
  reason: z.string().trim().min(2).max(200),
});

export const changeIntent = z.enum(['keep', 'stop', 'close', 'cancel']);
export const changeProposalInput = z.object({
  items: z.array(z.object({
    planItemId: z.string().uuid(),
    intent: changeIntent,
  })).min(1).superRefine((items, context) => {
    const seen = new Set<string>();
    items.forEach((item, index) => {
      if (seen.has(item.planItemId)) context.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'planItemId'], message: '计划项不能重复。' });
      seen.add(item.planItemId);
    });
  }),
});

export const changeConfirmationInput = z.object({
  expectedVersion: z.number().int().positive(),
  acceptedFeeMinor: z.number().int().min(0),
  acceptedRefundMinor: z.number().int().min(0),
  aftercareOrderIds: uniqueUuidArray().default([]),
  queryOrderIds: uniqueUuidArray().default([]),
});

export const loginInput = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});

export type PlanSnapshot = {
  id: string;
  purpose: string;
  version: number;
  purchaseLimitMinor: number;
  pausedItemIds: string[];
  items: Array<{
    id: string;
    catalogItemId: string | null;
    name: string;
    kind: PlanItemKind;
    priceMinor: number;
    status: string;
    hasOrder: boolean;
  }>;
  orders: Array<{
    id: string;
    planItemId: string;
    itemName: string;
    amountMinor: number;
    refundedMinor: number;
    status: string;
    paymentStatus: string;
    simulationMode: string;
    environment: 'simulation' | 'sandbox';
    provider: 'simulation' | 'alipay';
  }>;
  authorizations: Array<{
    id: string;
    type: 'purchase' | 'aftercare' | 'query';
    status: string;
    orderIds: string[];
    expiresAt: string;
  }>;
  cancellations: Array<{
    id: string;
    orderId: string;
    status: string;
    decision: string | null;
    decisionReason: string | null;
    acceptedFeeMinor: number;
    acceptedRefundMinor: number;
    refundedMinor: number;
    pendingRefundMinor: number;
    updatedAt: string;
    batches: Array<{
      id: string;
      operationId: string | null;
      batchNumber: number;
      amountMinor: number;
      status: string;
      updatedAt: string;
    }>;
    manualTasks: Array<{
      id: string;
      type: string;
      state: string;
      reason: string;
      nextAction: string;
      nextReviewAt: string;
    }>;
  }>;
  budget: {
    limitMinor: number;
    paidMinor: number;
    reservedMinor: number;
    remainingMinor: number;
  };
  pending: string[];
};
