import { processChannelJob } from './channel-worker.js';
import { config } from '../config.js';
import type { PoolClient } from 'pg';
import { transaction } from '../db/client.js';
import { appendEvent } from './events.js';
import { ensureManualTask } from './aftercare.js';
import { randomUUID } from 'node:crypto';
import { applyVerifiedMoneyEvent } from './verified-money-event.js';

export type ClaimedJob = {
  job_id: string;
  operation_id: string;
  type: 'simulate_payment' | 'simulate_close' | 'simulate_refund' | 'simulate_refund_batch' | 'sandbox_close' | 'sandbox_refund' | 'sandbox_payment_recheck' | 'sandbox_refund_recheck';
  entity_id: string;
  plan_id: string | null;
  budget_period_id: string | null;
  owner_id: string;
  job_lease_version: number;
  operation_lease_version: number;
};

export async function claimNextJob(): Promise<ClaimedJob | undefined> {
  return transaction(async (client) => {
    const candidate = await client.query<ClaimedJob>(`
      SELECT jobs.id AS job_id, operations.id AS operation_id, operations.type,
        operations.entity_id, operations.plan_id, operations.budget_period_id, operations.owner_id
      FROM jobs JOIN operations ON operations.id = jobs.operation_id
      WHERE ((jobs.state = 'pending' AND jobs.next_run_at <= now())
         OR (jobs.state = 'leased' AND jobs.lease_until < now()))
        AND operations.state IN ('accepted', 'processing', 'unknown')
        AND (($1 = 'simulation' AND operations.type LIKE 'simulate_%')
          OR ($1 = 'sandbox' AND operations.type LIKE 'sandbox_%'))
      ORDER BY jobs.next_run_at, jobs.created_at
      FOR UPDATE OF jobs SKIP LOCKED
      LIMIT 1
    `, [config.paymentMode]);
    const job = candidate.rows[0];
    if (!job) return;
    const jobLease = await client.query<{ lease_version: number }>(
      `UPDATE jobs SET state = 'leased', lease_until = now() + interval '60 seconds', lease_version = lease_version + 1, updated_at = now()
       WHERE id = $1 RETURNING lease_version`,
      [job.job_id],
    );
    const operationLease = await client.query<{ lease_version: number }>(
      `UPDATE operations SET state = 'processing', lease_until = now() + interval '60 seconds', lease_version = lease_version + 1,
       attempt_count = attempt_count + 1, updated_at = now() WHERE id = $1 RETURNING lease_version`,
      [job.operation_id],
    );
    return {
      ...job,
      job_lease_version: jobLease.rows[0]!.lease_version,
      operation_lease_version: operationLease.rows[0]!.lease_version,
    };
  });
}

async function completeJob(
  client: PoolClient,
  job: ClaimedJob,
  state: 'succeeded' | 'unknown' | 'pending_review' | 'failed',
  result: Record<string, unknown>,
  eventType: string,
) {
  await (async () => {
    const operation = await client.query(
      'UPDATE operations SET state = $2, result = $3, lease_until = NULL, updated_at = now() WHERE id = $1 AND lease_version = $4 RETURNING id',
      [job.operation_id, state, result, job.operation_lease_version],
    );
    if (!operation.rowCount) throw new Error('任务领取版本已失效。');
    const completedJob = await client.query(
      "UPDATE jobs SET state = 'complete', lease_until = NULL, updated_at = now() WHERE id = $1 AND lease_version = $2 RETURNING id",
      [job.job_id, job.job_lease_version],
    );
    if (!completedJob.rowCount) throw new Error('任务租约已被其他执行者接管。');
    if (job.plan_id) {
      await appendEvent(client, job.plan_id, null, eventType, { operationId: job.operation_id, ...result });
    } else if (job.budget_period_id) {
      await client.query(`INSERT INTO budget_events (owner_id,period_id,actor_id,type,data)
        VALUES($1,$2,NULL,$3,$4)`, [job.owner_id, job.budget_period_id, eventType,
        { operationId: job.operation_id, ...result }]);
    }
  })();
}

async function processPayment(client: PoolClient, job: ClaimedJob) {
  const outcome = await (async () => {
    const result = await client.query<{ id: string; simulation_mode: 'SUCCESS' | 'PENDING' | 'UNKNOWN'; payment_status: string }>(
      'SELECT id, simulation_mode, payment_status FROM orders WHERE id = $1 FOR UPDATE', [job.entity_id],
    );
    const order = result.rows[0];
    if (!order || order.payment_status !== 'pending') {
      return { state: 'failed' as const, result: { reason: '订单不再处于可模拟付款状态' }, eventType: 'simulation.payment_skipped' };
    }
    if (order.simulation_mode === 'SUCCESS') {
      await client.query("UPDATE orders SET payment_status = 'paid', status = 'fulfilling', updated_at = now() WHERE id = $1", [order.id]);
      await client.query("UPDATE payment_attempts SET status = 'paid', sent_at = COALESCE(sent_at, now()), observed_at = now() WHERE order_id = $1", [order.id]);
      if (job.budget_period_id) {
        const scope = (await client.query<{ accountId: string; amountMinor: number; itemName: string }>(`SELECT
            p.primary_account_id AS "accountId",o.amount_minor AS "amountMinor",o.item_name AS "itemName"
          FROM orders o JOIN budget_periods p ON p.id=o.budget_period_id
          WHERE o.id=$1 AND o.owner_id=$2 AND o.budget_period_id=$3`,
        [order.id, job.owner_id, job.budget_period_id])).rows[0];
        if (!scope) throw new Error('新消费者模拟订单缺少原预算和账户范围。');
        const ledgerId = randomUUID();
        const occurredAt = new Date();
        await client.query(`INSERT INTO finance_ledger_entries
            (id,owner_id,account_id,source,source_ref,direction,amount_minor,
              occurred_at,posted_at,status,category,merchant_name,note,order_id,dedupe_key)
          VALUES($1,$2,$3,'demo',$4,'outflow',$5,$6,$6,'posted','purchase',$7,
            '受控模拟支付到账',$8,$9)`, [ledgerId, job.owner_id, scope.accountId,
          `SIM_PAYMENT_${job.operation_id}`, scope.amountMinor, occurredAt, scope.itemName,
          order.id, `simulation-payment:${job.operation_id}`]);
        await applyVerifiedMoneyEvent(client, job.owner_id, {
          orderId: order.id,
          provider: 'simulation',
          providerEventId: `SIM_POSTED_${job.operation_id}`,
          eventType: 'payment_posted',
          amountMinor: scope.amountMinor,
          currency: 'CNY',
          occurredAt: occurredAt.toISOString(),
          verificationState: 'verified',
          source: 'demo',
        }, { appliedLedgerEntryId: ledgerId }, occurredAt);
      }
      return {
        state: 'succeeded' as const,
        result: { source: 'simulation', paymentStatus: 'paid', observedAt: new Date().toISOString() },
        eventType: 'simulation.payment_confirmed',
      };
    }
    const state = order.simulation_mode === 'PENDING' ? 'pending_review' as const : 'unknown' as const;
    await client.query('UPDATE orders SET payment_status = $2, updated_at = now() WHERE id = $1', [order.id, order.simulation_mode === 'UNKNOWN' ? 'unknown' : 'pending']);
    await client.query('UPDATE payment_attempts SET status = $2, sent_at = COALESCE(sent_at, now()), observed_at = now() WHERE order_id = $1', [order.id, order.simulation_mode === 'UNKNOWN' ? 'unknown' : 'pending']);
    return {
      state,
      result: { source: 'simulation', paymentStatus: order.simulation_mode.toLowerCase(), nextAction: '等待后续核对，不释放预算占用。' },
      eventType: 'simulation.payment_pending',
    };
  })();
  return completeJob(client, job, outcome.state, outcome.result, outcome.eventType);
}

async function processClose(client: PoolClient, job: ClaimedJob) {
  const outcome = await (async () => {
    const result = await client.query<{ id: string; close_simulation_mode: 'SUCCESS' | 'PENDING' | 'UNKNOWN'; payment_status: string }>(
      'SELECT id, close_simulation_mode, payment_status FROM orders WHERE id = $1 FOR UPDATE', [job.entity_id],
    );
    const order = result.rows[0];
    if (!order || order.payment_status !== 'pending') {
      return { state: 'failed' as const, result: { reason: '仅待付款订单可按此模拟关单。' }, eventType: 'simulation.close_skipped' };
    }
    if (order.close_simulation_mode !== 'SUCCESS') {
      const pending = order.close_simulation_mode === 'PENDING';
      return {
        state: pending ? 'pending_review' as const : 'unknown' as const,
        result: {
          source: 'simulation',
          closeStatus: order.close_simulation_mode.toLowerCase(),
          nextAction: pending ? '关单尚未完成，继续保留预算占用。' : '关单结果未知，需要后续核对。',
        },
        eventType: pending ? 'simulation.close_pending' : 'simulation.close_unknown',
      };
    }
    await client.query("UPDATE orders SET payment_status = 'closed', status = 'cancelled', reserved_minor = 0, updated_at = now() WHERE id = $1", [order.id]);
    await client.query("UPDATE payment_attempts SET status = 'closed', observed_at = now() WHERE order_id = $1", [order.id]);
    return { state: 'succeeded' as const, result: { source: 'simulation', paymentStatus: 'closed' }, eventType: 'simulation.close_confirmed' };
  })();
  return completeJob(client, job, outcome.state, outcome.result, outcome.eventType);
}

async function processRefund(client: PoolClient, job: ClaimedJob) {
  if (!job.plan_id) throw new Error('历史退款任务缺少旧计划范围。');
  const result = await client.query<{ order_id: string; merchant_id: string }>(`
    SELECT cancellation_requests.order_id, orders.merchant_id FROM cancellation_requests
    JOIN orders ON orders.id=cancellation_requests.order_id WHERE cancellation_requests.id=$1`, [job.entity_id]);
  const request = result.rows[0];
  if (!request) throw new Error('历史退款任务缺少原订单。');
  const task = await ensureManualTask(client, {
    dedupeKey: `legacy-refund-review:${job.entity_id}`, planId: job.plan_id, merchantId: request.merchant_id,
    orderId: request.order_id, cancellationRequestId: job.entity_id, operationId: job.operation_id,
    type: 'cancellation_follow_up', reason: '历史退款任务尚未绑定受控退款批次。',
    nextAction: '由商户核对原取消申请并通过固定批次入口处理，不直接改写退款金额。',
  });
  return completeJob(client, job, 'pending_review', { source: 'simulation', manualTaskId: task.id }, 'simulation.refund_requires_review');
}

async function processRefundBatch(client: PoolClient, job: ClaimedJob) {
  const outcome = await (async () => {
    const result = await client.query<{
      id: string; cancellation_request_id: string; order_id: string; merchant_id: string; amount_minor: number; status: string;
      environment: string; order_amount_minor: number; refund_simulation_mode: 'SUCCESS' | 'PENDING' | 'UNKNOWN'; payment_status: string; refunded_minor: number;
      cancellation_status: string; accepted_refund_minor: number; budget_adjustment_id: string | null;
    }>(`
      SELECT refund_batches.id, refund_batches.cancellation_request_id, refund_batches.order_id, refund_batches.merchant_id,
        refund_batches.amount_minor, refund_batches.status, refund_batches.environment,
        orders.amount_minor AS order_amount_minor, orders.refund_simulation_mode, orders.payment_status, orders.refunded_minor,
        cancellation_requests.status AS cancellation_status, cancellation_requests.accepted_refund_minor,
        cancellation_requests.budget_adjustment_id
      FROM refund_batches
      JOIN cancellation_requests ON cancellation_requests.id = refund_batches.cancellation_request_id
      JOIN orders ON orders.id = refund_batches.order_id
      WHERE refund_batches.id = $1 FOR UPDATE OF refund_batches, cancellation_requests, orders
    `, [job.entity_id]);
    const batch = result.rows[0];
    if (!batch) return { state: 'failed' as const, result: { reason: '退款批次不存在。' }, eventType: 'simulation.refund_batch_skipped' };
    if (batch.status === 'succeeded') {
      return { state: 'succeeded' as const, result: { source: 'simulation', refundedMinor: batch.amount_minor, reused: true }, eventType: 'simulation.refund_batch_reused' };
    }
    if (!['approved', 'refund_processing'].includes(batch.cancellation_status) || batch.payment_status !== 'paid') {
      await client.query("UPDATE refund_batches SET status = 'failed', updated_at = now() WHERE id = $1", [batch.id]);
      await client.query("UPDATE cancellation_requests SET status = 'pending_review', updated_at = now() WHERE id = $1", [batch.cancellation_request_id]);
      const task = await ensureManualTask(client, {
        dedupeKey: `refund-recheck:${batch.id}`,
        ...(job.plan_id ? { planId: job.plan_id, merchantId: batch.merchant_id }
          : { budgetPeriodId: job.budget_period_id!, responsibleProvider: 'simulation' }),
        orderId: batch.order_id, cancellationRequestId: batch.cancellation_request_id, refundBatchId: batch.id,
        operationId: job.operation_id, type: 'refund_recheck', reason: '退款批次与原订单当前状态不一致。',
        nextAction: '核对原订单付款状态和已确认的取消申请，不得新增退款号替代原批次。',
      });
      return {
        state: 'pending_review' as const,
        result: { source: 'simulation', manualTaskId: task.id, nextAction: '等待商户复核原订单与退款批次。' },
        eventType: 'simulation.refund_batch_inconsistent',
      };
    }
    if (batch.environment !== 'simulation') {
      return { state: 'failed' as const, result: { reason: '该退款批次不属于本地模拟环境。' }, eventType: 'simulation.refund_batch_skipped' };
    }

    await client.query("UPDATE refund_batches SET status = 'processing', updated_at = now() WHERE id = $1", [batch.id]);
    if (batch.refund_simulation_mode !== 'SUCCESS') {
      const state = batch.refund_simulation_mode === 'PENDING' ? 'pending_review' as const : 'unknown' as const;
      const batchState = batch.refund_simulation_mode === 'PENDING' ? 'pending_review' : 'unknown';
      await client.query('UPDATE refund_batches SET status = $2, updated_at = now() WHERE id = $1', [batch.id, batchState]);
      await client.query("UPDATE cancellation_requests SET status = 'pending_review', updated_at = now() WHERE id = $1", [batch.cancellation_request_id]);
      const task = await ensureManualTask(client, {
        dedupeKey: `refund-recheck:${batch.id}`,
        ...(job.plan_id ? { planId: job.plan_id, merchantId: batch.merchant_id }
          : { budgetPeriodId: job.budget_period_id!, responsibleProvider: 'simulation' }),
        orderId: batch.order_id, cancellationRequestId: batch.cancellation_request_id, refundBatchId: batch.id,
        operationId: job.operation_id, type: 'refund_recheck', reason: '本地模拟退款结果未形成明确成功事实。',
        nextAction: '按原退款业务编号复核结果；未知时保留退款占用，不得新建替代批次。',
      });
      return {
        state,
        result: { source: 'simulation', manualTaskId: task.id, nextAction: '退款结果待核对，金额仍保留未决。' },
        eventType: 'simulation.refund_batch_pending',
      };
    }

    if (batch.refunded_minor + batch.amount_minor > batch.order_amount_minor) {
      throw new Error('退款批次将超过原订单可退金额。');
    }
    await client.query("UPDATE refund_batches SET status = 'succeeded', updated_at = now() WHERE id = $1", [batch.id]);
    const refunded = await client.query<{ total_minor: number }>(`
      SELECT COALESCE(SUM(amount_minor) FILTER (WHERE status = 'succeeded'), 0)::integer AS total_minor
      FROM refund_batches WHERE cancellation_request_id = $1
    `, [batch.cancellation_request_id]);
    const refundedMinor = refunded.rows[0]!.total_minor;
    if (refundedMinor > batch.accepted_refund_minor) throw new Error('已成功退款超过取消申请确认总额。');
    const completed = refundedMinor === batch.accepted_refund_minor;
    await client.query(`UPDATE cancellation_requests SET status = $2, updated_at = now() WHERE id = $1`, [
      batch.cancellation_request_id, completed ? 'completed' : 'refund_processing',
    ]);
    await client.query(`UPDATE orders
      SET refunded_minor = refunded_minor + $2, status = $3, updated_at = now() WHERE id = $1`, [
      batch.order_id, batch.amount_minor, completed ? 'cancelled' : 'cancellation_processing',
    ]);
    if (job.budget_period_id) {
      const scope = (await client.query<{ accountId: string }>(`SELECT
          p.primary_account_id AS "accountId"
        FROM budget_periods p JOIN finance_accounts a ON a.id=p.primary_account_id
        WHERE p.id=$1 AND p.owner_id=$2 AND a.source='demo'`,
      [job.budget_period_id, job.owner_id])).rows[0];
      if (!scope) throw new Error('新消费者模拟退款缺少 Demo 账户范围。');
      const occurredAt = new Date();
      await applyVerifiedMoneyEvent(client, job.owner_id, {
        orderId: batch.order_id,
        provider: 'simulation',
        providerEventId: `SIM_REFUND_VERIFIED_${job.operation_id}`,
        eventType: 'refund_verified',
        amountMinor: batch.amount_minor,
        currency: 'CNY',
        occurredAt: occurredAt.toISOString(),
        verificationState: 'verified',
        source: 'demo',
      }, {}, occurredAt);
      const ledgerId = randomUUID();
      await client.query(`INSERT INTO finance_ledger_entries
          (id,owner_id,account_id,source,source_ref,direction,amount_minor,
            occurred_at,posted_at,status,category,note,order_id,dedupe_key)
        VALUES($1,$2,$3,'demo',$4,'inflow',$5,$6,$6,'posted','refund',
          '受控模拟退款到账',$7,$8)`, [ledgerId, job.owner_id, scope.accountId,
        `SIM_REFUND_${job.operation_id}`, batch.amount_minor, occurredAt, batch.order_id,
        `simulation-refund:${job.operation_id}`]);
      await applyVerifiedMoneyEvent(client, job.owner_id, {
        orderId: batch.order_id,
        provider: 'simulation',
        providerEventId: `SIM_REFUND_POSTED_${job.operation_id}`,
        eventType: 'refund_posted',
        amountMinor: batch.amount_minor,
        currency: 'CNY',
        occurredAt: occurredAt.toISOString(),
        verificationState: 'verified',
        source: 'demo',
      }, { appliedLedgerEntryId: ledgerId }, occurredAt);
      if (completed && batch.budget_adjustment_id) {
        const unresolved = await client.query(`SELECT 1 FROM cancellation_requests
          WHERE budget_adjustment_id=$1 AND status NOT IN ('completed','rejected') LIMIT 1`,
        [batch.budget_adjustment_id]);
        if (!unresolved.rowCount) {
          await client.query(`UPDATE budget_adjustment_proposals SET status='complete'
            WHERE id=$1 AND status IN ('executing','pending_review')`, [batch.budget_adjustment_id]);
        }
      }
    }
    return {
      state: 'succeeded' as const,
      result: { source: 'simulation', refundedMinor: batch.amount_minor, totalRefundedMinor: refundedMinor, completed },
      eventType: 'simulation.refund_batch_confirmed',
    };
  })();
  return completeJob(client, job, outcome.state, outcome.result, outcome.eventType);
}

export async function processClaimedJob(job: ClaimedJob): Promise<boolean> {
  if (job.type.startsWith('sandbox_')) return processChannelJob(job);
  return transaction(async (client) => {
    // Hold the claim through every business write and the final event commit.
    if (job.plan_id) {
      await client.query('SELECT id FROM plans WHERE id = $1 FOR UPDATE', [job.plan_id]);
    } else if (job.budget_period_id) {
      await client.query(`SELECT a.id FROM budget_periods p
        JOIN finance_accounts a ON a.id=p.primary_account_id
        WHERE p.id=$1 AND p.owner_id=$2 FOR UPDATE OF a,p`,
      [job.budget_period_id, job.owner_id]);
    } else {
      throw new Error('后台任务缺少业务范围。');
    }
    const lease = await client.query(`SELECT jobs.id FROM jobs JOIN operations ON operations.id = jobs.operation_id
      WHERE jobs.id = $1 AND operations.id = $2 AND jobs.state = 'leased'
        AND jobs.lease_version = $3 AND operations.lease_version = $4
        AND jobs.lease_until > now() AND operations.state = 'processing'
      FOR UPDATE OF jobs, operations`,
    [job.job_id, job.operation_id, job.job_lease_version, job.operation_lease_version]);
    if (!lease.rowCount) return false;
    const related = await client.query<{ environment: string; provider: string;
      plan_id: string | null; budget_period_id: string | null }>(`
      SELECT orders.environment, orders.provider, orders.plan_id,orders.budget_period_id FROM orders WHERE orders.id = $1
        AND $2 IN ('simulate_payment', 'simulate_close')
      UNION ALL
      SELECT orders.environment, orders.provider, orders.plan_id,orders.budget_period_id FROM cancellation_requests
        JOIN orders ON orders.id = cancellation_requests.order_id
        WHERE cancellation_requests.id = $1 AND $2 = 'simulate_refund'
      UNION ALL
      SELECT CASE WHEN refund_batches.environment = orders.environment THEN orders.environment ELSE 'invalid' END,
        CASE WHEN refund_batches.provider = orders.provider THEN orders.provider ELSE 'invalid' END,
        orders.plan_id,orders.budget_period_id
        FROM refund_batches JOIN orders ON orders.id = refund_batches.order_id
        WHERE refund_batches.id = $1 AND $2 = 'simulate_refund_batch'`, [job.entity_id, job.type]);
    const order = related.rows[0];
    if (!order || order.environment !== 'simulation' || order.provider !== 'simulation'
      || order.plan_id !== job.plan_id || order.budget_period_id !== job.budget_period_id) {
      await completeJob(client, job, 'failed', { reason: '模拟任务与订单环境或归属不一致，未修改交易事实。' }, 'operation.environment_rejected');
      return true;
    }
    if (job.type === 'simulate_payment') await processPayment(client, job);
    else if (job.type === 'simulate_close') await processClose(client, job);
    else if (job.type === 'simulate_refund') await processRefund(client, job);
    else if (job.type === 'simulate_refund_batch') await processRefundBatch(client, job);
    else throw new Error('不支持的后台任务类型。');
    return true;
  });
}

export async function tick() {
  const job = await claimNextJob();
  if (job) await processClaimedJob(job);
}
