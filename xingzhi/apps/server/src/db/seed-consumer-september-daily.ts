import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { closePool, transaction } from './client.js';

// Additive local Demo fixture for the existing primary account only.
const ownerId = 'a0a46a8c-72aa-4e19-93ab-01984b079676';
const accountId = '63c048c6-a72f-5cbb-a949-163daa9fc29d';
const baselineId = 'c0e0fb60-79dd-520d-a8cd-e39b76af2b49';
const priorId = '814d3423-edad-5fdd-ae32-e9a05348f8f0';
const prefix = 'XZ-202609-A00-DAILY-';
function uuid(value: string) {
  const hex = createHash('sha256').update(`${prefix}${value}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function shanghaiDate(date: Date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
const candidates = [
  { time: '08:10', category: 'food', merchant: '社区早餐店', label: '早餐', base: 1200 },
  { time: '12:25', category: 'food', merchant: '街角简餐', label: '午餐', base: 2600 },
  { time: '18:40', category: 'food', merchant: '家常小馆', label: '晚餐', base: 3400 },
  { time: '20:10', category: 'shopping', merchant: '社区便利店', label: '日常补给', base: 1800 },
] as const;

async function seed(client: PoolClient) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${prefix}${accountId}`]);
  const account = (await client.query<{ owner_id: string; provider_account_ref: string;
    source: string; status: string; account_type: string }>(
    'SELECT * FROM finance_accounts WHERE id=$1 FOR UPDATE', [accountId])).rows[0];
  assert(account?.owner_id === ownerId && account.provider_account_ref === 'A00-DEMO-DEBIT'
    && account.source === 'demo' && account.status === 'linked' && account.account_type === 'debit',
  '目标 Demo 账户不符合预期。');
  const old = (await client.query<{ available_balance_minor: number; covered_through_at: Date }>(
    'SELECT available_balance_minor,covered_through_at FROM finance_account_snapshots WHERE id=$1 AND account_id=$2',
    [baselineId, accountId])).rows[0];
  assert(old?.available_balance_minor === 200000 && old.covered_through_at, '原始余额基准不符合预期。');
  const prior = (await client.query<{ available_balance_minor: number; covered_through_at: Date }>(
    'SELECT available_balance_minor,covered_through_at FROM finance_account_snapshots WHERE id=$1 AND account_id=$2',
    [priorId, accountId])).rows[0];
  assert(prior?.available_balance_minor === 202820 && prior.covered_through_at,
    '九月已有快照不符合预期。');
  const existing = (await client.query<{ id: string; source: string; source_ref: string | null;
    direction: string; occurred_at: Date; posted_at: Date | null; amount_minor: number }>(
    'SELECT id,source,source_ref,direction,occurred_at,posted_at,amount_minor FROM finance_ledger_entries WHERE account_id=$1 FOR UPDATE',
    [accountId])).rows;
  assert(existing.every(row => row.source === 'demo' && row.posted_at && row.posted_at <= new Date()),
    '账户出现非 Demo 或未完成流水，停止补数。');
  const today = shanghaiDate(new Date());
  assert(today >= '2026-09-28' && today <= '2026-09-30', '此脚本只用于九月剩余日期的本地演示。');
  const targetDay = Number(today.slice(-2));
  const additions: Array<{ id: string; ref: string; at: string; direction: 'inflow' | 'outflow'; amount: number;
    category: string; merchant: string; label: string }> = [];
  for (let day = 1; day <= targetDay; day++) {
    const date = `2026-09-${String(day).padStart(2, '0')}`;
    const dayRows = existing.filter(row => shanghaiDate(row.occurred_at) === date && row.direction === 'outflow');
    const target = day === targetDay ? 2 : day % 3 === 0 ? 3 : 2;
    let count = dayRows.length;
    for (const [index, candidate] of candidates.entries()) {
      if (count >= target) break;
      const at = `${date}T${candidate.time}:00+08:00`;
      if (new Date(at) > new Date()) continue;
      if (dayRows.some(row => Math.abs(row.occurred_at.getTime() - new Date(at).getTime()) < 45 * 60 * 1000)) continue;
      const ref = `${prefix}${date}-${index}`;
      const id = uuid(`${date}-${index}`);
      if (existing.some(row => row.id === id || row.source_ref === ref)) { count++; continue; }
      additions.push({ id, ref, at, direction: 'outflow', amount: candidate.base + ((day * 7 + index * 3) % 9) * 100,
        category: candidate.category, merchant: candidate.merchant, label: candidate.label });
      count++;
    }
    assert(count >= target, `${date} 无法补到 ${target} 笔合理消费。`);
  }
  // A small second-hand sale makes the 9/23 and 9/26 observed snapshots
  // reconcile even after inserting the missing 9/24-25 Demo expenses.
  const receiptRef = `${prefix}2026-09-25-SECONDHAND`;
  if (!existing.some(row => row.source_ref === receiptRef)) additions.push({
    id: uuid('2026-09-25-secondhand'), ref: receiptRef,
    at: '2026-09-25T20:35:00+08:00', direction: 'inflow', amount: 6000,
    category: 'income', merchant: '同城二手买家', label: '闲置物品转让款',
  });
  if (!additions.length) return { added: 0, total: existing.length, snapshot: false };
  const latest = (await client.query<{ id: string; provider_snapshot_ref: string | null }>(
    'SELECT id,provider_snapshot_ref FROM finance_account_snapshots WHERE account_id=$1 ORDER BY as_of DESC,captured_at DESC LIMIT 1',
    [accountId])).rows[0];
  assert(latest?.id === priorId || latest?.provider_snapshot_ref?.startsWith(`${prefix}SNAPSHOT`),
    '已有其他来源的后续余额快照，停止补数以免覆盖用户测试。');
  for (const row of additions) await client.query(`INSERT INTO finance_ledger_entries
    (id,owner_id,account_id,source,source_ref,direction,amount_minor,occurred_at,posted_at,
     status,category,merchant_name,note,dedupe_key)
    VALUES($1,$2,$3,'demo',$4,$5,$6,$7,$7,'posted',$8,$9,$10,$4)`,
  [row.id, ownerId, accountId, row.ref, row.direction, row.amount, row.at, row.category,
    row.merchant, `${row.label} · 本地 Demo`]);
  const betweenSnapshots = (await client.query<{ balance: string }>(`SELECT
    COALESCE(SUM(CASE WHEN direction='inflow' THEN amount_minor ELSE -amount_minor END),0)::text AS balance
    FROM finance_ledger_entries WHERE account_id=$1 AND source='demo' AND status='posted'
      AND posted_at>$2 AND posted_at<=$3`,
  [accountId, old.covered_through_at, prior.covered_through_at])).rows[0]!;
  assert(200000 + Number(betweenSnapshots.balance) === 202820,
    '原有九月快照之间的 Demo 收支无法勾稽。');
  const afterPrior = (await client.query<{ balance: string }>(`SELECT
    COALESCE(SUM(CASE WHEN direction='inflow' THEN amount_minor ELSE -amount_minor END),0)::text AS balance
    FROM finance_ledger_entries WHERE account_id=$1 AND source='demo' AND status='posted'
      AND posted_at>$2 AND posted_at<=now()`, [accountId, prior.covered_through_at])).rows[0]!;
  const balance = 202820 + Number(afterPrior.balance);
  assert(Number.isSafeInteger(balance) && balance >= 0, '补数后的 Demo 余额无法勾稽。');
  const snapshotAt = new Date();
  const snapshotRef = `${prefix}SNAPSHOT-${today}`;
  if (latest?.provider_snapshot_ref === `${prefix}SNAPSHOT` && today === '2026-09-28') {
    // Repair this script's first 9/28 snapshot; the original two are immutable.
    await client.query(`UPDATE finance_account_snapshots
      SET available_balance_minor=$2,current_balance_minor=$2
      WHERE id=$1 AND account_id=$3 AND provider_snapshot_ref=$4`,
    [latest.id, balance, accountId, `${prefix}SNAPSHOT`]);
  } else {
    await client.query(`INSERT INTO finance_account_snapshots
      (id,account_id,available_balance_minor,current_balance_minor,as_of,covered_through_at,
       fact_status,source,provider_snapshot_ref)
      VALUES($1,$2,$3,$3,$4,$4,'observed','demo',$5)`,
    [uuid(`snapshot-${today}`), accountId, balance, snapshotAt, snapshotRef]);
  }
  return { added: additions.length, total: existing.length + additions.length,
    snapshot: true, balanceMinor: balance, through: today };
}

try { console.log(JSON.stringify(await transaction(seed))); }
finally { await closePool(); }
