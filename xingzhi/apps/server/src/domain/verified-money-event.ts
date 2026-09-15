import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { verifiedMoneyEvent, type VerifiedMoneyEvent } from '@xingzhi/contracts';
import { AppError } from './errors.js';

type OrderScope = {
  id: string; ownerId: string; periodId: string | null; accountId: string | null;
  budgetItemId: string | null; amountMinor: number; currency: string;
  environment: 'simulation' | 'sandbox'; provider: 'simulation' | 'alipay';
};
type LedgerEvidence = {
  id: string; ownerId: string; accountId: string; orderId: string | null;
  source: string; sourceRef: string | null; direction: 'inflow' | 'outflow';
  amountMinor: number; status: string; postedAt: Date | null;
};

const postedTypes = new Set(['payment_posted', 'refund_posted']);

/** Internal B05/A06 port only: caller has verified provider provenance. Never expose it as a consumer write route. */
export async function applyVerifiedMoneyEvent(client: PoolClient, ownerId: string,
  rawEvent: VerifiedMoneyEvent, options: { appliedLedgerEntryId?: string } = {}, now = new Date()) {
  const event = verifiedMoneyEvent.parse(rawEvent);
  if (new Date(event.occurredAt) > now) {
    throw new AppError(409, 'PROVIDER_RESULT_UNKNOWN', '渠道事件时间尚未得到可靠确认。');
  }
  const initial = (await client.query<OrderScope>(`SELECT o.id,o.owner_id AS "ownerId",
    o.budget_period_id AS "periodId",p.primary_account_id AS "accountId",
    i.budget_item_id AS "budgetItemId",o.amount_minor AS "amountMinor",
    o.currency,o.environment,o.provider
    FROM orders o LEFT JOIN budget_periods p ON p.id=o.budget_period_id
    LEFT JOIN purchase_intents i ON i.id=o.purchase_intent_id
    WHERE o.id=$1 AND o.owner_id=$2`, [event.orderId, ownerId])).rows[0];
  if (!initial || !initial.periodId || !initial.accountId || !initial.budgetItemId) {
    throw new AppError(404, 'RESOURCE_FORBIDDEN', '未找到本人新消费者订单；历史旧订单仍走原恢复流程。');
  }
  // Historical settlement remains possible after revocation/period closure.
  const account = (await client.query<{ id: string; source: string; provider: string;
    accountType: string }>(`SELECT id,source,provider,account_type AS "accountType"
    FROM finance_accounts WHERE id=$1 AND owner_id=$2 FOR UPDATE`,
  [initial.accountId, ownerId])).rows[0];
  if (!account || account.accountType !== 'debit') {
    throw new AppError(409, 'FINANCE_BASIS_UNKNOWN', '原订单借记账户不存在或范围不符。');
  }
  await client.query(`SELECT id FROM budget_periods WHERE id=$1 AND owner_id=$2
    AND primary_account_id=$3 FOR UPDATE`, [initial.periodId, ownerId, account.id]);
  const order = (await client.query<OrderScope>(`SELECT o.id,o.owner_id AS "ownerId",
    o.budget_period_id AS "periodId",p.primary_account_id AS "accountId",
    i.budget_item_id AS "budgetItemId",o.amount_minor AS "amountMinor",
    o.currency,o.environment,o.provider
    FROM orders o JOIN budget_periods p ON p.id=o.budget_period_id
    JOIN purchase_intents i ON i.id=o.purchase_intent_id
    WHERE o.id=$1 AND o.owner_id=$2 FOR UPDATE OF o`, [event.orderId, ownerId])).rows[0];
  if (!order || order.periodId !== initial.periodId || order.accountId !== account.id
    || order.provider !== event.provider || order.currency !== event.currency
    || event.source !== account.source || event.amountMinor > order.amountMinor
    || (order.environment === 'simulation' &&
      (order.provider !== 'simulation' || event.source !== 'demo'))
    || (order.environment === 'sandbox' && order.provider !== 'alipay')
    || (postedTypes.has(event.eventType) && order.environment === 'sandbox'
      && (event.source !== 'bank_api' || account.provider !== 'icbc'))
    || (event.eventType === 'payment_posted' && event.amountMinor !== order.amountMinor)
    || (event.eventType === 'refund_verified' && event.verificationState !== 'verified')) {
    throw new AppError(409, 'CONFIRMATION_SCOPE_MISMATCH',
      '渠道、金额、订单环境与本人账户来源不匹配。');
  }
  const wantsLedger = postedTypes.has(event.eventType);
  if (wantsLedger !== Boolean(options.appliedLedgerEntryId)) {
    throw new AppError(409, 'FINANCE_BASIS_UNKNOWN',
      '支付或退款到账必须关联已入账的本人订单流水；其他事件不得占用流水。');
  }
  let ledger: LedgerEvidence | undefined;
  if (options.appliedLedgerEntryId) {
    ledger = (await client.query<LedgerEvidence>(`SELECT id,owner_id AS "ownerId",
      account_id AS "accountId",order_id AS "orderId",source,
      source_ref AS "sourceRef",direction,amount_minor AS "amountMinor",
      status,posted_at AS "postedAt"
      FROM finance_ledger_entries WHERE id=$1 AND owner_id=$2 FOR UPDATE`,
    [options.appliedLedgerEntryId, ownerId])).rows[0];
    if (!ledger || ledger.accountId !== account.id || ledger.orderId !== order.id
      || ledger.source !== event.source || ledger.status !== 'posted'
      || ledger.postedAt === null || ledger.postedAt > now
      || ledger.amountMinor !== event.amountMinor
      || ledger.direction !== (event.eventType === 'payment_posted' ? 'outflow' : 'inflow')
      || (event.source === 'bank_api' && !ledger.sourceRef)) {
      throw new AppError(409, 'FINANCE_BASIS_UNKNOWN',
        '未找到同订单、同金额、同来源和方向的真实已入账流水。');
    }
  }
  const existing = (await client.query<{ id: string; ownerId: string; orderId: string;
    amountMinor: string; currency: string; occurredAt: Date; verificationState: string;
    source: string; appliedLedgerEntryId: string | null }>(`SELECT id,
    owner_id AS "ownerId",order_id AS "orderId",amount_minor AS "amountMinor",
    currency,occurred_at AS "occurredAt",verification_state AS "verificationState",
    source,applied_ledger_entry_id AS "appliedLedgerEntryId"
    FROM finance_money_events WHERE provider=$1 AND provider_event_id=$2
      AND event_type=$3`, [event.provider, event.providerEventId, event.eventType])).rows[0];
  if (existing) {
    if (existing.ownerId !== ownerId || existing.orderId !== order.id
      || Number(existing.amountMinor) !== event.amountMinor || existing.currency !== event.currency
      || existing.occurredAt.getTime() !== new Date(event.occurredAt).getTime()
      || existing.verificationState !== event.verificationState || existing.source !== event.source
      || existing.appliedLedgerEntryId !== (ledger?.id ?? null)) {
      throw new AppError(409, 'IDEMPOTENCY_CONFLICT', '同一提供方事件编号已有不同事实。');
    }
    return { eventId: existing.id, orderId: order.id, periodId: order.periodId,
      accountId: account.id, eventType: event.eventType,
      appliedLedgerEntryId: existing.appliedLedgerEntryId, reused: true };
  }
  if (ledger) {
    const used = await client.query(`SELECT 1 FROM finance_money_events
      WHERE applied_ledger_entry_id=$1 AND event_type IN ('payment_posted','refund_posted') LIMIT 1`,
    [ledger.id]);
    if (used.rowCount) {
      throw new AppError(409, 'IDEMPOTENCY_CONFLICT', '同一条已入账流水不能重复形成到账证据。');
    }
  }
  if (event.eventType === 'payment_posted') {
    const paid = await client.query(`SELECT 1 FROM finance_money_events
      WHERE order_id=$1 AND owner_id=$2 AND event_type='payment_posted' LIMIT 1`,
    [order.id, ownerId]);
    if (paid.rowCount) {
      throw new AppError(409, 'IDEMPOTENCY_CONFLICT', '同一订单不能重复形成付款到账证据。');
    }
  }
  if (event.eventType === 'refund_posted') {
    const received = (await client.query<{ amountMinor: string }>(`SELECT
      COALESCE(SUM(amount_minor),0) AS "amountMinor" FROM finance_money_events
      WHERE order_id=$1 AND owner_id=$2 AND event_type='refund_posted'`,
    [order.id, ownerId])).rows[0]!;
    if (Number(received.amountMinor) + event.amountMinor > order.amountMinor) {
      throw new AppError(409, 'AMOUNT_OUT_OF_RANGE', '累计到账退款不能超过原订单金额。');
    }
  }
  const eventId = randomUUID();
  await client.query(`INSERT INTO finance_money_events
    (id,owner_id,order_id,provider,provider_event_id,event_type,amount_minor,
      currency,occurred_at,verification_state,source,applied_ledger_entry_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [
    eventId, ownerId, order.id, event.provider, event.providerEventId,
    event.eventType, event.amountMinor, event.currency, event.occurredAt,
    event.verificationState, event.source, ledger?.id ?? null,
  ]);
  if (event.eventType === 'payment_posted') {
    const item = (await client.query<{ status: string; settledLedgerEntryId: string | null }>(`SELECT
      status,settled_ledger_entry_id AS "settledLedgerEntryId" FROM budget_items
      WHERE id=$1 AND owner_id=$2 AND period_id=$3 FOR UPDATE`,
    [order.budgetItemId, ownerId, order.periodId])).rows[0];
    if (!item || (item.status === 'settled' && item.settledLedgerEntryId !== ledger!.id)) {
      throw new AppError(409, 'CONFIRMATION_SCOPE_MISMATCH',
        '订单资金事实与原预算项目结算证据不一致。');
    }
    if (item.status === 'committed') {
      await client.query(`UPDATE budget_items SET status='settled',settled_ledger_entry_id=$2
        WHERE id=$1 AND owner_id=$3 AND period_id=$4`,
      [order.budgetItemId, ledger!.id, ownerId, order.periodId]);
    }
  }
  await client.query(`INSERT INTO budget_events (owner_id,period_id,actor_id,type,data)
    VALUES($1,$2,NULL,'verified_money_event',$3::jsonb)`, [ownerId, order.periodId,
    JSON.stringify({ eventId, orderId: order.id, eventType: event.eventType,
      appliedLedgerEntryId: ledger?.id ?? null, source: event.source }),
  ]);
  return { eventId, orderId: order.id, periodId: order.periodId,
    accountId: account.id, eventType: event.eventType,
    appliedLedgerEntryId: ledger?.id ?? null, reused: false };
}
