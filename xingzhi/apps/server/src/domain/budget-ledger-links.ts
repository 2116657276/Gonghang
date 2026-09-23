import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { FinanceDb } from './finance-facts.js';
import { AppError } from './errors.js';
import { expireStalePurchaseIntents } from './purchase-intent-lifecycle.js';

type Period = { accountId: string; status: string; version: string; financialVersion: string;
  accountStatus: string; monthStart: string; monthEnd: string };
type Item = { id: string; title: string; kind: string; status: string; estimatedMinor: string;
  settledEntryId: string | null; hasIntent?: boolean };
type Entry = { id: string; accountId: string; direction: string; status: string; orderId: string | null;
  amountMinor: number; occurredOn: string; isObligation: boolean; isBudgetSettlement: boolean };

function minor(value: number | string) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new AppError(409, 'FINANCE_BASIS_UNKNOWN', '关联金额超出可安全计算范围。');
  }
  return result;
}

export async function readBudgetLedgerLinks(db: FinanceDb, ownerId: string, periodId: string) {
  const period = (await db.query<Period>(`SELECT p.primary_account_id AS "accountId",p.status,p.version,
    a.financial_version AS "financialVersion",a.status AS "accountStatus",
    to_char(p.month_start,'YYYY-MM-DD') AS "monthStart",
    to_char(p.month_end,'YYYY-MM-DD') AS "monthEnd"
    FROM budget_periods p JOIN finance_accounts a ON a.id=p.primary_account_id
    WHERE p.id=$1 AND p.owner_id=$2 AND a.owner_id=$2`, [periodId, ownerId])).rows[0];
  if (!period) throw new AppError(404, 'RESOURCE_FORBIDDEN', '未找到本人预算周期。');
  const items = (await db.query<Item & { coveredMinor: string }>(`SELECT i.id,i.title,i.kind,i.status,
    i.user_estimated_amount_minor AS "estimatedMinor",i.settled_ledger_entry_id AS "settledEntryId",
    EXISTS(SELECT 1 FROM purchase_intents intent WHERE intent.budget_item_id=i.id
      AND intent.owner_id=i.owner_id AND intent.status IN ('proposed','confirmed','ordered')
      AND intent.expires_at>now()) AS "hasIntent",
    COALESCE(SUM(l.covered_minor) FILTER (WHERE l.active),0)::text AS "coveredMinor"
    FROM budget_items i LEFT JOIN budget_ledger_links l ON l.item_id=i.id
    WHERE i.period_id=$1 AND i.owner_id=$2 GROUP BY i.id ORDER BY i.planned_on,i.id`,
  [periodId, ownerId])).rows.map((row) => ({ itemId: row.id, title: row.title,
    kind: row.kind, status: row.status, estimatedMinor: minor(row.estimatedMinor),
    coveredMinor: minor(row.coveredMinor),
    remainingMinor: Math.max(0, minor(row.estimatedMinor) - minor(row.coveredMinor)),
    eligible: row.kind !== 'expected_income' && row.status === 'planned'
      && row.settledEntryId === null && !row.hasIntent }));
  const links = (await db.query<{ linkId: string; itemId: string; entryId: string; coveredMinor: number;
    active: boolean; linkedAt: Date; unlinkedAt: Date | null; itemTitle: string; entryAmountMinor: number }>(
    `SELECT l.id AS "linkId",l.item_id AS "itemId",l.entry_id AS "entryId",
      l.covered_minor AS "coveredMinor",l.active,l.linked_at AS "linkedAt",
      l.unlinked_at AS "unlinkedAt",i.title AS "itemTitle",
      e.amount_minor AS "entryAmountMinor"
    FROM budget_ledger_links l JOIN budget_items i ON i.id=l.item_id
    JOIN finance_ledger_entries e ON e.id=l.entry_id
    WHERE l.period_id=$1 AND l.owner_id=$2 ORDER BY l.linked_at DESC,l.id DESC`,
  [periodId, ownerId])).rows.map((row) => ({ ...row,
    coveredMinor: minor(row.coveredMinor), entryAmountMinor: minor(row.entryAmountMinor),
    linkedAt: row.linkedAt.toISOString(), unlinkedAt: row.unlinkedAt?.toISOString() ?? null }));
  return { periodId, accountId: period.accountId, periodStatus: period.status,
    accountStatus: period.accountStatus, financialVersion: minor(period.financialVersion),
    periodVersion: minor(period.version), items, links };
}

async function lockScope(client: PoolClient, ownerId: string, periodId: string,
  expectedPeriodVersion: number, expectedFinancialVersion?: number) {
  const discovered = (await client.query<{ accountId: string }>(`SELECT primary_account_id AS "accountId"
    FROM budget_periods WHERE id=$1 AND owner_id=$2`, [periodId, ownerId])).rows[0];
  if (!discovered) throw new AppError(404, 'RESOURCE_FORBIDDEN', '未找到本人预算周期。');
  const account = (await client.query<{ financialVersion: string; accountStatus: string }>(
    `SELECT financial_version AS "financialVersion",status AS "accountStatus"
    FROM finance_accounts WHERE id=$1 AND owner_id=$2 FOR UPDATE`,
  [discovered.accountId, ownerId])).rows[0];
  const period = (await client.query<Omit<Period, 'financialVersion' | 'accountStatus'>>(`SELECT
    primary_account_id AS "accountId",status,version,
    to_char(p.month_start,'YYYY-MM-DD') AS "monthStart",
    to_char(p.month_end,'YYYY-MM-DD') AS "monthEnd"
    FROM budget_periods p WHERE p.id=$1 AND p.owner_id=$2 FOR UPDATE`,
  [periodId, ownerId])).rows[0];
  if (!period || !account || period.accountId !== discovered.accountId) {
    throw new AppError(409, 'VERSION_CONFLICT', '账户或周期已变化，请刷新后重试。');
  }
  const scope = { ...period, ...account };
  if (scope.accountStatus !== 'linked') throw new AppError(409, 'FINANCE_SCOPE_REVOKED', '账户授权已撤回，不能改变计划关联。');
  if (scope.status !== 'active') throw new AppError(409, 'PERIOD_NOT_ACTIVE', '只有执行中的周期可以改变计划关联。');
  if (minor(scope.version) !== expectedPeriodVersion ||
    (expectedFinancialVersion !== undefined && minor(scope.financialVersion) !== expectedFinancialVersion)) {
    throw new AppError(409, 'VERSION_CONFLICT', '账户或计划已变化，请刷新后重新确认。',
      { periodVersion: minor(scope.version), financialVersion: minor(scope.financialVersion) });
  }
  return scope;
}

export async function linkBudgetLedgerEntry(client: PoolClient, ownerId: string, periodId: string,
  input: { entryId: string; itemId: string; coveredMinor: number;
    expectedFinancialVersion: number; expectedPeriodVersion: number; confirmedByUser: true }) {
  const scope = await lockScope(client, ownerId, periodId,
    input.expectedPeriodVersion, input.expectedFinancialVersion);
  const item = (await client.query<Item>(`SELECT id,title,kind,status,
    user_estimated_amount_minor AS "estimatedMinor",settled_ledger_entry_id AS "settledEntryId"
    FROM budget_items WHERE id=$1 AND owner_id=$2 AND period_id=$3 AND account_id=$4 FOR UPDATE`,
  [input.itemId, ownerId, periodId, scope.accountId])).rows[0];
  if (!item || item.kind === 'expected_income' || item.status !== 'planned'
    || item.settledEntryId !== null) {
    throw new AppError(409, 'ITEM_NOT_ORDERABLE', '只能关联本人尚未承诺的支出计划。');
  }
  await expireStalePurchaseIntents(client, ownerId, item.id);
  const intent = await client.query(`SELECT 1 FROM purchase_intents
    WHERE owner_id=$1 AND budget_item_id=$2 AND status IN ('proposed','confirmed','ordered') LIMIT 1`,
  [ownerId, item.id]);
  if (intent.rowCount) throw new AppError(409, 'ITEM_NOT_ORDERABLE', '已有购买确认或订单的项目不能关联普通流水。');
  const entry = (await client.query<Entry>(`SELECT e.id,e.account_id AS "accountId",e.direction,e.status,
    e.order_id AS "orderId",e.amount_minor AS "amountMinor",
    to_char(e.occurred_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS "occurredOn",
    EXISTS(SELECT 1 FROM finance_obligations o WHERE o.settled_ledger_entry_id=e.id) AS "isObligation",
    EXISTS(SELECT 1 FROM budget_items i WHERE i.settled_ledger_entry_id=e.id) AS "isBudgetSettlement"
    FROM finance_ledger_entries e WHERE e.id=$1 AND e.owner_id=$2 FOR UPDATE`,
  [input.entryId, ownerId])).rows[0];
  if (!entry || entry.accountId !== scope.accountId || entry.direction !== 'outflow'
    || entry.status !== 'posted' || entry.orderId !== null || entry.isObligation
    || entry.isBudgetSettlement
    || entry.occurredOn < scope.monthStart || entry.occurredOn > scope.monthEnd) {
    throw new AppError(409, 'FINANCE_BASIS_UNKNOWN', '只能关联本周期同账户已入账的非订单支出。');
  }
  if ((await client.query('SELECT 1 FROM budget_ledger_links WHERE entry_id=$1 AND active',
    [entry.id])).rowCount) throw new AppError(409, 'VERSION_CONFLICT', '这笔流水已有计划关联。');
  const covered = (await client.query<{ total: string }>(`SELECT COALESCE(SUM(covered_minor),0)::text AS total
    FROM budget_ledger_links WHERE item_id=$1 AND active`, [item.id])).rows[0]!;
  const remaining = minor(item.estimatedMinor) - minor(covered.total);
  if (input.coveredMinor > minor(entry.amountMinor) || input.coveredMinor > remaining) {
    throw new AppError(409, 'AMOUNT_OUT_OF_RANGE', '覆盖金额不能超过本笔支出或计划剩余金额。');
  }
  const linkId = randomUUID();
  await client.query(`INSERT INTO budget_ledger_links
    (id,owner_id,period_id,account_id,item_id,entry_id,covered_minor)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [linkId, ownerId, periodId, scope.accountId,
    item.id, entry.id, input.coveredMinor]);
  await client.query('UPDATE budget_periods SET updated_at=now() WHERE id=$1', [periodId]);
  await client.query(`INSERT INTO budget_events(owner_id,period_id,actor_id,type,data)
    VALUES($1,$2,$1,'budget_ledger_linked',$3::jsonb)`, [ownerId, periodId,
    JSON.stringify({ linkId, itemId: item.id, entryId: entry.id, coveredMinor: input.coveredMinor })]);
  return readBudgetLedgerLinks(client, ownerId, periodId);
}

export async function unlinkBudgetLedgerEntry(client: PoolClient, ownerId: string,
  periodId: string, linkId: string, expectedPeriodVersion: number) {
  await lockScope(client, ownerId, periodId, expectedPeriodVersion);
  const link = (await client.query<{ itemId: string; entryId: string; active: boolean }>(
    `SELECT item_id AS "itemId",entry_id AS "entryId",active FROM budget_ledger_links
      WHERE id=$1 AND owner_id=$2 AND period_id=$3 FOR UPDATE`,
  [linkId, ownerId, periodId])).rows[0];
  if (!link) throw new AppError(404, 'RESOURCE_FORBIDDEN', '未找到本人计划关联。');
  if (!link.active) throw new AppError(409, 'VERSION_CONFLICT', '这条关联已解除，请刷新。');
  await client.query(`UPDATE budget_ledger_links SET active=false,unlinked_at=now() WHERE id=$1`, [linkId]);
  await client.query('UPDATE budget_periods SET updated_at=now() WHERE id=$1', [periodId]);
  await client.query(`INSERT INTO budget_events(owner_id,period_id,actor_id,type,data)
    VALUES($1,$2,$1,'budget_ledger_unlinked',$3::jsonb)`, [ownerId, periodId,
    JSON.stringify({ linkId, itemId: link.itemId, entryId: link.entryId })]);
  return readBudgetLedgerLinks(client, ownerId, periodId);
}
