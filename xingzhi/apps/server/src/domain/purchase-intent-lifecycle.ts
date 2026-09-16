import type { PoolClient } from 'pg';
import { AppError } from './errors.js';

export async function expireStalePurchaseIntents(
  client: PoolClient,
  ownerId: string,
  budgetItemId?: string,
  now = new Date(),
) {
  const expired = (await client.query<{ id: string; periodId: string; budgetItemId: string }>(`
    UPDATE purchase_intents SET status='expired'
    WHERE owner_id=$1 AND status='proposed' AND expires_at<=$2
      AND ($3::uuid IS NULL OR budget_item_id=$3)
    RETURNING id,period_id AS "periodId",budget_item_id AS "budgetItemId"`,
  [ownerId, now, budgetItemId ?? null])).rows;
  for (const intent of expired) {
    await client.query(`INSERT INTO budget_events(owner_id,period_id,actor_id,type,data)
      VALUES($1,$2,$1,'purchase_intent_expired',$3)`, [ownerId, intent.periodId,
      { purchaseIntentId: intent.id, budgetItemId: intent.budgetItemId }]);
  }
  return expired;
}

export async function rejectPurchaseIntent(
  client: PoolClient,
  ownerId: string,
  purchaseIntentId: string,
  now = new Date(),
) {
  const scope = (await client.query<{ budgetItemId: string; accountId: string }>(`SELECT
      intent.budget_item_id AS "budgetItemId",period.primary_account_id AS "accountId"
    FROM purchase_intents intent JOIN budget_periods period ON period.id=intent.period_id
    WHERE intent.id=$1 AND intent.owner_id=$2 AND period.owner_id=$2`,
  [purchaseIntentId, ownerId])).rows[0];
  if (!scope) throw new AppError(404, 'RESOURCE_FORBIDDEN', '未找到本人的购买意图。');
  // Match purchase confirmation's account -> periods -> item -> intent order.
  // This makes a simultaneous confirm/reject serialize to one business result
  // instead of deadlocking while foreign keys inspect the same period rows.
  await client.query('SELECT id FROM finance_accounts WHERE id=$1 AND owner_id=$2 FOR UPDATE',
    [scope.accountId, ownerId]);
  await client.query(`SELECT id FROM budget_periods WHERE owner_id=$1 AND primary_account_id=$2
    AND status='active' ORDER BY month_start,id FOR UPDATE`, [ownerId, scope.accountId]);
  await client.query('SELECT id FROM budget_items WHERE id=$1 AND owner_id=$2 FOR UPDATE',
    [scope.budgetItemId, ownerId]);
  const intent = (await client.query<{
    id: string; periodId: string; budgetItemId: string; status: string; expiresAt: Date;
  }>(`SELECT id,period_id AS "periodId",budget_item_id AS "budgetItemId",status,
      expires_at AS "expiresAt" FROM purchase_intents WHERE id=$1 AND owner_id=$2 FOR UPDATE`,
  [purchaseIntentId, ownerId])).rows[0]!;
  if (intent.status === 'confirmed' || intent.status === 'ordered') {
    throw new AppError(409, 'CONFIRMATION_SCOPE_MISMATCH', '购买意图已经确认或建单，请改走原订单善后。');
  }
  let status = intent.status;
  if (status === 'proposed') {
    status = intent.expiresAt <= now ? 'expired' : 'rejected';
    await client.query('UPDATE purchase_intents SET status=$2 WHERE id=$1', [intent.id, status]);
    await client.query(`INSERT INTO budget_events(owner_id,period_id,actor_id,type,data)
      VALUES($1,$2,$1,$3,$4)`, [ownerId, intent.periodId,
      status === 'expired' ? 'purchase_intent_expired' : 'purchase_intent_rejected',
      { purchaseIntentId: intent.id, budgetItemId: intent.budgetItemId }]);
  }
  return { purchaseIntentId: intent.id, status };
}
