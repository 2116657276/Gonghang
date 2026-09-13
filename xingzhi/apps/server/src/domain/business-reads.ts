import type { AuthUser } from '../auth/session.js';
import { query, transaction } from '../db/client.js';
import { readablePlan } from './access.js';
import { AppError, notFound } from './errors.js';
import { cancellationRuleDetails, type CancellationRule } from './aftercare.js';
import { sanitizeEvidence } from './evidence.js';

export type CatalogRow = {
  id: string;
  merchant_id: string;
  code: string;
  name: string;
  kind: string;
  description: string;
  price_minor: number;
  currency: string;
  rule_label: string;
  rule_version: number;
  cancellation_fee_minor: number;
  cancellation_rule: CancellationRule;
  simulation_mode: 'SUCCESS' | 'PENDING' | 'UNKNOWN';
};

export async function readCatalog() {
    const result = await query<CatalogRow>(`SELECT id, merchant_id, code, name, kind, description, price_minor, currency, rule_label,
      rule_version, cancellation_fee_minor, cancellation_rule, simulation_mode FROM catalog_items WHERE active = true ORDER BY code`);
    return { items: result.rows.map((item) => ({
      id: item.id, code: item.code, name: item.name, kind: item.kind, description: item.description,
      priceMinor: item.price_minor, currency: item.currency, ruleLabel: item.rule_label, ruleVersion: item.rule_version,
      cancellationFeeMinor: item.cancellation_fee_minor, cancellationRule: item.cancellation_rule,
      simulationMode: item.simulation_mode, source: '本地模拟目录',
    })) };
}

export async function readCancellationQuote(user: AuthUser, id: string) {
    const result = await query<{ id: string; owner_id: string; amount_minor: number; payment_status: string; status: string; refunded_minor: number; cancellation_rule: CancellationRule; rule_version: number }>(`
      SELECT orders.id, orders.owner_id, orders.amount_minor, orders.payment_status, orders.status, orders.refunded_minor, catalog_items.cancellation_rule, catalog_items.rule_version
      FROM orders JOIN plan_items ON plan_items.id = orders.plan_item_id JOIN catalog_items ON catalog_items.id = plan_items.catalog_item_id
      WHERE orders.id = $1`, [id]);
    const order = result.rows[0];
    if (!order || user.role !== 'consumer' || order.owner_id !== user.id) notFound('未找到可查看的订单。');
    if (order.payment_status !== 'paid') throw new AppError(422, 'CANCELLATION_NOT_AVAILABLE', '只有已付款订单可以生成退款报价。');
    if (order.refunded_minor > 0 || ['cancellation_processing', 'cancelled'].includes(order.status)) {
      throw new AppError(409, 'CANCELLATION_ALREADY_HANDLED', '订单已有取消处理或退款事实，请查看原取消申请和退款批次。');
    }
    const details = cancellationRuleDetails(order.cancellation_rule, order.amount_minor);
    return { orderId: order.id, feeMinor: details.feeMinor, refundableMinor: order.amount_minor - details.feeMinor,
      ruleVersion: order.rule_version, cancellationRule: order.cancellation_rule, source: '本地测试商户规则' };
}

export async function readOperation(user: AuthUser, id: string) {
    const result = await query<{ id: string; plan_id: string; owner_id: string; type: string; state: string; purpose: string; result: Record<string, unknown>; updated_at: Date }>(
      'SELECT id, plan_id, owner_id, type, state, purpose, result, updated_at FROM operations WHERE id = $1', [id]);
    const operation = result.rows[0];
    if (!operation) notFound('未找到可查看的操作。');
    if (user.role === 'consumer') {
      if (operation.owner_id !== user.id) notFound('未找到可查看的操作。');
    } else if (user.role === 'reviewer') {
      await transaction((client) => readablePlan(client, operation.plan_id, user));
    } else {
      notFound('未找到可查看的操作。');
    }
    return {
      operationId: operation.id,
      type: operation.type,
      state: operation.state,
      purpose: operation.purpose,
      result: user.role === 'reviewer' ? sanitizeEvidence(operation.result) as Record<string, unknown> : operation.result,
      observedAt: operation.updated_at,
    };
}
