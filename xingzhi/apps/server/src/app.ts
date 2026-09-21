import Fastify from 'fastify';
import { registerBudgetItemApi } from './routes/budget-items.js';
import { registerOfferApi } from './routes/offers.js';
import { registerPlanningDraftApi } from './routes/planning-drafts.js';
import { registerFinanceAccountApi } from './routes/finance-accounts.js';
import { registerFinanceAssessmentApi } from './routes/finance-assessments.js';
import { registerBudgetPeriodReviewApi } from './routes/budget-period-review.js';
import { registerBudgetPeriodApi } from './routes/budget-periods.js';
import { registerPurchaseIntentApi } from './routes/purchase-intents.js';
import { registerBudgetAdjustmentApi } from './routes/budget-adjustments.js';
import { registerConsumerAftercareApi } from './routes/consumer-aftercare.js';
import { registerConsumerPreferencesApi } from './routes/consumer-preferences.js';
import { registerRuntimeStatusApi } from './routes/runtime-status.js';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { ZodError } from 'zod';
import { config } from './config.js';
import { loadSession } from './auth/session.js';
import { AppError } from './domain/errors.js';
import { registerApi } from './routes/api.js';
import { registerAgentApi } from './routes/agent.js';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { BudgetItemPort } from './domain/budget-port.js';
import type { PlanningDraftPort } from './domain/planning-draft-port.js';
import { budgetPlanningDraftPort } from './domain/budget-planning-draft-port.js';
import { applyBudgetItemChange, cancelBudgetItem } from './domain/budget-periods.js';
import { query } from './db/client.js';

export async function buildApp(options: {
  agentStream?: StreamFn;
  budgetItemPort?: BudgetItemPort;
  planningDraftPort?: PlanningDraftPort;
} = {}) {
const app = Fastify({ logger: { level: 'info' } });

await app.register(cookie);
await app.register(cors, { origin: config.webOrigin, credentials: true });
app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
  const rawBody = String(body);
  const rawPayload: Record<string, string> = {};
  const values: Record<string, string> = {};
  for (const pair of rawBody.split('&')) {
    const divider = pair.indexOf('=');
    const encodedKey = divider === -1 ? pair : pair.slice(0, divider);
    const encodedValue = divider === -1 ? '' : pair.slice(divider + 1);
    try {
      const key = decodeURIComponent(encodedKey.replace(/\+/g, ' '));
      const value = decodeURIComponent(encodedValue.replace(/\+/g, ' '));
      if (!key) continue;
      values[key] = value;
      rawPayload[key] = key === 'sign' ? value : encodedValue;
    } catch {
      return done(new Error('无法读取渠道通知参数。'));
    }
  }
  done(null, { rawBody, rawPayload, values });
});
app.addHook('preHandler', loadSession);
app.get('/api/health', async () => {
  await query('SELECT 1');
  return { status: 'ok', service: 'xingzhi-server', version: process.env.npm_package_version ?? '0.1.0' };
});
app.setErrorHandler((error, _request, reply) => {
  if (error instanceof AppError) return reply.code(error.statusCode).send({ error: error.code, message: error.message, details: error.details });
  if (error instanceof ZodError) return reply.code(400).send({ error: 'INVALID_INPUT', message: '请求参数不符合要求。' });
  app.log.error(error);
  return reply.code(500).send({ error: 'INTERNAL_ERROR', message: '服务暂时无法完成该操作。' });
});
await registerApi(app);
await app.register(registerOfferApi);
await app.register(registerFinanceAccountApi);
await app.register(registerFinanceAssessmentApi);
await app.register(registerBudgetPeriodReviewApi);
await app.register(registerBudgetPeriodApi);
await app.register(registerPurchaseIntentApi);
await app.register(registerBudgetAdjustmentApi);
await app.register(registerConsumerAftercareApi);
await app.register(registerConsumerPreferencesApi);
await app.register(registerRuntimeStatusApi);
await app.register(registerBudgetItemApi, {
  budgetItemPort: options.budgetItemPort ?? { applyBudgetItemChange, cancelBudgetItem },
});
await app.register(registerPlanningDraftApi, {
  planningDraftPort: options.planningDraftPort ?? budgetPlanningDraftPort,
});
registerAgentApi(app,options.agentStream);

return app;
}
