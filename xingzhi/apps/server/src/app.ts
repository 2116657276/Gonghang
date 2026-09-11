import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { ZodError } from 'zod';
import { config } from './config.js';
import { loadSession } from './auth/session.js';
import { AppError } from './domain/errors.js';
import { registerApi } from './routes/api.js';
import { registerAgentApi } from './routes/agent.js';
import type { StreamFn } from '@earendil-works/pi-agent-core';

export async function buildApp(options: { agentStream?: StreamFn } = {}) {
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
app.setErrorHandler((error, _request, reply) => {
  if (error instanceof AppError) return reply.code(error.statusCode).send({ error: error.code, message: error.message, details: error.details });
  if (error instanceof ZodError) return reply.code(400).send({ error: 'INVALID_INPUT', message: '请求参数不符合要求。' });
  app.log.error(error);
  return reply.code(500).send({ error: 'INTERNAL_ERROR', message: '服务暂时无法完成该操作。' });
});
await registerApi(app);
registerAgentApi(app,options.agentStream);

return app;
}
