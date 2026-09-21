import type { OperationRecheck } from './types.js';
import { beginIdempotentRequest, completeIdempotentRequest } from './idempotency.js';

export type ApiError = Error & { status?: number; code?: string };

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method?.toUpperCase() ?? 'GET';
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  const pending = !['GET', 'HEAD'].includes(method) && !headers.has('Idempotency-Key')
    ? beginIdempotentRequest(method, path, init.body) : null;
  if (pending) headers.set('Idempotency-Key', pending.key);
  let response: Response;
  try { response = await fetch(`/api${path}`, { ...init, method, headers, credentials: 'include' }); }
  catch (reason) {
    // 服务端可能已经受理但响应丢失；保留同一个键供用户明确重试。
    throw reason;
  }
  if (response.status === 204) return undefined as T;
  const body = await response.json() as T & { error?: string; message?: string };
  if (!response.ok) {
    if (pending && response.status < 500 && response.status !== 408) completeIdempotentRequest(pending.storageId, pending.key);
    const error = new Error(body.message ?? '操作没有完成。') as ApiError;
    error.status = response.status;
    error.code = body.error;
    throw error;
  }
  if (pending) completeIdempotentRequest(pending.storageId, pending.key);
  return body;
}

export const yuan = (minor: number) => new Intl.NumberFormat('zh-CN', {
  style: 'currency', currency: 'CNY', minimumFractionDigits: 2,
}).format(minor / 100);

export const dateTime = (value: string | Date) => new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(value));

export async function requestOperationRecheck(operationId: string, reason: string): Promise<string> {
  const result = await api<OperationRecheck>(`/operations/${operationId}/rechecks`, {
    method: 'POST', body: JSON.stringify({ reason }),
  });
  return result.manualTaskId
    ? '模拟交易复核已交由商户人工跟进；受理不代表退款成功。'
    : result.reused
      ? '已合并到已有复核请求；请等待后台核验，退款金额以明确结果为准。'
      : '复核请求已排队；后台核验后更新事实，受理不代表退款成功。';
}
