import Taro from '@tarojs/taro';

const STORAGE_KEY = 'xingzhi_pending_idempotency_v1';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

type PendingRequest = { key: string; createdAt: number };
type PendingRequests = Record<string, PendingRequest>;

function readPending(): PendingRequests {
  const value = Taro.getStorageSync<PendingRequests>(STORAGE_KEY);
  if (!value || typeof value !== 'object') return {};
  const now = Date.now();
  return Object.fromEntries(Object.entries(value).filter(([, item]) =>
    item && typeof item.key === 'string' && typeof item.createdAt === 'number' && now - item.createdAt < MAX_AGE_MS));
}
function writePending(value: PendingRequests) {
  if (Object.keys(value).length) Taro.setStorageSync(STORAGE_KEY, value);
  else Taro.removeStorageSync(STORAGE_KEY);
}

function fingerprint(value: unknown): string {
  const input = JSON.stringify(value ?? null);
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function newKey(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function beginIdempotentRequest(method: string, path: string, data: unknown) {
  const storageId = `${method}:${path}:${fingerprint(data)}`;
  const pending = readPending();
  const existing = pending[storageId];
  if (existing) return { storageId, key: existing.key };
  const created = { key: newKey(), createdAt: Date.now() };
  pending[storageId] = created;
  writePending(pending);
  return { storageId, key: created.key };
}

export function completeIdempotentRequest(storageId: string, key: string) {
  const pending = readPending();
  if (pending[storageId]?.key !== key) return;
  delete pending[storageId];
  writePending(pending);
}

export function clearAllIdempotencyKeys() {
  Taro.removeStorageSync(STORAGE_KEY);
}
