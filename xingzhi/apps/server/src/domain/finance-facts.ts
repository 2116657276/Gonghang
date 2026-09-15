import type { QueryResult, QueryResultRow } from 'pg';
import { AppError } from './errors.js';

export type FinanceDb = {
  query: <T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) => Promise<QueryResult<T>>;
};

type AccountRow = {
  id: string; ownerId: string; provider: 'demo' | 'icbc'; accountType: 'debit' | 'credit' | 'loan';
  maskedIdentifier: string; displayName: string; currency: 'CNY'; source: 'demo' | 'bank_api';
  status: 'linked' | 'revoked'; authorizedAt: Date; revokedAt: Date | null; financialVersion: string;
};
type SnapshotRow = {
  id: string; availableBalanceMinor: number | null; currentBalanceMinor: number | null;
  outstandingMinor: number | null; creditLimitMinor: number | null; asOf: Date;
  coveredThroughAt: Date | null; factStatus: 'observed' | 'estimated' | 'unknown';
  source: string; capturedAt: Date;
};
type LedgerRow = {
  id: string; direction: 'inflow' | 'outflow'; amountMinor: number; occurredAt: Date;
  postedAt: Date | null; status: 'pending' | 'posted' | 'reversed';
  source: string; category: string | null; orderId: string | null;
};
type ObligationRow = {
  id: string; obligationType: 'credit_bill' | 'loan_repayment' | 'installment';
  liabilityAccountId: string | null; liabilityAccountType: string | null;
  repaymentAccountId: string | null; repaymentAccountType: string | null;
  includedInObligationId: string | null; settledLedgerEntryId: string | null;
  label: string; dueOn: string; amountDueMinor: number; outstandingMinor: number | null;
  status: 'upcoming' | 'paid' | 'overdue' | 'unknown' | 'cancelled';
  settledAccountId: string | null; settledStatus: string | null; settledDirection: string | null;
};
type RefundEventRow = {
  eventId: string; orderId: string; eventType: string; amountMinor: string;
  verificationState: string; occurredAt: Date;
};

function safeAmount(value: number | string | null) {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new AppError(409, 'FINANCE_BASIS_UNKNOWN', '资金金额超出可安全计算范围。');
  return parsed;
}

function dateTime(value: Date | null) { return value?.toISOString() ?? null; }

function obligationState(rows: ObligationRow[], accountId: string) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const scoped = rows.filter((row) => row.repaymentAccountId === accountId
    || (row.repaymentAccountId === null && row.status !== 'paid' && row.status !== 'cancelled'));
  const result = scoped.map((row) => {
    let issue: string | null = null;
    const visited = new Set<string>([row.id]);
    let parentId = row.includedInObligationId;
    while (parentId !== null) {
      if (visited.has(parentId)) { issue = 'OBLIGATION_CYCLE'; break; }
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent || parent.repaymentAccountId !== row.repaymentAccountId) {
        issue = 'OBLIGATION_SCOPE_UNKNOWN'; break;
      }
      parentId = parent.includedInObligationId;
    }
    if (row.repaymentAccountId === null || row.repaymentAccountType !== 'debit') {
      issue ??= 'REPAYMENT_ACCOUNT_UNKNOWN';
    }
    if (row.liabilityAccountId !== null && (
      (row.obligationType === 'credit_bill' && row.liabilityAccountType !== 'credit')
      || (row.obligationType === 'loan_repayment' && row.liabilityAccountType !== 'loan')
      || (row.obligationType === 'installment' && !['credit', 'loan'].includes(row.liabilityAccountType ?? ''))
    )) issue ??= 'LIABILITY_TYPE_MISMATCH';
    if (row.settledLedgerEntryId !== null && (
      row.settledAccountId !== row.repaymentAccountId || row.settledStatus !== 'posted'
      || row.settledDirection !== 'outflow'
    )) issue ??= 'REPAYMENT_FACT_UNKNOWN';
    const active = row.status === 'upcoming' || row.status === 'overdue';
    if (row.status === 'paid' && row.settledLedgerEntryId === null) {
      issue ??= 'REPAYMENT_SETTLEMENT_UNVERIFIED';
    }
    if (active && row.settledLedgerEntryId !== null) {
      issue ??= 'REPAYMENT_STATUS_MISMATCH';
    }
    if (active && row.outstandingMinor === null && row.settledLedgerEntryId === null) {
      issue ??= 'REPAYMENT_AMOUNT_UNKNOWN';
    }
    if (row.status === 'unknown') issue ??= 'REPAYMENT_STATUS_UNKNOWN';
    const included = row.includedInObligationId !== null;
    const dueMinor = !issue && active && !included && row.settledLedgerEntryId === null
      ? safeAmount(row.outstandingMinor) : null;
    return {
      id: row.id, label: row.label, obligationType: row.obligationType,
      dueOn: row.dueOn, amountDueMinor: safeAmount(row.amountDueMinor),
      outstandingMinor: safeAmount(row.outstandingMinor), status: row.status,
      repaymentAccountId: row.repaymentAccountId,
      liabilityAccountId: row.liabilityAccountId,
      includedInObligationId: row.includedInObligationId,
      settledLedgerEntryId: row.settledLedgerEntryId,
      remainingDueMinor: dueMinor, dataIssue: issue,
    };
  });
  return {
    items: result,
    remainingDueMinor: result.some((row) => row.dataIssue !== null) ? null
      : safeAmount(result.reduce((sum, row) => sum + (row.remainingDueMinor ?? 0), 0)),
    dataStatus: result.some((row) => row.dataIssue !== null) ? 'unknown' as const : 'observed' as const,
  };
}

export async function loadFinanceAccountFacts(db: FinanceDb, ownerId: string, accountId: string, now = new Date()) {
  const account = (await db.query<AccountRow>(`SELECT id,owner_id AS "ownerId",provider,
    account_type AS "accountType",masked_identifier AS "maskedIdentifier",
    display_name AS "displayName",currency,source,status,
    authorized_at AS "authorizedAt",revoked_at AS "revokedAt",
    financial_version AS "financialVersion"
    FROM finance_accounts WHERE id=$1 AND owner_id=$2`, [accountId, ownerId])).rows[0];
  if (!account) throw new AppError(404, 'RESOURCE_FORBIDDEN', '未找到本人账户。');

  // A later captured old observation must never replace a newer as_of fact.
  const snapshot = (await db.query<SnapshotRow>(`SELECT id,
    available_balance_minor AS "availableBalanceMinor",
    current_balance_minor AS "currentBalanceMinor",
    outstanding_minor AS "outstandingMinor",credit_limit_minor AS "creditLimitMinor",
    as_of AS "asOf",covered_through_at AS "coveredThroughAt",
    captured_at AS "capturedAt",fact_status AS "factStatus",source
    FROM finance_account_snapshots WHERE account_id=$1
    ORDER BY as_of DESC,captured_at DESC,id DESC LIMIT 1`, [accountId])).rows[0];
  const ledger = (await db.query<LedgerRow>(`SELECT id,direction,amount_minor AS "amountMinor",
    occurred_at AS "occurredAt",posted_at AS "postedAt",status,source,category,
    order_id AS "orderId" FROM finance_ledger_entries
    WHERE account_id=$1 AND owner_id=$2 ORDER BY occurred_at DESC,id DESC`, [accountId, ownerId])).rows;
  const obligationRows = (await db.query<ObligationRow>(`SELECT o.id,o.obligation_type AS "obligationType",
    o.liability_account_id AS "liabilityAccountId", liability.account_type AS "liabilityAccountType",
    o.repayment_account_id AS "repaymentAccountId", repayment.account_type AS "repaymentAccountType",
    o.included_in_obligation_id AS "includedInObligationId",
    o.settled_ledger_entry_id AS "settledLedgerEntryId",o.label,
    to_char(o.due_on,'YYYY-MM-DD') AS "dueOn",o.amount_due_minor AS "amountDueMinor",
    o.outstanding_minor AS "outstandingMinor",o.status,
    settled.account_id AS "settledAccountId",settled.status AS "settledStatus",
    settled.direction AS "settledDirection"
    FROM finance_obligations o
    LEFT JOIN finance_accounts liability ON liability.id=o.liability_account_id AND liability.owner_id=o.owner_id
    LEFT JOIN finance_accounts repayment ON repayment.id=o.repayment_account_id AND repayment.owner_id=o.owner_id
    LEFT JOIN finance_ledger_entries settled ON settled.id=o.settled_ledger_entry_id AND settled.owner_id=o.owner_id
    WHERE o.owner_id=$1 ORDER BY o.due_on,o.id`, [ownerId])).rows;
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const expectedIncome = (await db.query<{ total: string }>(`SELECT COALESCE(SUM(i.user_estimated_amount_minor),0) AS total
    FROM budget_items i JOIN budget_periods p ON p.id=i.period_id
    WHERE i.owner_id=$1 AND i.account_id=$2 AND i.kind='expected_income'
      AND i.status='planned' AND p.status='active'
      AND i.planned_on >= $3::date`, [ownerId, accountId, today])).rows[0]!;
  const refundEvents = (await db.query<RefundEventRow>(`SELECT e.id AS "eventId",e.order_id AS "orderId",
    e.event_type AS "eventType",e.amount_minor AS "amountMinor",
    e.verification_state AS "verificationState",e.occurred_at AS "occurredAt"
    FROM finance_money_events e
    JOIN orders o ON o.id=e.order_id AND o.owner_id=e.owner_id
    JOIN budget_periods p ON p.id=o.budget_period_id AND p.owner_id=o.owner_id
    WHERE e.owner_id=$1 AND p.primary_account_id=$2
      AND e.event_type IN ('refund_requested','refund_verified')
    ORDER BY e.occurred_at DESC,e.id`, [ownerId, accountId])).rows;
  const obligations = obligationState(obligationRows, accountId);
  const postedAfterCoverage = snapshot?.coveredThroughAt
    ? ledger.filter((entry) => entry.status === 'posted' && entry.postedAt !== null
      && entry.postedAt > snapshot.coveredThroughAt! && entry.postedAt <= now
      && entry.source === account.source)
    : [];
  const incrementMinor = postedAfterCoverage.reduce((sum, entry) => sum
    + (entry.direction === 'inflow' ? 1 : -1) * entry.amountMinor, 0);
  const basisIssues = [
    account.status !== 'linked' ? 'FINANCE_SCOPE_REVOKED' : null,
    account.accountType !== 'debit' ? 'ACCOUNT_NOT_DEBIT' : null,
    !snapshot ? 'SNAPSHOT_MISSING' : null,
    snapshot && snapshot.factStatus !== 'observed' ? 'SNAPSHOT_NOT_OBSERVED' : null,
    snapshot && snapshot.source !== account.source ? 'SNAPSHOT_SOURCE_MISMATCH' : null,
    snapshot && snapshot.availableBalanceMinor === null ? 'AVAILABLE_BALANCE_UNKNOWN' : null,
    snapshot && snapshot.coveredThroughAt === null ? 'COVERAGE_UNKNOWN' : null,
    snapshot && snapshot.coveredThroughAt !== null && snapshot.coveredThroughAt < snapshot.asOf
      ? 'COVERAGE_BEFORE_SNAPSHOT' : null,
    snapshot && snapshot.coveredThroughAt !== null && snapshot.coveredThroughAt > now
      ? 'COVERAGE_IN_FUTURE' : null,
    snapshot && (snapshot.asOf > now || now.getTime() - snapshot.asOf.getTime() > 24 * 60 * 60 * 1000)
      ? 'SNAPSHOT_STALE' : null,
  ].filter((issue): issue is string => issue !== null);
  const incomplete = basisIssues.length > 0;
  const cash = incomplete ? null : safeAmount(snapshot.availableBalanceMinor! + incrementMinor);
  if (cash !== null && cash < 0) basisIssues.push('CASH_BELOW_ZERO');
  const cashBasis = {
    snapshotId: incomplete ? null : snapshot.id,
    asOf: incomplete ? null : snapshot.asOf.toISOString(),
    coveredThroughAt: incomplete ? null : snapshot.coveredThroughAt!.toISOString(),
    confirmedCashMinor: cash !== null && cash >= 0 ? cash : null,
    dataStatus: cash !== null && cash >= 0 ? 'observed' as const : 'unknown' as const,
    reasonCodes: basisIssues,
  };
  return {
    account: {
      accountId: account.id, provider: account.provider, accountType: account.accountType,
      maskedIdentifier: account.maskedIdentifier, displayName: account.displayName,
      currency: account.currency, source: account.source, status: account.status,
      authorizedAt: account.authorizedAt.toISOString(), revokedAt: dateTime(account.revokedAt),
      financialVersion: safeAmount(account.financialVersion)!,
    },
    latestSnapshot: snapshot ? {
      snapshotId: snapshot.id, asOf: snapshot.asOf.toISOString(),
      coveredThroughAt: dateTime(snapshot.coveredThroughAt),
      capturedAt: snapshot.capturedAt.toISOString(), factStatus: snapshot.factStatus,
      availableBalanceMinor: safeAmount(snapshot.availableBalanceMinor),
      currentBalanceMinor: safeAmount(snapshot.currentBalanceMinor),
      outstandingMinor: safeAmount(snapshot.outstandingMinor),
      creditLimitMinor: safeAmount(snapshot.creditLimitMinor),
    } : null,
    cashBasis,
    ledger: ledger.map((entry) => ({
      entryId: entry.id, direction: entry.direction, amountMinor: safeAmount(entry.amountMinor)!,
      occurredAt: entry.occurredAt.toISOString(), postedAt: dateTime(entry.postedAt),
      status: entry.status, source: entry.source, category: entry.category, orderId: entry.orderId,
    })),
    obligations: account.accountType === 'debit'
      ? obligations : { items: obligationRows.filter((row) => row.liabilityAccountId === accountId).map((row) => ({
        id: row.id, label: row.label, obligationType: row.obligationType, dueOn: row.dueOn,
        amountDueMinor: safeAmount(row.amountDueMinor), outstandingMinor: safeAmount(row.outstandingMinor),
        status: row.status, repaymentAccountId: row.repaymentAccountId,
        includedInObligationId: row.includedInObligationId,
      })), remainingDueMinor: null, dataStatus: 'unknown' as const },
    // Estimates and unverified refunds are display-only, never cash admission.
    displayOnly: {
      expectedIncomeMinor: safeAmount(expectedIncome.total)!,
      refundEvidenceNotCash: refundEvents.map((event) => ({
        eventId: event.eventId, orderId: event.orderId, eventType: event.eventType,
        amountMinor: safeAmount(event.amountMinor)!,
        verificationState: event.verificationState, occurredAt: event.occurredAt.toISOString(),
      })),
      pendingInflowMinor: ledger.filter((row) => row.status === 'pending' && row.direction === 'inflow')
        .reduce((sum, row) => sum + row.amountMinor, 0),
      pendingOutflowMinor: ledger.filter((row) => row.status === 'pending' && row.direction === 'outflow')
        .reduce((sum, row) => sum + row.amountMinor, 0),
      pendingRefundMinor: ledger.filter((row) => row.status === 'pending' && row.direction === 'inflow' && row.category === 'refund')
        .reduce((sum, row) => sum + row.amountMinor, 0),
      creditLimitMinor: account.accountType === 'credit' ? safeAmount(snapshot?.creditLimitMinor ?? null) : null,
      outstandingMinor: account.accountType !== 'debit' ? safeAmount(snapshot?.outstandingMinor ?? null) : null,
    },
  };
}

export async function readExecutionCashBasis(db: FinanceDb, ownerId: string, accountId: string, now = new Date()) {
  const facts = await loadFinanceAccountFacts(db, ownerId, accountId, now);
  if (facts.account.status === 'revoked') {
    throw new AppError(409, 'FINANCE_SCOPE_REVOKED', '账户授权已撤回，不能作为新执行依据。');
  }
  if (facts.cashBasis.dataStatus !== 'observed' || facts.obligations.dataStatus !== 'observed') {
    throw new AppError(409, 'FINANCE_BASIS_UNKNOWN', '账户快照或还款事实不足，不能形成执行依据。');
  }
  return facts;
}
