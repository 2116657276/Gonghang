import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import type { AuthUser } from './session.js';

export function requireUser(request: FastifyRequest, reply: FastifyReply): AuthUser | undefined {
  if (!request.authUser) {
    reply.code(401).send({ error: 'UNAUTHENTICATED', message: '请先登录。' });
    return;
  }
  return request.authUser;
}

export function requireRole(request: FastifyRequest, reply: FastifyReply, role: AuthUser['role']): AuthUser | undefined {
  const user = requireUser(request, reply);
  if (!user) return;
  if (user.role !== role) {
    reply.code(403).send({ error: 'FORBIDDEN', message: '当前身份没有此操作权限。' });
    return;
  }
  return user;
}

export function requireSameOrigin(request: FastifyRequest, reply: FastifyReply): boolean {
  const origin = request.headers.origin;
  if (origin !== config.webOrigin) {
    reply.code(403).send({ error: 'INVALID_ORIGIN', message: '请求来源不被允许。' });
    return false;
  }
  return true;
}

export function idempotencyKey(request: FastifyRequest, reply: FastifyReply): string | undefined {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || value.trim().length < 8 || value.length > 200) {
    reply.code(400).send({ error: 'IDEMPOTENCY_KEY_REQUIRED', message: '写入操作需要有效的 Idempotency-Key。' });
    return;
  }
  return value;
}
