import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import { AppError } from './errors.js';

function samePayload(left: unknown, right: unknown) {
  return isDeepStrictEqual(left, right);
}

export async function runIdempotent<T extends Record<string, unknown>>(
  client: PoolClient,
  actorId: string,
  route: string,
  key: string,
  requestPayload: Record<string, unknown>,
  action: () => Promise<T>,
): Promise<T> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify([actorId, route, key])]);
  const existing = await client.query<{ request_payload: Record<string, unknown>; response_payload: T }>(
    'SELECT request_payload, response_payload FROM idempotency_records WHERE actor_id = $1 AND route = $2 AND idempotency_key = $3',
    [actorId, route, key],
  );
  const record = existing.rows[0];
  if (record) {
    if (!samePayload(record.request_payload, requestPayload)) {
      throw new AppError(409, 'IDEMPOTENCY_CONFLICT', '同一幂等键不能用于不同请求参数。');
    }
    return record.response_payload;
  }
  const response = await action();
  await client.query(
    `INSERT INTO idempotency_records (actor_id, route, idempotency_key, request_payload, response_payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [actorId, route, key, requestPayload, response],
  );
  return response;
}
