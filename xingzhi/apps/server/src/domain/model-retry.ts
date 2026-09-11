import { setTimeout as delay } from 'node:timers/promises';

export function retryDelayMs(value: string | null, retry: number, now = Date.now(), random = Math.random) {
  if (value?.trim()) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Number.isFinite(seconds) ? NaN : Date.parse(value);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  return 1000 * 2 ** retry + Math.floor(random() * 1000);
}

// Retry only an explicit HTTP rejection, never a lost response or a partial stream.
export function modelRetryFetch(options: {
  signal: AbortSignal;
  beforeRetry: () => Promise<void>;
  fetch?: typeof fetch;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}): typeof fetch {
  const send = options.fetch ?? globalThis.fetch;
  const wait = options.wait ?? (async (ms, signal) => {
    // Avoid Node's timer overflow shortening a long Retry-After to one millisecond.
    await delay(Math.min(ms, 2_147_483_647), undefined, { signal });
  });
  return async (input, init) => {
    const signal = AbortSignal.any([options.signal, ...(init?.signal ? [init.signal] : [])]);
    for (let retry = 0; ; retry++) {
      signal.throwIfAborted();
      const response = await send(input, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
      if (response.status !== 429 || retry >= 3) return response;
      const milliseconds = retryDelayMs(response.headers.get('retry-after'), retry);
      await response.body?.cancel();
      await wait(milliseconds, signal);
      signal.throwIfAborted();
      // The caller rechecks persisted cancellation, the eight-call limit and shared budget.
      await options.beforeRetry();
    }
  };
}
