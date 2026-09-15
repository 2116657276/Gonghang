import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { pool, closePool } from '../db/client.js';
import { AppError } from './errors.js';
import {
  createBudgetPeriod, applyBudgetItemChange, cancelBudgetItem,
  activateBudgetPeriod, changeSavingsTarget, readBudgetPeriod,
} from './budget-periods.js';

test('A02 monthly budget keeps user estimates, versions, target audit and zero-necessities confirmation', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const owner = (await client.query<{ id: string }>(
      "SELECT id FROM users WHERE email='consumer-a@xingzhi.local' AND role='consumer'",
    )).rows[0];
    assert.ok(owner);
    const accountId = randomUUID();
    const snapshotId = randomUUID();
    const now = new Date();
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
    const monthStart = `${today.slice(0, 7)}-01`;
    await client.query(`INSERT INTO finance_accounts
      (id,owner_id,provider,account_type,provider_account_ref,masked_identifier,
        display_name,source,authorized_at)
      VALUES($1,$2,'demo','debit',$4,'****A02','A02 本地测试账户','demo',$3)`,
    [accountId, owner.id, now, accountId]);
    const financialVersion = Number((await client.query<{ financial_version: string }>(
      'SELECT financial_version FROM finance_accounts WHERE id=$1', [accountId],
    )).rows[0]!.financial_version);
    const created = await createBudgetPeriod(client, owner.id, {
      accountId, monthStart, savingsTargetMinor: 50000, expectedFinancialVersion: financialVersion,
    });
    const periodId = created.period.periodId;
    assert.equal(created.period.status, 'draft');
    assert.equal(created.basis.dataStatus, 'unknown');
    assert.equal(created.period.periodVersion, 1);
    await assert.rejects(() => readBudgetPeriod(client, randomUUID(), periodId),
      (error: unknown) => error instanceof AppError && error.code === 'RESOURCE_FORBIDDEN');
    await assert.rejects(() => activateBudgetPeriod(client, owner.id, periodId, {
      expectedFinancialVersion: financialVersion, expectedPeriodVersion: 1, confirmedNecessities: true,
    }), (error: unknown) => error instanceof AppError && error.code === 'FINANCE_BASIS_UNKNOWN');

    await client.query(`INSERT INTO finance_account_snapshots
      (id,account_id,available_balance_minor,current_balance_minor,as_of,
        covered_through_at,fact_status,source)
      VALUES($1,$2,200000,200000,$3,$3,'observed','demo')`,
    [snapshotId, accountId, now]);
    const newFinancialVersion = Number((await client.query<{ financial_version: string }>(
      'SELECT financial_version FROM finance_accounts WHERE id=$1', [accountId],
    )).rows[0]!.financial_version);
    assert.equal(newFinancialVersion, financialVersion + 1);
    const custom = await applyBudgetItemChange(client, owner.id, {
      periodId, itemId: null, expectedPeriodVersion: 1,
      kind: 'planned_spend', title: '自己安排的晚餐', categoryCode: null,
      plannedOn: today, userEstimatedAmountMinor: 8000, priority: 'adjustable',
      changeReason: '本月自定义日常花费',
    });
    assert.equal(custom.item.linkedQuote, null);
    assert.equal(custom.item.userEstimatedAmountMinor, 8000);
    assert.equal(custom.basis.periodVersion, 2);
    assert.equal(custom.basis.adjustablePlannedMinor, 8000);
    await assert.rejects(() => cancelBudgetItem(client, randomUUID(), {
      periodId, itemId: custom.item.itemId, expectedPeriodVersion: 2, reason: '其他用户不可取消',
    }), (error: unknown) => error instanceof AppError && error.code === 'RESOURCE_FORBIDDEN');
    await assert.rejects(() => applyBudgetItemChange(client, owner.id, {
      periodId, itemId: null, expectedPeriodVersion: 1,
      kind: 'planned_spend', title: '重复提交', categoryCode: null,
      plannedOn: today, userEstimatedAmountMinor: 8000, priority: 'adjustable',
      changeReason: '使用过期的周期版本',
    }), (error: unknown) => error instanceof AppError && error.code === 'VERSION_CONFLICT');
    await assert.rejects(() => applyBudgetItemChange(client, owner.id, {
      periodId, itemId: null, expectedPeriodVersion: 2,
      kind: 'planned_spend', title: '跨月安排', categoryCode: null,
      plannedOn: '2027-01-01', userEstimatedAmountMinor: 8000, priority: 'adjustable',
      changeReason: '不能跨月写入当前周期',
    }), (error: unknown) => error instanceof AppError && error.code === 'VALIDATION_ERROR');

    const active = await activateBudgetPeriod(client, owner.id, periodId, {
      expectedFinancialVersion: newFinancialVersion, expectedPeriodVersion: 2,
      confirmedNecessities: true,
    });
    assert.equal(active.period.status, 'active');
    assert.equal(active.period.necessitiesConfirmed, true);
    assert.equal(active.period.periodVersion, 3);
    assert.equal(active.basis.basisSnapshotId, snapshotId);
    assert.notEqual(active.forecast.status, 'unknown');
    const changed = await changeSavingsTarget(client, owner.id, periodId, {
      newTargetMinor: 60000, expectedPeriodVersion: 3,
      reason: '本人确认提高储蓄目标', confirmedByUser: true,
    });
    assert.ok(changed.targetChangeId);
    assert.equal(changed.period.periodVersion, 4);
    const audit = (await client.query<{ previous_target_minor: string; new_target_minor: string; confirmed_by: string }>(
      'SELECT previous_target_minor,new_target_minor,confirmed_by FROM budget_target_changes WHERE id=$1',
      [changed.targetChangeId],
    )).rows[0];
    assert.equal(Number(audit.previous_target_minor), 50000);
    assert.equal(Number(audit.new_target_minor), 60000);
    assert.equal(audit.confirmed_by, owner.id);
    const cancelled = await cancelBudgetItem(client, owner.id, {
      periodId, itemId: custom.item.itemId, expectedPeriodVersion: 4, reason: '用户取消这次晚餐',
    });
    assert.equal(cancelled.item.status, 'cancelled');
    assert.equal(cancelled.basis.periodVersion, 5);
    const repeated = await cancelBudgetItem(client, owner.id, {
      periodId, itemId: custom.item.itemId, expectedPeriodVersion: 5, reason: '用户确认已取消',
    });
    assert.equal(repeated.basis.periodVersion, 5);
    assert.equal((await readBudgetPeriod(client, owner.id, periodId)).items.length, 1);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await closePool();
  }
});
