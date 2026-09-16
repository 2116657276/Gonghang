import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z, ZodError } from 'zod';
import { financeAccountRevocationInput, ledgerCategoryChangeInput } from '@xingzhi/contracts';
import { config } from '../config.js';
import { query, transaction } from '../db/client.js';
import { AppError } from '../domain/errors.js';
import { loadFinanceAccountFacts, type FinanceDb } from '../domain/finance-facts.js';
import { runIdempotent } from '../domain/idempotency.js';

type TransactionRunner = <T>(run: (client: PoolClient) => Promise<T>) => Promise<T>;
const accountPath = z.object({ id: z.string().uuid() }).strict();
const ledgerPath = z.object({ id: z.string().uuid() }).strict();

function writeKey(request: FastifyRequest) {
  if (request.headers.origin !== config.webOrigin) {
    throw new AppError(403, 'RESOURCE_FORBIDDEN', '请求来源不被允许。');
  }
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.trim().length < 8 || key.length > 200) {
    throw new AppError(400, 'VALIDATION_ERROR', '撤回操作需要有效的 Idempotency-Key。');
  }
  return key;
}

async function revokeAccount(client: PoolClient, ownerId: string, accountId: string) {
  const account = (await client.query<{
    id: string; status: 'linked' | 'revoked'; revokedAt: Date | null; financialVersion: string;
  }>(`SELECT id,status,revoked_at AS "revokedAt",financial_version AS "financialVersion"
    FROM finance_accounts WHERE id=$1 AND owner_id=$2 FOR UPDATE`, [accountId, ownerId])).rows[0];
  if (!account) throw new AppError(404, 'RESOURCE_FORBIDDEN', '未找到本人账户。');
  const periods = (await client.query<{ id: string }>(`SELECT id FROM budget_periods
    WHERE primary_account_id=$1 AND owner_id=$2 ORDER BY month_start,id FOR UPDATE`,
  [accountId, ownerId])).rows;
  if (account.status === 'revoked') {
    return {
      data: { accountId, status: 'revoked', revokedAt: account.revokedAt!.toISOString(),
        financialVersion: Number(account.financialVersion), affectedPeriodIds: periods.map((period) => period.id) },
      meta: { financialVersion: Number(account.financialVersion) },
    };
  }
  // Active period validation still requires a linked account: invalidate its
  // version while the account is linked, then revoke in the same transaction.
  for (const period of periods) {
    await client.query('UPDATE budget_periods SET updated_at=now() WHERE id=$1', [period.id]);
  }
  const revoked = (await client.query<{ revokedAt: Date; financialVersion: string }>(
    `UPDATE finance_accounts SET status='revoked',revoked_at=now() WHERE id=$1 AND owner_id=$2
      RETURNING revoked_at AS "revokedAt",financial_version AS "financialVersion"`,
    [accountId, ownerId],
  )).rows[0]!;
  for (const period of periods) {
    await client.query(`INSERT INTO budget_events (owner_id,period_id,actor_id,type,data)
      VALUES($1,$2,$1,'finance_account_revoked',$3::jsonb)`, [
      ownerId, period.id, JSON.stringify({ accountId, financialVersion: Number(revoked.financialVersion) }),
    ]);
  }
  return {
    data: { accountId, status: 'revoked', revokedAt: revoked.revokedAt.toISOString(),
      financialVersion: Number(revoked.financialVersion), affectedPeriodIds: periods.map((period) => period.id) },
    meta: { financialVersion: Number(revoked.financialVersion) },
  };
}

export async function registerFinanceAccountApi(app: FastifyInstance, options: {
  db?: FinanceDb; transaction?: TransactionRunner;
} = {}) {
  const db = options.db ?? { query };
  const runTransaction = options.transaction ?? transaction;
  app.setErrorHandler((error, request, reply) => {
    const code = error instanceof ZodError ? 'VALIDATION_ERROR'
      : error instanceof AppError ? error.code : 'INTERNAL_ERROR';
    if (!(error instanceof ZodError) && !(error instanceof AppError)) request.log.error(error);
    return reply.code(error instanceof ZodError ? 400 : error instanceof AppError ? error.statusCode : 500)
      .send({ error: {
        code, message: error instanceof AppError ? error.message
          : code === 'VALIDATION_ERROR' ? '请求参数不符合要求。' : '服务暂时无法完成请求。',
        ...(error instanceof AppError && error.details ? { details: error.details } : {}),
      }, correlationId: randomUUID() });
  });
  app.addHook('preHandler', async (request) => {
    if (!request.authUser) throw new AppError(401, 'UNAUTHENTICATED', '请先登录。');
    if (request.authUser.role !== 'consumer') {
      throw new AppError(403, 'RESOURCE_FORBIDDEN', '仅消费者可读取或撤回本人资金账户。');
    }
  });
  app.get('/api/finance/accounts', async (request) => {
    const rows = (await db.query<{ id: string }>(
      'SELECT id FROM finance_accounts WHERE owner_id=$1 ORDER BY created_at,id',
      [request.authUser!.id],
    )).rows;
    const accounts = [];
    for (const row of rows) {
      accounts.push(await loadFinanceAccountFacts(db, request.authUser!.id, row.id));
    }
    return { data: { accounts }, meta: {} };
  });
  app.post('/api/finance/accounts/:id/revocations', async (request) => {
    const { id } = accountPath.parse(request.params);
    const input = financeAccountRevocationInput.parse(request.body);
    const key = writeKey(request);
    return runTransaction((client) => runIdempotent(
      client, request.authUser!.id, `POST /api/finance/accounts/${id}/revocations`,
      key, input, () => revokeAccount(client, request.authUser!.id, id),
    ));
  });
  app.patch('/api/finance/ledger/:id/category', async (request) => {
    const { id } = ledgerPath.parse(request.params);
    const input = ledgerCategoryChangeInput.parse(request.body);
    const key = writeKey(request);
    return runTransaction((client) => runIdempotent(
      client, request.authUser!.id, `PATCH /api/finance/ledger/${id}/category`, key, input,
      async () => {
        const entry = (await client.query<{ originalCategory: string | null; accountStatus: string }>(`
          SELECT entry.category AS "originalCategory",account.status AS "accountStatus"
          FROM finance_ledger_entries entry JOIN finance_accounts account ON account.id=entry.account_id
          WHERE entry.id=$1 AND entry.owner_id=$2 AND account.owner_id=$2 FOR UPDATE OF entry,account`,
        [id, request.authUser!.id])).rows[0];
        if (!entry) throw new AppError(404, 'RESOURCE_FORBIDDEN', '未找到本人流水。');
        if (entry.accountStatus !== 'linked') {
          throw new AppError(409, 'FINANCE_SCOPE_REVOKED', '账户授权已撤回，历史流水只能读取。');
        }
        const changed = (await client.query<{ updatedAt: Date }>(`INSERT INTO finance_ledger_category_overrides
            (entry_id,owner_id,display_category) VALUES($1,$2,$3)
          ON CONFLICT(entry_id) DO UPDATE SET display_category=EXCLUDED.display_category,updated_at=now()
          RETURNING updated_at AS "updatedAt"`, [id, request.authUser!.id, input.category])).rows[0]!;
        return { data: { entryId: id, originalCategory: entry.originalCategory,
          displayCategory: input.category, updatedAt: changed.updatedAt.toISOString() }, meta: {} };
      },
    ));
  });
}
