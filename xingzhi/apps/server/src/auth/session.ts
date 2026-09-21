import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { query } from '../db/client.js';

export type AuthUser = {
  id: string;
  email: string;
  displayName: string;
  role: 'consumer' | 'merchant_admin' | 'reviewer';
};

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser;
    sessionId?: string;
    sessionTransport?: 'cookie' | 'bearer';
  }
}

const sessionCookie = 'xingzhi_session';

function digest(token: string) {
  return createHash('sha256').update(token).digest('base64url');
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString('base64url');
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await query(
    'INSERT INTO sessions (id, user_id, token_digest, expires_at) VALUES ($1, $2, $3, $4)',
    [id, userId, digest(token), expiresAt],
  );
  return { token, expiresAt };
}

export async function loadSession(request: FastifyRequest) {
  const authorization = request.headers.authorization;
  const bearerMatch = authorization?.match(/^Bearer ([A-Za-z0-9_-]{32,200})$/);
  // An explicit Authorization header must be valid on its own. Do not silently
  // fall back to a browser cookie when a malformed/unsupported scheme is sent.
  if (authorization && !bearerMatch) return;
  const token = bearerMatch?.[1] ?? request.cookies[sessionCookie];
  if (!token) return;
  const result = await query<{
    session_id: string;
    id: string;
    email: string;
    display_name: string;
    role: AuthUser['role'];
  }>(`
    SELECT sessions.id AS session_id, users.id, users.email, users.display_name, users.role
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_digest = $1 AND sessions.revoked_at IS NULL AND sessions.expires_at > now()
  `, [digest(token)]);
  const row = result.rows[0];
  if (!row) return;
  request.sessionId = row.session_id;
  request.sessionTransport = bearerMatch ? 'bearer' : 'cookie';
  request.authUser = {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
  };
}

export async function revokeSession(sessionId?: string) {
  if (!sessionId) return;
  await query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
}

export { sessionCookie };
