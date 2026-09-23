import Taro from '@tarojs/taro';
import type { User } from './types';
import { clearAllIdempotencyKeys } from './idempotency';
import { clearAiQuestion } from './ai-entry';
import { isH5Runtime } from './runtime-config';

const MINIAPP_SESSION_KEY = 'xingzhi_miniapp_session_v1';

export type MiniappSession = {
  token: string;
  expiresAt: string;
  user: User;
};

export function readMiniappSession(): MiniappSession | null {
  if (isH5Runtime) return null;
  const value = Taro.getStorageSync<MiniappSession>(MINIAPP_SESSION_KEY);
  if (!value || typeof value !== 'object' || typeof value.token !== 'string' || typeof value.expiresAt !== 'string') return null;
  if (!Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) {
    clearClientSession();
    return null;
  }
  return value;
}
export function saveMiniappSession(session: MiniappSession) {
  if (!isH5Runtime) Taro.setStorageSync(MINIAPP_SESSION_KEY, session);
}

export function sessionHeaders(): Record<string, string> {
  const session = readMiniappSession();
  return session ? { Authorization: `Bearer ${session.token}` } : {};
}

export function cachedSessionUser(): User | null {
  return readMiniappSession()?.user ?? null;
}

export function clearClientSession() {
  Taro.removeStorageSync(MINIAPP_SESSION_KEY);
  clearAllIdempotencyKeys();
  clearAiQuestion();
}
