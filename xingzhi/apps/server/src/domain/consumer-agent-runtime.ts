import { randomUUID } from 'node:crypto';
import { Agent, type StreamFn } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { offerSearchInput, planningDraftInput, planningDraftItem } from '@xingzhi/contracts';
import { z } from 'zod';
import type { AuthUser } from '../auth/session.js';
import { query, transaction } from '../db/client.js';
import { createPlanningDraft } from '../routes/planning-drafts.js';
import { describeBudget, describeDraft, describeDraftImpact, displayMoney, groundedAgentResponse, type AdjustableImpact } from './consumer-agent-response.js';
import { readBudgetPeriod } from './budget-periods.js';
import { forecastBudgetCashflow } from './budget-cashflow.js';
import { consumerPlanningAgentTools } from './consumer-planning-tools.js';
import { AppError, notFound } from './errors.js';
import { reserveModelCost, settleModelCost } from './model-budget.js';
import { deepseekPricing, modelCostMicros } from './model-pricing.js';
import { modelRetryFetch } from './model-retry.js';

function explicitlyStatedAmount(message: string, minor: number) {
  const amount = minor / 100;
  const variants = [String(amount), amount.toFixed(2)].map(value => value.replace('.', '\\.'));
  return new RegExp(`(?:[¥￥]\\s*(?:${variants.join('|')})(?![\\d.])|(?:${variants.join('|')})\\s*(?:元|块))`).test(message);
}

export function constrainAgentDraftToMessage(items: z.infer<typeof planningDraftItem>[], message: string) {
  return items.map((item) => {
    const date = item.plannedOn;
    const explicitDate = items.length === 1 && date !== null && (message.includes(date)
      || message.includes(`${date.slice(0, 4)}年${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`));
    const explicitAmount = items.length === 1 && item.userEstimatedAmountMinor !== null
      && explicitlyStatedAmount(message, item.userEstimatedAmountMinor);
    const explicitPriority = items.length === 1 && item.priority !== null
      && (item.priority === 'required' ? /必须保留|必要支出/.test(message)
        : /可调整|可以调整|可取消/.test(message));
    const suggested = (!explicitDate && date !== null)
      || (!explicitAmount && item.userEstimatedAmountMinor !== null)
      || (!explicitPriority && item.priority !== null) || item.catalogItemId !== null;
    return {
      ...item,
      plannedOn: explicitDate ? date : null,
      userEstimatedAmountMinor: explicitAmount ? item.userEstimatedAmountMinor : null,
      priority: explicitPriority ? item.priority : null,
      catalogItemId: null,
      suggestion: suggested ? {
        title: item.suggestion?.title ?? null,
        plannedOn: item.suggestion?.plannedOn ?? (!explicitDate ? date : null),
        estimatedAmountMinor: item.suggestion?.estimatedAmountMinor
          ?? (!explicitAmount ? item.userEstimatedAmountMinor : null),
        priority: item.suggestion?.priority ?? (!explicitPriority ? item.priority : null),
        catalogItemId: item.suggestion?.catalogItemId ?? item.catalogItemId,
        reason: item.suggestion?.reason ?? '行止根据对话整理的建议，尚待用户确认。',
      } : item.suggestion,
    };
  });
}

async function assertConsumerRunActive(runId: string) {
  if (!(await query(`SELECT 1 FROM agent_runs WHERE id=$1 AND workflow='consumer_planning'
    AND state='RUNNING' AND deadline>now()`, [runId])).rowCount) {
    throw new AppError(409, 'AGENT_RUN_STOPPED', '运行已结束或取消。');
  }
}

export async function startConsumerAgentRun(user: AuthUser, key: string, input: {
  message: string; periodId: string | null; ledgerMonth?: string | null;
}) {
  return transaction(async (client) => {
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
    let snapshotVersion = 0;
    let boundMonth: string | null = null;
    if (input.periodId) {
      const period = (await client.query<{ version: number; monthStart: string }>(`SELECT version,
        to_char(month_start,'YYYY-MM-DD') AS "monthStart" FROM budget_periods
        WHERE id=$1 AND owner_id=$2`, [input.periodId, user.id])).rows[0];
      if (!period) throw new AppError(404, 'RESOURCE_FORBIDDEN', '未找到本人的预算周期。');
      snapshotVersion = Number(period.version);
      boundMonth = input.ledgerMonth ?? period.monthStart.slice(0, 7);
    }
    if (input.ledgerMonth && !input.periodId) {
      throw new AppError(400, 'VALIDATION_ERROR', '月度账目提问必须绑定本人预算账户。');
    }
    const existing = (await client.query<{ id: string; input: string; budgetPeriodId: string | null;
      ledgerMonth: string | null }>(`SELECT id,input,budget_period_id AS "budgetPeriodId",
        to_char(ledger_month,'YYYY-MM') AS "ledgerMonth" FROM agent_runs
      WHERE owner_id=$1 AND trigger_key=$2 AND workflow='consumer_planning'`, [user.id, key])).rows[0];
    if (existing) {
      if (existing.input !== input.message || existing.budgetPeriodId !== input.periodId
        || (existing.ledgerMonth !== null && existing.ledgerMonth !== boundMonth)
        || (existing.ledgerMonth === null && input.ledgerMonth !== undefined && input.ledgerMonth !== null)) {
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
        (id,plan_id,budget_period_id,workflow,owner_id,trigger_key,input,snapshot_version,state,ledger_month)
      VALUES($1,NULL,$2,'consumer_planning',$3,$4,$5,$6,'RUNNING',$7::date)`,
    [runId, input.periodId, user.id, key, input.message, snapshotVersion,
      boundMonth ? `${boundMonth}-01` : null]);
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
  const artifacts = (await query<{ draftId: string }>(`SELECT draft_id AS "draftId"
    FROM consumer_agent_artifacts WHERE run_id=$1 AND owner_id=$2 ORDER BY created_at,draft_id`,
  [runId, user.id])).rows.map((item) => ({ type: 'planning_draft' as const, draftId: item.draftId }));
  return { ...row, createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null, artifacts };
}

export async function listConsumerAgentRuns(user: AuthUser, input: {
  periodId: string | null | undefined; cursor?: string;
}) {
  const cursor = input.cursor ? (await query<{ createdAt: Date; id: string }>(`SELECT created_at AS "createdAt",id
    FROM agent_runs WHERE id=$1 AND owner_id=$2 AND workflow='consumer_planning'`,
  [input.cursor, user.id])).rows[0] : undefined;
  if (input.cursor && !cursor) throw new AppError(400, 'VALIDATION_ERROR', '运行列表游标无效。');
  const rows = (await query<{
    id: string; budgetPeriodId: string | null; state: string; errorCode: string | null;
    createdAt: Date; finishedAt: Date | null;
  }>(`SELECT id,budget_period_id AS "budgetPeriodId",state,error_code AS "errorCode",
      created_at AS "createdAt",finished_at AS "finishedAt"
    FROM agent_runs WHERE owner_id=$1 AND workflow='consumer_planning'
      AND ($2::boolean OR ($3::uuid IS NULL AND budget_period_id IS NULL) OR budget_period_id=$3)
      AND ($4::timestamptz IS NULL OR (created_at,id)<($4,$5::uuid))
    ORDER BY created_at DESC,id DESC LIMIT 21`, [user.id, input.periodId === undefined,
    input.periodId ?? null, cursor?.createdAt ?? null, cursor?.id ?? null])).rows;
  const page = rows.slice(0, 20);
  return {
    items: page.map((row) => ({ ...row, createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null })),
    nextCursor: rows.length > 20 ? page.at(-1)!.id : null,
  };
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
  const responseSections = new Map<string, string>();
  let readBasis: { financialVersion: number; periodVersion: number } | null = null;
  const abort = new AbortController();
  const combined = AbortSignal.any([signal, abort.signal, AbortSignal.timeout(120_000)]);
  const ensureActive = async () => { combined.throwIfAborted(); await assertConsumerRunActive(runId); };
  const selectedLedgerMonth = (await query<{ month: string | null }>(`SELECT
    to_char(ledger_month,'YYYY-MM') AS month FROM agent_runs WHERE id=$1 AND owner_id=$2`,
  [runId, user.id])).rows[0]?.month ?? null;
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
      const { focus } = z.object({ focus: z.enum(['overview', 'lowest_balance', 'unknown', 'adjustable']).default('overview') }).strict().parse(raw);
      if (!periodId) throw new AppError(409, 'FINANCE_BASIS_UNKNOWN', '本次运行尚未绑定预算周期。');
      await query('UPDATE agent_runs SET tool_calls=$2 WHERE id=$1', [runId, toolCalls]);
      const result = await transaction(async (client) => {
        const period = await readBudgetPeriod(client, user.id, periodId);
        const account = (await client.query<{ source: string; status: string }>(`SELECT source,status
          FROM finance_accounts WHERE id=$1 AND owner_id=$2`,
        [period.period.accountId, user.id])).rows[0]!;
        const rolling = period.period.status === 'active' && period.basis.dataStatus === 'observed'
          ? await forecastBudgetCashflow(client, user.id, periodId, {
            rolling30: true, expectedFinancialVersion: period.basis.financialVersion,
            expectedPeriodVersion: period.basis.periodVersion,
          }) : null;
        const adjustableImpacts: AdjustableImpact[] = [];
        if (focus === 'adjustable' && period.forecast.status !== 'unknown') {
          const candidates = (await client.query<{ id: string; title: string; plannedOn: string }>(`SELECT i.id,i.title,
            to_char(i.planned_on,'YYYY-MM-DD') AS "plannedOn" FROM budget_items i
            WHERE i.period_id=$1 AND i.owner_id=$2 AND i.kind='planned_spend'
              AND i.status='planned' AND i.priority='adjustable'
              AND NOT EXISTS(SELECT 1 FROM budget_ledger_links l WHERE l.item_id=i.id AND l.active)
              AND NOT EXISTS(SELECT 1 FROM purchase_intents intent WHERE intent.budget_item_id=i.id
                AND intent.owner_id=i.owner_id AND (intent.status IN ('confirmed','ordered')
                  OR (intent.status='proposed' AND intent.expires_at>now())))
            ORDER BY i.planned_on,i.id`, [periodId, user.id])).rows;
          const options = { expectedFinancialVersion: period.basis.financialVersion,
            expectedPeriodVersion: period.basis.periodVersion, now: new Date() };
          const before = candidates.length ? await forecastBudgetCashflow(client, user.id, periodId, options) : null;
          for (const item of candidates) {
            const after = await forecastBudgetCashflow(client, user.id, periodId, { ...options, excludedItemId: item.id });
            adjustableImpacts.push({ title: item.title, plannedOn: item.plannedOn,
              before: before!.forecast.minimumSavingsHeadroomMinor, after: after.forecast.minimumSavingsHeadroomMinor });
          }
        }
        return { ...period, accountSource: account.source, accountStatus: account.status,
          rolling30: rolling?.forecast ?? null, adjustableImpacts };
      });
      readBasis = { financialVersion: result.basis.financialVersion,
        periodVersion: result.basis.periodVersion };
      const summary = describeBudget(result, focus);
      responseSections.set('budget', summary);
      return { ...result, displaySummary: summary };
    },
    read_month_ledger_summary: async (raw) => {
      await ensureActive();
      if (++toolCalls > 20) throw new Error('工具次数达到上限。');
      const { month } = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).strict().parse(raw);
      if (!periodId) throw new AppError(409, 'FINANCE_BASIS_UNKNOWN', '本次运行尚未绑定本人预算账户。');
      if (month !== selectedLedgerMonth) throw new AppError(409, 'RESOURCE_FORBIDDEN', '只能读取本次选择月份的账目汇总。');
      const account = (await query<{ accountId: string; accountSource: string }>(`SELECT
        period.primary_account_id AS "accountId",account.source AS "accountSource"
        FROM budget_periods period JOIN finance_accounts account
          ON account.id=period.primary_account_id AND account.owner_id=period.owner_id
        WHERE period.id=$1 AND period.owner_id=$2`, [periodId, user.id])).rows[0];
      if (!account) throw new AppError(404, 'RESOURCE_FORBIDDEN', '未找到本人的预算周期。');
      await query('UPDATE agent_runs SET tool_calls=$2 WHERE id=$1', [runId, toolCalls]);
      const rows = (await query<{ direction: 'inflow' | 'outflow'; category: string;
        isRefund: boolean; amountMinor: string; count: string }>(`WITH selected AS (
          SELECT entry.direction,
            COALESCE(override.display_category,entry.category,'other') AS category,
            (entry.direction='inflow' AND (entry.category='refund' OR EXISTS(
              SELECT 1 FROM finance_money_events money WHERE money.applied_ledger_entry_id=entry.id
                AND money.owner_id=entry.owner_id AND money.event_type='refund_posted'
                AND money.verification_state='verified'))) AS "isRefund",
            entry.amount_minor
          FROM finance_ledger_entries entry
          LEFT JOIN finance_ledger_category_overrides override
            ON override.entry_id=entry.id AND override.owner_id=entry.owner_id
          WHERE entry.owner_id=$1 AND entry.account_id=$2 AND entry.status='posted'
            AND (entry.occurred_at AT TIME ZONE 'Asia/Shanghai')::date >= ($3::text||'-01')::date
            AND (entry.occurred_at AT TIME ZONE 'Asia/Shanghai')::date
              < (($3::text||'-01')::date + interval '1 month')::date
        ) SELECT direction,category,"isRefund",SUM(amount_minor)::text AS "amountMinor",
          COUNT(*)::text AS count FROM selected GROUP BY direction,category,"isRefund"
        ORDER BY direction,category,"isRefund"`, [user.id, account.accountId, month])).rows;
      const summary = { month, timezone: 'Asia/Shanghai', source: 'posted_account_ledger',
        accountSource: account.accountSource,
        totalInflowMinor: rows.filter(row => row.direction === 'inflow').reduce((sum, row) => sum + Number(row.amountMinor), 0),
        totalOutflowMinor: rows.filter(row => row.direction === 'outflow').reduce((sum, row) => sum + Number(row.amountMinor), 0),
        refundInflowMinor: rows.filter(row => row.isRefund).reduce((sum, row) => sum + Number(row.amountMinor), 0),
        categories: rows.map(row => ({ direction: row.direction, category: row.category,
          isRefund: row.isRefund, amountMinor: Number(row.amountMinor), count: Number(row.count) })) };
      const displaySummary = [
        `${month} 已入账汇总（${account.accountSource === 'demo' ? '演示数据，非真实银行同步' : '账户记录'}）：`,
        `总流入：${displayMoney(summary.totalInflowMinor)}；支出：${displayMoney(summary.totalOutflowMinor)}。`,
        `其中退款流入：${displayMoney(summary.refundInflowMinor)}，已包含在总流入中，不重复累加。`,
      ].join('\n');
      responseSections.set('ledger', displaySummary);
      return { ...summary, displaySummary };
    },
    search_offers: async (raw) => {
      await ensureActive();
      if (++toolCalls > 20) throw new Error('工具次数达到上限。');
      const args = offerSearchInput.parse(raw);
      await query('UPDATE agent_runs SET tool_calls=$2 WHERE id=$1', [runId, toolCalls]);
      const result = await query<{ name: string; displayPriceMinor: number }>(`SELECT id,code,name,description,category_code AS "categoryCode",
          location_label AS "locationLabel",tags,purchase_mode AS "purchaseMode",
          price_minor AS "displayPriceMinor",currency,rule_label AS "ruleLabel"
        FROM catalog_items WHERE active AND currency='CNY'
          AND (available_from IS NULL OR available_from<=$1::date)
          AND (available_to IS NULL OR available_to>=$1::date)
          AND ($2::text IS NULL OR category_code=$2) ORDER BY code LIMIT 20`,
      [args.plannedOn, args.categoryCode ?? null]);
      responseSections.set('offers', result.rows.length
        ? ['平台登记的演示候选：', ...result.rows.map(item => `${item.name}：展示价格 ${displayMoney(Number(item.displayPriceMinor))}。`),
          '尚未选定商品；展示价格不等于购买报价或购买授权。'].join('\n')
        : '当前筛选下没有平台登记候选。');
      return { items: result.rows, source: 'bank_registered_demo_catalog' };
    },
    save_planning_draft: async (raw) => {
      await ensureActive();
      if (++toolCalls > 20) throw new Error('工具次数达到上限。');
      const payload = z.object({ items: z.array(planningDraftItem).min(1).max(20) }).strict().parse(raw);
      if (periodId && !readBasis) throw new AppError(409, 'FINANCE_BASIS_UNKNOWN', '保存周期草稿前必须读取本次绑定的资金依据。');
      const input = planningDraftInput.parse({ periodId,
        expectedFinancialVersion: readBasis?.financialVersion ?? null,
        expectedPeriodVersion: readBasis?.periodVersion ?? null,
        items: constrainAgentDraftToMessage(payload.items, message) });
      await query('UPDATE agent_runs SET tool_calls=$2 WHERE id=$1', [runId, toolCalls]);
      const result = await transaction(async (client) => {
        let impact: string | null = null;
        const draft = await createPlanningDraft(client, {
          async assessPlanningDraft(client, ownerId, periodId, financialVersion, periodVersion, proposedItems) {
            const options = { expectedFinancialVersion: financialVersion,
              expectedPeriodVersion: periodVersion, now: new Date() };
            const before = await forecastBudgetCashflow(client, ownerId, periodId, options);
            const after = await forecastBudgetCashflow(client, ownerId, periodId, { ...options, proposedItems });
            impact = describeDraftImpact(before.forecast, after.forecast);
            return { status: after.forecast.status, shortfallMinor: after.forecast.shortfallMinor,
              affectedDates: after.forecast.affectedDates, reasonCodes: after.forecast.reasonCodes };
          },
        }, user.id, input);
        await client.query(`INSERT INTO consumer_agent_artifacts(run_id,draft_id,owner_id)
          VALUES($1,$2,$3) ON CONFLICT (draft_id) DO NOTHING`,
        [runId, draft.data.draftId, user.id]);
        return { ...draft, displaySummary: describeDraft(draft.data, impact) };
      });
      responseSections.set(`draft:${result.data.draftId}`, result.displaySummary);
      return result;
    },
  });
  const shanghaiDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const agent = new Agent({ initialState: { model, systemPrompt:
    `你是行止银行消费规划助手。当前上海日期为 ${shanghaiDate}；本次运行${periodId ? '已由服务端绑定预算周期' : '未绑定预算周期'}。只依据工具返回的本人预算和银行平台登记商品回答。
用户明确给出的需求可保存为待确认草稿；缺失日期、金额或优先级必须保留为空，不得自行补写。解释账目时只能用本人绑定账户的${selectedLedgerMonth ?? '未选择'}月已入账汇总，不得索要或输出全部逐笔流水；工具返回的 accountSource 为 demo 时必须明说是演示数据，不能称为真实银行同步。
你可以读取预算、搜索登记商品、保存非执行草稿。仅在用户明确要求查询商品时搜索目录；普通资金提问和保存草稿无需搜索商品。你不能选择商品、修改正式预算或储蓄目标、确认购买、创建订单、支付、取消或退款。
金额字段以分计，展示为元时除以100。提问涉及最低日、未知原因或可调整项目时，必须选择 read_budget_basis 对应 focus；默认概览不能替代专项解释。优先引用工具的 displaySummary，禁止自行改写金额。allowed 只表示预算内，不表示余额不变；affectedDates 只表示缺口或未知日期。没有前后对比时不得断言无影响。草稿保存未修改预算，与正式加入后的预计影响必须区分。最终资金说明由服务端根据工具事实生成，你负责理解需求与调用适当工具；不要省略工具读取。不要展示内部标识、密钥、模型推理过程或不必要的逐笔流水。`,
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
    const modelOutput = last?.role === 'assistant'
      ? last.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n') : '';
    if (!modelOutput) throw new Error('模型没有返回可显示回答。');
    // Draft replies focus on the saved demand and its impact, not an unfiltered catalog.
    if ([...responseSections.keys()].some(key => key.startsWith('draft:'))) responseSections.delete('offers');
    const output = groundedAgentResponse(responseSections.values());
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
