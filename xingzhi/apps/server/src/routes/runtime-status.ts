import type { FastifyInstance } from 'fastify';
import { query } from '../db/client.js';
import { AppError } from '../domain/errors.js';
import { modelReady } from '../domain/agent-runtime.js';
import { sandboxReadiness } from '../payment/alipay-sandbox.js';

export async function registerRuntimeStatusApi(app: FastifyInstance) {
  app.get('/api/runtime-status', async (request) => {
    if (!request.authUser) throw new AppError(401, 'UNAUTHENTICATED', '请先登录。');
    const heartbeat = (await query<{ lastSeenAt: Date }>(`SELECT last_seen_at AS "lastSeenAt"
      FROM runtime_heartbeats WHERE component='worker'`)).rows[0];
    const ageSeconds = heartbeat ? Math.max(0, Math.floor((Date.now() - heartbeat.lastSeenAt.getTime()) / 1000)) : null;
    const payment = sandboxReadiness();
    let dataSource: { types: string[]; latestSyncAt: string | null } | null = null;
    if (request.authUser.role === 'consumer') {
      const row = (await query<{ types: string[] | null; latestSyncAt: Date | null }>(`SELECT
          array_agg(DISTINCT account.source) AS types,MAX(snapshot.captured_at) AS "latestSyncAt"
        FROM finance_accounts account LEFT JOIN finance_account_snapshots snapshot ON snapshot.account_id=account.id
        WHERE account.owner_id=$1`, [request.authUser.id])).rows[0];
      dataSource = { types: row?.types ?? [], latestSyncAt: row?.latestSyncAt?.toISOString() ?? null };
    }
    return { data: {
      version: '0.1.0', environment: process.env.NODE_ENV ?? 'development',
      payment: { mode: payment.mode, ready: payment.ready, missingCount: payment.missing.length },
      ai: { ready: modelReady() },
      worker: { status: ageSeconds !== null && ageSeconds <= 5 ? 'healthy' : ageSeconds !== null && ageSeconds <= 30 ? 'delayed' : 'offline',
        lastSeenAt: heartbeat?.lastSeenAt.toISOString() ?? null, ageSeconds },
      dataSource,
    }, meta: {} };
  });
}
