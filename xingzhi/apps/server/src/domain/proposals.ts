import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { purchaseProposalInput, changeProposalInput } from '@xingzhi/contracts';
import type { AuthUser } from '../auth/session.js';
import { ownedPlan } from './access.js';
import { AppError } from './errors.js';
import { appendEvent } from './events.js';
import { sumMinor } from './money.js';
import { cancellationRuleDetails, type CancellationRule } from './aftercare.js';
import type { CatalogRow } from './business-reads.js';

export type PlanItemRow = {
  id: string;
  plan_id: string;
  catalog_item_id: string | null;
  merchant_id: string | null;
  name: string;
  kind: string;
  price_minor: number;
  status: string;
  position: number;
};

export async function createPurchaseProposal(client: PoolClient, user: AuthUser, planId: string, rawInput: unknown) {
  const input = purchaseProposalInput.strict().parse(rawInput);
      const plan = await ownedPlan(client, planId, user, true);
      if((await client.query('SELECT 1 FROM orders WHERE plan_id=$1 AND plan_item_id=ANY($2::uuid[]) LIMIT 1',[planId,input.itemIds])).rowCount){
        throw new AppError(422,'ITEM_ALREADY_ORDERED','已有订单的计划项不能再次生成购买方案。');
      }
      const items = await client.query<PlanItemRow & CatalogRow & { active: boolean }>(`
        SELECT plan_items.id, plan_items.plan_id, plan_items.catalog_item_id, plan_items.merchant_id, plan_items.name, plan_items.kind,
          catalog_items.price_minor, plan_items.status, plan_items.position, catalog_items.rule_version, catalog_items.active
        FROM plan_items JOIN catalog_items ON catalog_items.id = plan_items.catalog_item_id
        WHERE plan_items.plan_id = $1 AND plan_items.id = ANY($2::uuid[]) FOR UPDATE
      `, [planId, input.itemIds]);
      if (items.rowCount !== new Set(input.itemIds).size) throw new AppError(422, 'ITEM_NOT_AVAILABLE', '部分计划项不存在或没有对应商品。');
      if (items.rows.some((item) => item.kind === 'unbooked' || item.status === 'stopped' || !item.active)) {
        throw new AppError(422, 'ITEM_NOT_PURCHASABLE', '未购买或已停止的计划项不能创建订单。');
      }
      const snapshotItems = input.itemIds.map((itemId) => {
        const item = items.rows.find((row) => row.id === itemId)!;
        return { planItemId: item.id, catalogItemId: item.catalog_item_id, name: item.name, priceMinor: item.price_minor, ruleVersion: item.rule_version };
      });
      const proposalId = randomUUID();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      const snapshot = { items: snapshotItems, totalMinor: sumMinor(snapshotItems.map((item) => item.priceMinor)), currency: 'CNY' };
      await client.query(`INSERT INTO proposals (id, plan_id, owner_id, type, plan_version, snapshot, expires_at)
        VALUES ($1,$2,$3,'purchase',$4,$5,$6)`, [proposalId, planId, user.id, plan.version, snapshot, expiresAt]);
      await appendEvent(client, planId, user.id, 'purchase_proposal.created', { proposalId, itemIds: input.itemIds });
      return { proposalId, version: plan.version, expiresAt, ...snapshot };
}

export async function createChangeProposal(client: PoolClient, user: AuthUser, planId: string, rawInput: unknown) {
  const input = changeProposalInput.strict().parse(rawInput);
      const plan = await ownedPlan(client, planId, user, true);
      const items = await client.query<PlanItemRow & { order_id: string | null; payment_status: string | null; amount_minor: number | null; rule_version: number | null; cancellation_rule: CancellationRule | null }>(`
        SELECT plan_items.id, plan_items.plan_id, plan_items.catalog_item_id, plan_items.merchant_id, plan_items.name, plan_items.kind,
          plan_items.price_minor, plan_items.status, plan_items.position, orders.id AS order_id, orders.payment_status, orders.amount_minor,
          catalog_items.rule_version, catalog_items.cancellation_rule
        FROM plan_items LEFT JOIN orders ON orders.plan_item_id = plan_items.id
        LEFT JOIN catalog_items ON catalog_items.id = plan_items.catalog_item_id
        WHERE plan_items.plan_id = $1 AND plan_items.id = ANY($2::uuid[]) FOR UPDATE OF plan_items`, [plan.id, input.items.map((item) => item.planItemId)]);
      if (items.rowCount !== new Set(input.items.map((item) => item.planItemId)).size) throw new AppError(422, 'ITEM_NOT_IN_PLAN', '部分变更项目不存在。');
      const snapshots = input.items.map((requested) => {
        const item = items.rows.find((row) => row.id === requested.planItemId)!;
        if (requested.intent === 'stop' && item.order_id) throw new AppError(422, 'STOP_REQUIRES_NO_ORDER', '已有订单的项目应选择关单或取消。');
        if (requested.intent === 'close' && item.payment_status !== 'pending') throw new AppError(422, 'CLOSE_REQUIRES_UNPAID_ORDER', '关单仅适用于明确待付款订单。');
        if (requested.intent === 'cancel' && item.payment_status !== 'paid') throw new AppError(422, 'CANCEL_REQUIRES_PAID_ORDER', '取消退款仅适用于已付款订单。');
        const details = requested.intent === 'cancel'
          ? cancellationRuleDetails(item.cancellation_rule!, Number(item.amount_minor))
          : { feeMinor: 0 };
        const feeMinor = details.feeMinor;
        const refundMinor = requested.intent === 'cancel' ? Number(item.amount_minor) - feeMinor : 0;
        return {
          planItemId: item.id, name: item.name, intent: requested.intent, orderId: item.order_id,
          paymentStatus: item.payment_status, feeMinor, refundMinor,
          ruleVersion: requested.intent === 'cancel' ? item.rule_version : null,
          rulePreset: requested.intent === 'cancel' ? item.cancellation_rule : null,
        };
      });
      const proposalId = randomUUID();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      const snapshot = { items: snapshots, totalFeeMinor: sumMinor(snapshots.map((item) => item.feeMinor)), totalRefundMinor: sumMinor(snapshots.map((item) => item.refundMinor)), currency: 'CNY' };
      await client.query("INSERT INTO proposals (id, plan_id, owner_id, type, plan_version, snapshot, expires_at) VALUES ($1,$2,$3,'change',$4,$5,$6)",
        [proposalId, plan.id, user.id, plan.version, snapshot, expiresAt]);
      await appendEvent(client, plan.id, user.id, 'change_proposal.created', { proposalId, itemCount: snapshots.length });
      return { proposalId, version: plan.version, expiresAt, ...snapshot };
}
