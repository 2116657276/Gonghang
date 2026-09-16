import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  budgetAdjustmentConfirmationView,
  budgetAdjustmentProposalView,
  type BudgetAdjustmentConfirmInput,
  type BudgetAdjustmentOption,
  type BudgetAdjustmentProposalView,
} from '@xingzhi/contracts';
import { applyBudgetItemChange, cancelBudgetItem } from './budget-periods.js';
import { cancellationRuleDetails, initialDecisionForRule, type CancellationRule,
  ensureManualTask } from './aftercare.js';
import { AppError } from './errors.js';
import { createOperationJob } from './jobs.js';
import { assessAdjustmentOption, assessUnexpectedSpend } from './purchase-assessment.js';
import { applyVerifiedMoneyEvent } from './verified-money-event.js';

type EmergencyInput = {
  periodId: string;
  amountMinor: number;
  plannedOn: string;
  reason: string;
  expectedFinancialVersion: number;
  expectedPeriodVersion: number;
};

function assessment(result: Awaited<ReturnType<typeof assessUnexpectedSpend>>) {
  return {
    status: result.forecast.status,
    shortfallMinor: result.forecast.shortfallMinor,
    affectedDates: result.forecast.affectedDates,
    reasonCodes: result.forecast.reasonCodes,
  };
}

function requireAllowed(status: string, details: Record<string, unknown>): void {
  if (status === 'allowed') return;
  const code = status === 'blocked' ? 'INSUFFICIENT_FUNDS'
    : status === 'needs_adjustment' ? 'SAVINGS_TARGET_AT_RISK' : 'FINANCE_BASIS_UNKNOWN';
  throw new AppError(409, code, '所选调整方案已不能满足当前资金约束，请重新评估。', details);
}

export async function createBudgetAdjustment(
  client: PoolClient,
  ownerId: string,
  input: EmergencyInput,
): Promise<BudgetAdjustmentProposalView> {
  const baselineResult = await assessUnexpectedSpend(client, ownerId, input.periodId, {
    amountMinor: input.amountMinor,
    spendOn: input.plannedOn,
    expectedFinancialVersion: input.expectedFinancialVersion,
    expectedPeriodVersion: input.expectedPeriodVersion,
  });
  const candidates = (await client.query<{ id: string; title: string }>(`SELECT i.id,i.title
    FROM budget_items i WHERE i.owner_id=$1 AND i.period_id=$2
      AND i.kind='planned_spend' AND i.priority='adjustable' AND i.status='planned'
      AND NOT EXISTS (SELECT 1 FROM purchase_intents intent
        WHERE intent.owner_id=i.owner_id AND intent.budget_item_id=i.id
          AND intent.status IN ('proposed','confirmed','ordered'))
    ORDER BY i.user_estimated_amount_minor DESC,i.id`, [ownerId, input.periodId])).rows;
  const paidOrders = (await client.query<{
    orderId: string;
    budgetItemId: string;
    itemName: string;
    amountMinor: number;
    ruleVersion: number;
    cancellationRule: CancellationRule;
  }>(`SELECT o.id AS "orderId",i.budget_item_id AS "budgetItemId",o.item_name AS "itemName",
      o.amount_minor AS "amountMinor",c.rule_version AS "ruleVersion",
      c.cancellation_rule AS "cancellationRule"
    FROM orders o JOIN purchase_intents i ON i.id=o.purchase_intent_id
    JOIN offer_quotes q ON q.id=i.quote_id JOIN catalog_items c ON c.id=q.catalog_item_id
    WHERE o.owner_id=$1 AND o.budget_period_id=$2 AND o.payment_status='paid'
      AND o.refunded_minor=0 AND o.status NOT IN ('cancellation_processing','cancelled')
      AND NOT EXISTS (SELECT 1 FROM cancellation_requests request
        WHERE request.order_id=o.id AND request.status IN
          ('submitted','approved','delayed','refund_processing','pending_review'))
    ORDER BY o.created_at,o.id`, [ownerId, input.periodId])).rows;
  const optionChanges: Array<{ label: string; changes: BudgetAdjustmentOption['changes'] }> = [
    { label: '保留当前计划并加入这笔必要支出', changes: [] },
    ...candidates.map((item) => ({ label: `取消“${item.title}”并加入这笔必要支出`,
      changes: [{ budgetItemId: item.id, action: 'cancel' as const }] })),
  ];
  if (candidates.length > 1) optionChanges.push({
    label: '取消全部尚未承诺的可调项目并加入这笔必要支出',
    changes: candidates.map((item) => ({ budgetItemId: item.id, action: 'cancel' as const })),
  });
  for (const order of paidOrders) {
    const rule = cancellationRuleDetails(order.cancellationRule, order.amountMinor);
    optionChanges.push({
      label: `申请取消“${order.itemName}”（预计退款不计入当前可用资金）`,
      changes: [{ budgetItemId: order.budgetItemId, orderId: order.orderId,
        action: 'cancel_order' as const, ruleVersion: order.ruleVersion,
        cancellationRule: order.cancellationRule, feeMinor: rule.feeMinor,
        refundableMinor: order.amountMinor - rule.feeMinor }],
    });
  }
  const options: BudgetAdjustmentOption[] = [];
  for (const option of optionChanges) {
    const result = await assessAdjustmentOption(client, ownerId, input.periodId, {
      changes: option.changes.filter((change) => change.action === 'cancel'),
      unexpectedSpend: { amountMinor: input.amountMinor, spendOn: input.plannedOn },
      expectedFinancialVersion: input.expectedFinancialVersion,
      expectedPeriodVersion: input.expectedPeriodVersion,
    });
    options.push({ optionId: randomUUID(), label: option.label,
      changes: option.changes, assessment: assessment(result) });
  }
  const adjustmentId = randomUUID();
  const expiresAt = new Date(Date.now() + 15 * 60_000);
  const result = budgetAdjustmentProposalView.parse({
    adjustmentId,
    periodId: input.periodId,
    status: 'proposed',
    basisFinancialVersion: input.expectedFinancialVersion,
    basisPeriodVersion: input.expectedPeriodVersion,
    emergency: { amountMinor: input.amountMinor, plannedOn: input.plannedOn, reason: input.reason },
    baseline: assessment(baselineResult),
    options,
    expiresAt: expiresAt.toISOString(),
  });
  await client.query(`INSERT INTO budget_adjustment_proposals
      (id,owner_id,period_id,basis_financial_version,basis_period_version,reason,
        proposed_changes,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [adjustmentId, ownerId, input.periodId,
    input.expectedFinancialVersion, input.expectedPeriodVersion, input.reason,
    { emergency: result.emergency, baseline: result.baseline, options: result.options }, expiresAt]);
  await client.query(`INSERT INTO budget_events (owner_id,period_id,actor_id,type,data)
    VALUES($1,$2,$1,'budget_adjustment_proposed',$3)`, [ownerId, input.periodId,
    { adjustmentId, amountMinor: input.amountMinor, plannedOn: input.plannedOn,
      baselineStatus: result.baseline.status, optionCount: result.options.length }]);
  return result;
}

export async function confirmBudgetAdjustment(
  client: PoolClient,
  ownerId: string,
  adjustmentId: string,
  input: BudgetAdjustmentConfirmInput,
) {
  const row = (await client.query<{
    periodId: string;
    financialVersion: string;
    periodVersion: string;
    status: string;
    expiresAt: Date;
    proposedChanges: { emergency: BudgetAdjustmentProposalView['emergency'];
      options: BudgetAdjustmentOption[] };
  }>(`SELECT period_id AS "periodId",basis_financial_version AS "financialVersion",
      basis_period_version AS "periodVersion",status,expires_at AS "expiresAt",
      proposed_changes AS "proposedChanges"
    FROM budget_adjustment_proposals WHERE id=$1 AND owner_id=$2 FOR UPDATE`,
  [adjustmentId, ownerId])).rows[0];
  if (!row) throw new AppError(404, 'RESOURCE_FORBIDDEN', '未找到本人的调整方案。');
  if (row.status !== 'proposed' || row.expiresAt <= new Date()) {
    throw new AppError(409, 'VERSION_CONFLICT', '调整方案已处理或过期，请重新评估。');
  }
  if (Number(row.financialVersion) !== input.expectedFinancialVersion
    || Number(row.periodVersion) !== input.expectedPeriodVersion) {
    throw new AppError(409, 'VERSION_CONFLICT', '确认版本与调整方案依据不一致。');
  }
  const option = row.proposedChanges.options.find((item) => item.optionId === input.acceptedOptionId);
  if (!option) throw new AppError(409, 'CONFIRMATION_SCOPE_MISMATCH', '所选方案不属于当前调整建议。');
  const checked = await assessAdjustmentOption(client, ownerId, row.periodId, {
    changes: option.changes.filter((change) => change.action === 'cancel'),
    unexpectedSpend: { amountMinor: row.proposedChanges.emergency.amountMinor,
      spendOn: row.proposedChanges.emergency.plannedOn },
    expectedFinancialVersion: input.expectedFinancialVersion,
    expectedPeriodVersion: input.expectedPeriodVersion,
  });
  requireAllowed(checked.forecast.status, { status: checked.forecast.status,
    shortfallMinor: checked.forecast.shortfallMinor,
    affectedDates: checked.forecast.affectedDates, reasonCodes: checked.forecast.reasonCodes });
  await client.query(`UPDATE budget_adjustment_proposals SET status='confirmed',
    confirmed_by=$2,confirmed_at=now() WHERE id=$1`, [adjustmentId, ownerId]);
  await client.query("UPDATE budget_adjustment_proposals SET status='executing' WHERE id=$1", [adjustmentId]);
  let periodVersion = input.expectedPeriodVersion;
  const cancelledItemIds: string[] = [];
  for (const change of option.changes.filter((entry) => entry.action === 'cancel')) {
    const cancelled = await cancelBudgetItem(client, ownerId, {
      periodId: row.periodId,
      itemId: change.budgetItemId,
      expectedPeriodVersion: periodVersion,
      reason: `调整方案：${row.proposedChanges.emergency.reason}`.slice(0, 200),
    });
    periodVersion = cancelled.basis.periodVersion;
    cancelledItemIds.push(change.budgetItemId);
  }
  const emergency = row.proposedChanges.emergency;
  const created = await applyBudgetItemChange(client, ownerId, {
    periodId: row.periodId,
    itemId: null,
    expectedPeriodVersion: periodVersion,
    kind: 'essential_expense',
    title: `意外支出：${emergency.reason}`.slice(0, 120),
    categoryCode: 'unexpected',
    plannedOn: emergency.plannedOn,
    userEstimatedAmountMinor: emergency.amountMinor,
    priority: 'required',
    changeReason: emergency.reason,
  });
  const cancellationRequestIds: string[] = [];
  let adjustmentStatus: 'executing' | 'complete' | 'pending_review' = 'complete';
  for (const change of option.changes.filter((entry) => entry.action === 'cancel_order')) {
    const order = (await client.query<{
      amountMinor: number;
      environment: 'simulation' | 'sandbox';
      provider: 'simulation' | 'alipay';
      paymentStatus: string;
      refundedMinor: number;
      ruleVersion: number;
      cancellationRule: CancellationRule;
    }>(`SELECT o.amount_minor AS "amountMinor",o.environment,o.provider,
        o.payment_status AS "paymentStatus",o.refunded_minor AS "refundedMinor",
        c.rule_version AS "ruleVersion",c.cancellation_rule AS "cancellationRule"
      FROM orders o JOIN purchase_intents i ON i.id=o.purchase_intent_id
      JOIN offer_quotes q ON q.id=i.quote_id JOIN catalog_items c ON c.id=q.catalog_item_id
      WHERE o.id=$1 AND o.owner_id=$2 AND o.budget_period_id=$3 FOR UPDATE OF o,c`,
    [change.orderId, ownerId, row.periodId])).rows[0];
    if (!order || order.paymentStatus !== 'paid' || order.refundedMinor > 0
      || order.ruleVersion !== change.ruleVersion || order.cancellationRule !== change.cancellationRule) {
      throw new AppError(409, 'CONFIRMATION_SCOPE_MISMATCH', '订单付款或取消规则已经变化，请重新评估。');
    }
    const details = cancellationRuleDetails(order.cancellationRule, order.amountMinor);
    const refundableMinor = order.amountMinor - details.feeMinor;
    if (details.feeMinor !== change.feeMinor || refundableMinor !== change.refundableMinor) {
      throw new AppError(409, 'CONFIRMATION_SCOPE_MISMATCH', '取消费用或预计退款已经变化。');
    }
    const requestId = randomUUID();
    const accountSource = (await client.query<{ source: 'demo' | 'bank_api' }>(`SELECT a.source
      FROM budget_periods p JOIN finance_accounts a ON a.id=p.primary_account_id
      WHERE p.id=$1 AND p.owner_id=$2`, [row.periodId, ownerId])).rows[0]?.source;
    if (!accountSource) throw new AppError(409, 'FINANCE_BASIS_UNKNOWN', '调整方案缺少原账户来源。');
    const decision = initialDecisionForRule(order.cancellationRule);
    const requestStatus = decision === 'approve' ? 'approved' : decision === 'delay' ? 'delayed' : 'rejected';
    await client.query(`INSERT INTO cancellation_requests
        (id,order_id,owner_id,budget_adjustment_id,accepted_fee_minor,
          accepted_refund_minor,status,rule_version,rule_preset,decision,decision_reason)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [requestId, change.orderId,
      ownerId, adjustmentId, details.feeMinor, refundableMinor, requestStatus,
      order.ruleVersion, order.cancellationRule, decision, details.label]);
    cancellationRequestIds.push(requestId);
    if (decision === 'delay') {
      adjustmentStatus = 'pending_review';
      await ensureManualTask(client, { dedupeKey: `consumer-cancellation:${requestId}`,
        budgetPeriodId: row.periodId, responsibleProvider: order.provider,
        orderId: change.orderId, cancellationRequestId: requestId,
        type: 'cancellation_follow_up', reason: '登记规则要求延迟复核取消申请。',
        nextAction: '核对原订单和取消规则后继续原申请，不新建替代退款。' });
    } else if (decision === 'approve' && refundableMinor > 0) {
      adjustmentStatus = 'executing';
      const amounts = details.batchCount === 2
        ? [Math.floor(refundableMinor / 2), refundableMinor - Math.floor(refundableMinor / 2)]
        : [refundableMinor];
      for (const [index, amountMinor] of amounts.entries()) {
        const batchId = randomUUID();
        const operationId = await createOperationJob(client, { budgetPeriodId: row.periodId,
          ownerId, type: order.environment === 'simulation' ? 'simulate_refund_batch' : 'sandbox_refund',
          entityId: batchId, purpose: `B06 取消退款:${requestId}:${index + 1}` });
        await client.query(`INSERT INTO refund_batches
            (id,cancellation_request_id,order_id,merchant_id,responsible_provider,
              operation_id,environment,provider,batch_number,business_number,amount_minor)
          VALUES($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,$10)`, [batchId, requestId,
        change.orderId, order.provider, operationId, order.environment, order.provider,
        index + 1, `XZ-RF-${batchId.replaceAll('-', '')}`, amountMinor]);
      }
      await client.query("UPDATE cancellation_requests SET status='refund_processing' WHERE id=$1", [requestId]);
      await client.query("UPDATE orders SET status='cancellation_processing' WHERE id=$1", [change.orderId]);
      await applyVerifiedMoneyEvent(client, ownerId, {
        orderId: change.orderId,
        provider: order.provider,
        providerEventId: `REFUND_REQUESTED_${requestId}`,
        eventType: 'refund_requested',
        amountMinor: refundableMinor,
        currency: 'CNY',
        occurredAt: new Date().toISOString(),
        verificationState: 'unverified',
        source: accountSource,
      });
    }
  }
  await client.query('UPDATE budget_adjustment_proposals SET status=$2 WHERE id=$1',
    [adjustmentId, adjustmentStatus]);
  await client.query(`INSERT INTO budget_events (owner_id,period_id,actor_id,type,data)
    VALUES($1,$2,$1,'budget_adjustment_confirmed',$3)`, [ownerId, row.periodId,
    { adjustmentId, acceptedOptionId: option.optionId,
      emergencyItemId: created.item.itemId, cancelledItemIds, cancellationRequestIds,
      status: adjustmentStatus }]);
  return budgetAdjustmentConfirmationView.parse({
    adjustmentId,
    status: adjustmentStatus,
    acceptedOptionId: option.optionId,
    emergencyItem: created.item,
    cancelledItemIds,
    cancellationRequestIds,
    financialVersion: created.basis.financialVersion,
    periodVersion: created.basis.periodVersion,
  });
}
