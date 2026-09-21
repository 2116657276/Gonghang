const STORAGE_KEY = 'xingzhi_web_pending_idempotency_v1';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

type PendingRequest = { key: string; createdAt: number };
type PendingRequests = Record<string, PendingRequest>;

function readPending(): PendingRequests {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}') as PendingRequests;
    const now = Date.now();
    return Object.fromEntries(Object.entries(parsed).filter(([, item]) =>
      item && typeof item.key === 'string' && typeof item.createdAt === 'number' && now - item.createdAt < MAX_AGE_MS));
  } catch { return {}; }
}

function writePending(value: PendingRequests) {
  try {
    if (Object.keys(value).length) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch { /* 浏览器禁用存储时仍可由当前请求头保证服务端幂等。 */ }
}

function fingerprint(value: unknown) {
  const input = JSON.stringify(value ?? null);
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export function beginIdempotentRequest(method: string, path: string, body: BodyInit | null | undefined) {
  const storageId = `${method}:${path}:${fingerprint(body)}`;
  const pending = readPending();
  if (pending[storageId]) return { storageId, key: pending[storageId].key };
  const created = { key: crypto.randomUUID(), createdAt: Date.now() };
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
