import { randomUUID } from 'node:crypto';
import { Agent, type StreamFn } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { offerSearchInput, planningDraftInput } from '@xingzhi/contracts';
import { z } from 'zod';
import type { AuthUser } from '../auth/session.js';
import { query, transaction } from '../db/client.js';
import { createPlanningDraft } from '../routes/planning-drafts.js';
import { budgetPlanningDraftPort } from './budget-planning-draft-port.js';
import { readBudgetPeriod } from './budget-periods.js';
import { consumerPlanningAgentTools } from './consumer-planning-tools.js';
import { AppError, notFound } from './errors.js';
import { reserveModelCost, settleModelCost } from './model-budget.js';
import { deepseekPricing, modelCostMicros } from './model-pricing.js';
import { modelRetryFetch } from './model-retry.js';

async function assertConsumerRunActive(runId: string) {
  if (!(await query(`SELECT 1 FROM agent_runs WHERE id=$1 AND workflow='consumer_planning'
    AND state='RUNNING' AND deadline>now()`, [runId])).rowCount) {
    throw new AppError(409, 'AGENT_RUN_STOPPED', '运行已结束或取消。');
  }
}

export async function startConsumerAgentRun(user: AuthUser, key: string, input: {
  message: string; periodId: string | null;
}) {
  return transaction(async (client) => {
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
    let snapshotVersion = 0;
    if (input.periodId) {
      const period = (await client.query<{ version: number }>(`SELECT version FROM budget_periods
        WHERE id=$1 AND owner_id=$2`, [input.periodId, user.id])).rows[0];
      if (!period) throw new AppError(404, 'RESOURCE_FORBIDDEN', '未找到本人的预算周期。');
      snapshotVersion = Number(period.version);
    }
    const existing = (await client.query<{ id: string; input: string; budgetPeriodId: string | null }>(`SELECT
        id,input,budget_period_id AS "budgetPeriodId" FROM agent_runs
      WHERE owner_id=$1 AND trigger_key=$2 AND workflow='consumer_planning'`, [user.id, key])).rows[0];
    if (existing) {
      if (existing.input !== input.message || existing.budgetPeriodId !== input.periodId) {
        throw new AppError(409, 'IDEMPOTENCY_CONFLICT', '同一请求标识不能用于不同的规划消息。');
      }
      return { runId: existing.id, reused: true };
    }
    await client.query(`UPDATE agent_runs SET state='FAILED',error_code='RUN_EXPIRED',finished_at=now()
      WHERE owner_id=$1 AND workflow='consumer_planning' AND state='RUNNING' AND deadline<=now()`, [user.id]);
    if ((await client.query(`SELECT 1 FROM agent_runs WHERE owner_id=$1
      AND workflow='consumer_planning' AND state='RUNNING'`, [user.id])).rowCount) {
      throw new AppError(409, 'AGENT_RUN_ACTIVE', '已有规划助手运行，请等待或取消。');
    }
    await client.query('INSERT INTO agent_rate_limits(owner_id,tokens) VALUES($1,2) ON CONFLICT DO NOTHING', [user.id]);
    const rate = (await client.query<{ available: number }>(`SELECT
        LEAST(2,tokens+GREATEST(0,EXTRACT(EPOCH FROM (clock_timestamp()-updated_at)))/6) AS available
      FROM agent_rate_limits WHERE owner_id=$1 FOR UPDATE`, [user.id])).rows[0]!;
    if (rate.available < 1) throw new AppError(429, 'AGENT_RATE_LIMIT', '请求过于频繁，请稍后重试。');
    await client.query('UPDATE agent_rate_limits SET tokens=$2,updated_at=clock_timestamp() WHERE owner_id=$1',
      [user.id, rate.available - 1]);
    const runId = randomUUID();
    await client.query(`INSERT INTO agent_runs
        (id,plan_id,budget_period_id,workflow,owner_id,trigger_key,input,snapshot_version,state)
      VALUES($1,NULL,$2,'consumer_planning',$3,$4,$5,$6,'RUNNING')`,
    [runId, input.periodId, user.id, key, input.message, snapshotVersion]);
    if (input.periodId) await client.query(`INSERT INTO budget_events
        (owner_id,period_id,actor_id,type,data) VALUES($1,$2,$1,'agent_run_started',$3)`,
      [user.id, input.periodId, { runId }]);
    return { runId, reused: false };
  });
}

export async function readConsumerAgentRun(user: AuthUser, runId: string) {
  await query(`UPDATE agent_runs SET state='FAILED',error_code='RUN_EXPIRED',finished_at=now()
    WHERE id=$1 AND owner_id=$2 AND workflow='consumer_planning'
      AND state='RUNNING' AND deadline<=now()`, [runId, user.id]);
  const row = (await query<{
    id: string; budgetPeriodId: string | null; state: string; output: string;
    errorCode: string | null; modelCalls: number; toolCalls: number;
    createdAt: Date; finishedAt: Date | null;
  }>(`SELECT id,budget_period_id AS "budgetPeriodId",state,output,
      error_code AS "errorCode",model_calls AS "modelCalls",tool_calls AS "toolCalls",
      created_at AS "createdAt",finished_at AS "finishedAt"
    FROM agent_runs WHERE id=$1 AND owner_id=$2 AND workflow='consumer_planning'`,
  [runId, user.id])).rows[0];
  if (!row) notFound('未找到规划助手运行。');
  return { ...row, createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null };
}

export async function cancelConsumerAgentRun(user: AuthUser, runId: string) {
  await query(`UPDATE agent_runs SET state='CANCELLED',finished_at=now()
    WHERE id=$1 AND owner_id=$2 AND workflow='consumer_planning' AND state='RUNNING'`,
  [runId, user.id]);
  return readConsumerAgentRun(user, runId);
}

export async function executeConsumerAgentRun(runId: string, user: AuthUser,
  message: string, periodId: string | null, signal: AbortSignal,
  injectedStream?: StreamFn, injectedFetch?: typeof fetch) {
  const model: Model<'openai-completions'> = {
    id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', provider: 'deepseek',
    api: 'openai-completions', baseUrl: 'https://api.deepseek.com', reasoning: false,
    input: ['text'], contextWindow: 1_000_000, maxTokens: 1024,
    cost: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  };
  let modelCalls = 0;
  let toolCalls = 0;
  let pendingCall: string | undefined;
  let settlement = Promise.resolve();
  let modelFailed = false;
  const abort = new AbortController();
  const combined = AbortSignal.any([signal, abort.signal, AbortSignal.timeout(120_000)]);
  const ensureActive = async () => { combined.throwIfAborted(); await assertConsumerRunActive(runId); };
  const reserveAttempt = async () => {
    await ensureActive();
    if (modelCalls >= 8) throw new Error('模型调用次数达到上限。');
    modelCalls++;
    const callId = randomUUID();
    await transaction(async (client) => {
      await reserveModelCost(client, callId, `consumer_agent_run:${runId}:${modelCalls}`,
        modelCostMicros({ input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 1024 }));
      await client.query('UPDATE agent_runs SET model_calls=$2 WHERE id=$1', [runId, modelCalls]);
    });
    pendingCall = callId;
  };
  const tools = consumerPlanningAgentTools({
    read_budget_basis: async (raw) => {
      await ensureActive();
      if (++toolCalls > 20) throw new Error('工具次数达到上限。');
      const requested = z.object({ periodId: z.string().uuid() }).strict().parse(raw).periodId;
      if (!periodId || requested !== periodId) throw new AppError(403, 'RESOURCE_FORBIDDEN', '只能读取本次运行绑定的预算周期。');
      await query('UPDATE agent_runs SET tool_calls=$2 WHERE id=$1', [runId, toolCalls]);
      return transaction((client) => readBudgetPeriod(client, user.id, periodId));
    },
    search_offers: async (raw) => {
      await ensureActive();
      if (++toolCalls > 20) throw new Error('工具次数达到上限。');
      const args = offerSearchInput.parse(raw);
      await query('UPDATE agent_runs SET tool_calls=$2 WHERE id=$1', [runId, toolCalls]);
      const result = await query(`SELECT id,code,name,description,category_code AS "categoryCode",
          location_label AS "locationLabel",tags,purchase_mode AS "purchaseMode",
          price_minor AS "displayPriceMinor",currency,rule_label AS "ruleLabel"
        FROM catalog_items WHERE active AND currency='CNY'
          AND (available_from IS NULL OR available_from<=$1::date)
          AND (available_to IS NULL OR available_to>=$1::date)
          AND ($2::text IS NULL OR category_code=$2) ORDER BY code LIMIT 20`,
      [args.plannedOn, args.categoryCode ?? null]);
      return { items: result.rows, source: 'bank_registered_demo_catalog' };
    },
    save_planning_draft: async (raw) => {
      await ensureActive();
      if (++toolCalls > 20) throw new Error('工具次数达到上限。');
      const input = planningDraftInput.parse(raw);
      if (input.periodId !== periodId) {
        throw new AppError(409, 'CONFIRMATION_SCOPE_MISMATCH', '草稿范围必须与本次运行一致。');
      }
      await query('UPDATE agent_runs SET tool_calls=$2 WHERE id=$1', [runId, toolCalls]);
      return transaction((client) => createPlanningDraft(client, budgetPlanningDraftPort, user.id, input));
    },
  });
  const agent = new Agent({ initialState: { model, systemPrompt:
    `你是行止银行消费规划助手。只依据工具返回的本人预算和银行平台登记商品回答。
用户明确给出的需求可保存为待确认草稿；缺失日期、金额或优先级必须保留为空，不得自行补写。
你可以读取预算、搜索登记商品、保存非执行草稿。你不能选择商品、修改正式预算或储蓄目标、确认购买、创建订单、支付、取消或退款。
金额字段以分计，展示为元时除以100。不要展示内部标识、密钥、模型推理过程或不必要的逐笔流水。`,
    tools }, toolExecution: 'sequential',
    streamFn: async (_model, context, options) => {
      await settlement;
      await reserveAttempt();
      if (injectedStream) return injectedStream(model, context, { ...options, signal: combined });
      return streamSimple(model, context, { ...options, apiKey: process.env.DEEPSEEK_API_KEY,
        maxTokens: 1024, maxRetries: 0, signal: combined, timeoutMs: 120_000,
        fetch: modelRetryFetch({ signal: combined, beforeRetry: reserveAttempt, fetch: injectedFetch }),
        onPayload: payload => ({ ...payload as Record<string, unknown>, thinking: { type: 'disabled' } }) });
    } });
  agent.subscribe((event) => {
    if (event.type !== 'message_end' || event.message.role !== 'assistant') return;
    const { usage, stopReason } = event.message;
    if (stopReason === 'error' || stopReason === 'aborted') modelFailed = true;
    if (pendingCall && usage.totalTokens > 0) {
      const callId = pendingCall;
      const { cost: _cost, ...tokens } = usage;
      settlement = transaction((client) => settleModelCost(client, callId,
        modelCostMicros({ input: usage.input, cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite, output: usage.output }),
        { ...tokens, pricing: deepseekPricing }))
        .then(() => { pendingCall = undefined; })
        .catch(() => { modelFailed = true; });
    }
  });
  const onAbort = () => agent.abort();
  combined.addEventListener('abort', onAbort, { once: true });
  try {
    await agent.prompt(message);
    await settlement;
    await ensureActive();
    if (modelFailed || pendingCall || agent.state.errorMessage) throw new Error('模型调用未完成。');
    const last = [...agent.state.messages].reverse().find((item) => item.role === 'assistant');
    const output = last?.role === 'assistant'
      ? last.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n') : '';
    if (!output) throw new Error('模型没有返回可显示回答。');
    await transaction(async (client) => {
      await client.query(`UPDATE agent_runs SET state='COMPLETED',output=$2,finished_at=now()
        WHERE id=$1 AND state='RUNNING'`, [runId, output.slice(0, 16000)]);
      if (periodId) await client.query(`INSERT INTO budget_events
          (owner_id,period_id,actor_id,type,data) VALUES($1,$2,NULL,'agent_run_completed',$3)`,
        [user.id, periodId, { runId, toolCalls }]);
    });
  } catch {
    await query(`UPDATE agent_runs SET state='FAILED',error_code=$2,finished_at=now()
      WHERE id=$1 AND state='RUNNING'`, [runId, combined.aborted ? 'RUN_INTERRUPTED' : 'MODEL_UNAVAILABLE']);
  } finally {
    combined.removeEventListener('abort', onAbort);
  }
}
