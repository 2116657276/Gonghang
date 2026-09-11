import type { PoolClient } from 'pg';
import { enqueueAgentEvent } from './agent-events.js';

export async function appendEvent(
  client: PoolClient,
  planId: string,
  actorId: string | null,
  type: string,
  data: Record<string, unknown> = {},
) {
  const result = await client.query<{id:string}>(
    'INSERT INTO events (plan_id, actor_id, type, data) VALUES ($1, $2, $3, $4) RETURNING id',
    [planId, actorId, type, data],
  );
  await enqueueAgentEvent(client,result.rows[0]!.id,planId,type,data);
  return result.rows[0]!.id;
}
