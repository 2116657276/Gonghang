import type { PoolClient } from 'pg';
import type { AuthUser } from '../auth/session.js';
import { forbidden, notFound } from './errors.js';

export type PlanRow = {
  id: string;
  owner_id: string;
  purpose: string;
  version: number;
  purchase_limit_minor: number;
  paused_item_ids: unknown;
};

export function listPausedIds(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

export async function ownedPlan(client: PoolClient, planId: string, user: AuthUser, lock = false): Promise<PlanRow> {
  const result = await client.query<PlanRow>(
    `SELECT id, owner_id, purpose, version, purchase_limit_minor, paused_item_ids
     FROM plans WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [planId],
  );
  const plan = result.rows[0];
  if (!plan) notFound('未找到该计划。');
  if (user.role !== 'consumer' || plan.owner_id !== user.id) forbidden();
  return plan;
}

export async function readablePlan(client: PoolClient, planId: string, user: AuthUser): Promise<PlanRow> {
  const result = await client.query<PlanRow>(
    'SELECT id, owner_id, purpose, version, purchase_limit_minor, paused_item_ids FROM plans WHERE id = $1',
    [planId],
  );
  const plan = result.rows[0];
  if (!plan) notFound('未找到该计划。');
  if (user.role === 'consumer' && plan.owner_id === user.id) return plan;
  if (user.role === 'reviewer') {
    const scope = await client.query('SELECT 1 FROM review_scopes WHERE reviewer_id = $1 AND plan_id = $2', [user.id, planId]);
    if (scope.rowCount) return plan;
  }
  forbidden();
}
