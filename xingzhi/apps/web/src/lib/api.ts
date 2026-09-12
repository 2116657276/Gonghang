import type { OperationRecheck } from './types.js';

export type ApiError = Error & { status?: number; code?: string };

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method?.toUpperCase() ?? 'GET';
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  if (!['GET', 'HEAD'].includes(method) && !headers.has('Idempotency-Key')) headers.set('Idempotency-Key', crypto.randomUUID());
  const response = await fetch(`/api${path}`, { ...init, method, headers, credentials: 'include' });
  if (response.status === 204) return undefined as T;
  const body = await response.json() as T & { error?: string; message?: string };
  if (!response.ok) {
    const error = new Error(body.message ?? '操作没有完成。') as ApiError;
    error.status = response.status;
    error.code = body.error;
    throw error;
  }
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
