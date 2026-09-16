import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AppError } from './errors.js';

export const cancellationRules = ['full_refund', 'fee_80', 'two_batches', 'reject', 'delay'] as const;
export type CancellationRule = (typeof cancellationRules)[number];

export function cancellationRuleDetails(rule: CancellationRule, amountMinor: number) {
  if (amountMinor <= 0) throw new AppError(422, 'CANCELLATION_RULE_INVALID', '取消规则只能用于正金额订单。');
  if ((rule === 'fee_80' || rule === 'two_batches') && amountMinor <= 8_000) {
    throw new AppError(422, 'CANCELLATION_RULE_INVALID', '订单金额不足以适用 80 元费用规则。');
  }
  if (rule === 'full_refund') return { feeMinor: 0, label: '全额退款（本地测试规则）', batchCount: 1 };
  if (rule === 'fee_80') return { feeMinor: 8_000, label: '收取 80 元费用（本地测试规则）', batchCount: 1 };
  if (rule === 'two_batches') return { feeMinor: 8_000, label: '收取 80 元费用，分两批退款（本地测试规则）', batchCount: 2 };
  if (rule === 'reject') return { feeMinor: amountMinor, label: '拒绝取消退款（本地测试规则）', batchCount: 0 };
  return { feeMinor: 0, label: '延迟处理，等待商户复核（本地测试规则）', batchCount: 1 };
}

export function initialDecisionForRule(rule: CancellationRule) {
  if (rule === 'reject') return 'reject' as const;
  if (rule === 'delay') return 'delay' as const;
  return 'approve' as const;
}

type ManualTaskInput = {
  dedupeKey: string;
  planId?: string;
  merchantId?: string;
  budgetPeriodId?: string;
  responsibleProvider?: string;
  orderId?: string;
  cancellationRequestId?: string;
  refundBatchId?: string;
  operationId?: string;
  type: 'cancellation_follow_up' | 'refund_recheck' | 'operation_recheck';
  reason: string;
  nextAction: string;
  nextReviewAt?: Date;
};

export async function ensureManualTask(client: PoolClient, input: ManualTaskInput) {
  const legacy = Boolean(input.planId && input.merchantId);
  const consumer = Boolean(input.budgetPeriodId && input.responsibleProvider);
  if (legacy === consumer) throw new Error('人工任务必须且只能绑定旧计划或新预算周期。');
  const result = await client.query<{ id: string; state: string }>(`
    INSERT INTO manual_tasks (
      id, dedupe_key, plan_id, merchant_id,budget_period_id,responsible_provider,
      order_id, cancellation_request_id, refund_batch_id, operation_id,
      type, reason, next_action, next_review_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT (dedupe_key) DO UPDATE SET updated_at = now()
    RETURNING id, state
  `, [
    randomUUID(), input.dedupeKey, input.planId ?? null, input.merchantId ?? null,
    input.budgetPeriodId ?? null, input.responsibleProvider ?? null, input.orderId ?? null,
    input.cancellationRequestId ?? null, input.refundBatchId ?? null, input.operationId ?? null,
    input.type, input.reason, input.nextAction,
    input.nextReviewAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000),
  ]);
  return result.rows[0]!;
}
