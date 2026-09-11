import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelRetryFetch, retryDelayMs } from './model-retry.js';

test('429 等待支持秒数、HTTP 日期及有抖动的指数退避', () => {
  assert.equal(retryDelayMs('2', 0), 2000);
  assert.equal(retryDelayMs('Thu, 10 Sep 2026 00:00:05 GMT', 0, Date.parse('2026-09-10T00:00:00Z')), 5000);
  assert.equal(retryDelayMs(null, 2, 0, () => 0.5), 4500);
  assert.equal(retryDelayMs('invalid', 1, 0, () => 0), 2000);
});

test('429 最多重试三次，逐次重新准入且保持请求参数', async () => {
  let attempts = 0; let admissions = 0; const waits: number[] = [];
  const send = modelRetryFetch({signal:new AbortController().signal,
    beforeRetry:async () => { admissions++; assert.equal(attempts, admissions); },
    wait:async ms => { waits.push(ms); },
    fetch:async (input, init) => {
      assert.equal(input, 'https://example.invalid/model'); assert.equal(init?.body, '{"model":"fixed"}');
      attempts++; return new Response('limited', {status:429, headers:{'Retry-After':'2'}});
    },
  });
  assert.equal((await send('https://example.invalid/model', {method:'POST', body:'{"model":"fixed"}'})).status, 429);
  assert.equal(attempts, 4); assert.equal(admissions, 3); assert.deepEqual(waits, [2000,2000,2000]);
});

test('429 后成功返回原流；网络未知和其他错误不重试', async () => {
  for (const status of [200, 400, 500]) {
    let attempts = 0;
    const send = modelRetryFetch({signal:new AbortController().signal, beforeRetry:async () => {}, wait:async () => {},
      fetch:async () => ++attempts === 1 ? new Response('', {status:429}) : new Response('original', {status}),
    });
    const response = await send('https://example.invalid');
    assert.equal(response.status, status); assert.equal(await response.text(), 'original'); assert.equal(attempts, 2);
  }
  let attempts = 0;
  const send = modelRetryFetch({signal:new AbortController().signal, beforeRetry:async () => { assert.fail('禁止重试'); },
    fetch:async () => { attempts++; throw new Error('lost response'); },
  });
  await assert.rejects(send('https://example.invalid'), /lost response/); assert.equal(attempts, 1);
});

test('退避中取消、总时限结束或重新准入拒绝均不再发送', async () => {
  for (const cancel of [true, false]) {
    const controller = new AbortController(); let attempts = 0;
    const send = modelRetryFetch({signal:controller.signal,
      beforeRetry:async () => { throw new Error('budget or call limit'); },
      wait:async () => { if (cancel) controller.abort(); },
      fetch:async () => { attempts++; return new Response('', {status:429}); },
    });
    await assert.rejects(send('https://example.invalid')); assert.equal(attempts, 1);
  }
  const send = modelRetryFetch({signal:AbortSignal.timeout(10), beforeRetry:async () => { assert.fail('已到截止时间'); },
    fetch:async () => new Response('', {status:429, headers:{'Retry-After':'3600'}}),
  });
  await assert.rejects(send('https://example.invalid'), {name:'AbortError'});
});
