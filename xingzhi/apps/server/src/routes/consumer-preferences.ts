import type { FastifyInstance, FastifyRequest } from 'fastify';
import { consumerPreferencesPatchInput } from '@xingzhi/contracts';
import { isTrustedWriteRequest } from '../auth/guards.js';
import { transaction } from '../db/client.js';
import { AppError } from '../domain/errors.js';
import { runIdempotent } from '../domain/idempotency.js';

function writeKey(request: FastifyRequest) {
  if (!isTrustedWriteRequest(request)) throw new AppError(403, 'RESOURCE_FORBIDDEN', '请求来源不被允许。');
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.trim().length < 8 || key.length > 200) {
    throw new AppError(400, 'VALIDATION_ERROR', '更新设置需要有效的 Idempotency-Key。');
  }
  return key;
}

async function readPreferences(ownerId: string) {
  const row = (await transaction((client) => client.query<{
    defaultAccountId: string | null; planning: boolean; orders: boolean; refunds: boolean; updatedAt: Date;
  }>(`SELECT default_account_id AS "defaultAccountId",notify_planning AS planning,
      notify_orders AS orders,notify_refunds AS refunds,updated_at AS "updatedAt"
    FROM consumer_preferences WHERE owner_id=$1`, [ownerId]))).rows[0];
  return row ? { ...row, updatedAt: row.updatedAt.toISOString() } : {
    defaultAccountId: null, notifications: { planning: true, orders: true, refunds: true }, updatedAt: null,
  };
}

export async function registerConsumerPreferencesApi(app: FastifyInstance) {
  app.addHook('preHandler', async (request) => {
    if (!request.authUser) throw new AppError(401, 'UNAUTHENTICATED', '请先登录。');
    if (request.authUser.role !== 'consumer') throw new AppError(403, 'RESOURCE_FORBIDDEN', '仅消费者可管理本人设置。');
  });
  app.get('/api/consumer-preferences', async (request) => {
    const value = await readPreferences(request.authUser!.id);
    if ('notifications' in value) return { data: value, meta: {} };
    return { data: { defaultAccountId: value.defaultAccountId,
      notifications: { planning: value.planning, orders: value.orders, refunds: value.refunds },
      updatedAt: value.updatedAt }, meta: {} };
  });
  app.patch('/api/consumer-preferences', async (request) => {
    const input = consumerPreferencesPatchInput.parse(request.body);
    const key = writeKey(request);
    return transaction((client) => runIdempotent(
      client, request.authUser!.id, 'PATCH /api/consumer-preferences', key, input,
      async () => {
        if (input.defaultAccountId) {
          const account = (await client.query<{ id: string }>(`SELECT id FROM finance_accounts
            WHERE id=$1 AND owner_id=$2 AND status='linked' AND account_type='debit' FOR UPDATE`,
          [input.defaultAccountId, request.authUser!.id])).rows[0];
          if (!account) throw new AppError(422, 'ACCOUNT_NOT_ELIGIBLE', '只能选择本人已授权的借记账户。');
        }
        const current = (await client.query<{
          defaultAccountId: string | null; planning: boolean; orders: boolean; refunds: boolean;
        }>(`SELECT default_account_id AS "defaultAccountId",notify_planning AS planning,
            notify_orders AS orders,notify_refunds AS refunds FROM consumer_preferences WHERE owner_id=$1 FOR UPDATE`,
        [request.authUser!.id])).rows[0];
        const notifications = input.notifications ?? current ?? { planning: true, orders: true, refunds: true };
        const defaultAccountId = input.defaultAccountId !== undefined ? input.defaultAccountId : current?.defaultAccountId ?? null;
        const saved = (await client.query<{ updatedAt: Date }>(`INSERT INTO consumer_preferences
            (owner_id,default_account_id,notify_planning,notify_orders,notify_refunds)
          VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(owner_id) DO UPDATE SET default_account_id=EXCLUDED.default_account_id,
            notify_planning=EXCLUDED.notify_planning,notify_orders=EXCLUDED.notify_orders,
            notify_refunds=EXCLUDED.notify_refunds,updated_at=now()
          RETURNING updated_at AS "updatedAt"`, [request.authUser!.id, defaultAccountId,
          notifications.planning, notifications.orders, notifications.refunds])).rows[0]!;
        return { data: { defaultAccountId, notifications, updatedAt: saved.updatedAt.toISOString() }, meta: {} };
      },
    ));
  });
}
