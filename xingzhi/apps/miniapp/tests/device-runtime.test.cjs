const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { parse, compileScript } = require('@vue/compiler-sfc');
const ts = require('typescript');
const vue = require('vue');

// Execute the actual page setup code without Intl, as on a restricted device
// engine. This does not emulate WeChat's native renderer or network stack.
function devicePage(page, overrides = {}) {
  const shown = [];
  const unmounted = [];
  const timers = new Map();
  let nextTimer = 0;
  const starts = [];
  const account = { account: { accountId: 'account-1', accountType: 'debit', status: 'linked', displayName: '测试账户' },
    cashBasis: { dataStatus: 'observed', confirmedCashMinor: 120000, asOf: '2026-09-25T10:30:00Z' },
    ledger: [], obligations: { items: [] } };
  const api = {
    session: async () => ({ user: { role: 'consumer', displayName: '测试用户' } }),
    accounts: async () => ({ data: { accounts: [structuredClone(account)] } }),
    periods: async () => ({ data: { periods: [] } }),
    preferences: async () => ({ data: { defaultAccountId: 'account-1', notifications: {} } }),
    purchaseIntents: async () => ({ data: { intents: [] } }),
    orders: async () => ({ data: { orders: [] } }),
    agentRuns: async () => ({ data: { items: [] } }),
    startAgent: async (...args) => { starts.push(args); return { data: { runId: 'run-1' } }; },
    agentRun: async () => ({ data: { runId: 'run-1', state: 'COMPLETED', output: '已核对计划。', artifacts: [] } }),
    ...overrides,
  };
  const cache = new Map();
  const sourceRoot = path.resolve(__dirname, '../src');
  const taro = { useDidShow: callback => shown.push(callback) };
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename);
    let source = readFileSync(filename, 'utf8');
    if (filename.endsWith('.vue')) {
      source = compileScript(parse(source, { filename }).descriptor, { id: 'device-regression' }).content;
    }
    const compiled = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true },
      fileName: filename,
    }).outputText;
    const module = { exports: {} };
    cache.set(filename, module.exports);
    vm.runInNewContext(compiled, {
      module, exports: module.exports, Intl: undefined, console,
      setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; },
      clearTimeout: id => timers.delete(id),
      require(id) {
        if (id === 'vue') return { ...vue, onBeforeUnmount: callback => unmounted.push(callback) };
        if (id === '@tarojs/taro') return taro;
        if (id === '@/lib/api') return { api, ApiError: load(path.join(sourceRoot, 'lib/errors.ts')).ApiError, goLogin() {} };
        if (id === '@/lib/ai-entry') return { takeAiQuestion: () => null };
        if (id === '@/composables/useAmountVisibility') return { useAmountVisibility: () => ({ balanceVisible: vue.ref(true), toggleBalanceVisibility() {} }) };
        if (id.endsWith('.vue')) return {};
        if (id.startsWith('@/')) return load(path.join(sourceRoot, `${id.slice(2)}.ts`));
        throw new Error(`Unexpected dependency: ${id}`);
      },
    }, { filename });
    return module.exports;
  }
  const component = load(path.join(sourceRoot, `pages/${page}/index.vue`)).default;
  const state = component.setup({}, { expose() {} });
  return { state, api, starts, shown, timers, account, dispose: () => unmounted.forEach(callback => callback()) };
}

test('home formats repeatedly refreshed account facts without Intl', async () => {
  const { state, account } = devicePage('home');
  for (let index = 0; index < 3; index++) {
    account.cashBasis.asOf = `2026-09-25T10:3${index}:00Z`;
    await state.loadOverviewAndForecast();
    assert.match(state.factTime.value, new RegExp(`9月25日 18:3${index}`));
    assert.equal(state.overview.error.value, '');
  }
});

test('AI send reaches the API and displays its answer without Intl', async () => {
  const { state, starts } = devicePage('ai');
  await state.send('帮我解释本月计划');
  assert.equal(starts.length, 1);
  assert.equal(starts[0][0], '帮我解释本月计划');
  assert.equal(state.messages.value.length, 2);
  assert.equal(state.messages.value[1].text, '已核对计划。');
  assert.match(state.messages.value[0].at, /^\d{2}:\d{2}$/);
  assert.equal(state.sending.value, false);
  assert.equal(state.error.value, '');
});

test('home retains loaded content during tab refresh and a failed refresh', async () => {
  const { state, api } = devicePage('home');
  assert.equal(state.overviewReady.value, false);
  await state.loadOverviewAndForecast();
  let finish;
  api.accounts = () => new Promise(resolve => { finish = resolve; });
  const refreshing = state.loadOverviewAndForecast();
  assert.equal(state.overview.loading.value, true);
  assert.equal(state.overviewReady.value, true);
  assert.equal(state.overview.primaryAccount.value.account.accountId, 'account-1');
  finish({ data: { accounts: [state.overview.primaryAccount.value] } });
  await refreshing;
  api.accounts = async () => { throw new Error('offline'); };
  await state.loadOverviewAndForecast();
  assert.equal(state.overviewReady.value, true);
  assert.equal(state.overview.loading.value, false);
  assert.ok(state.overview.error.value);
  assert.match(state.factTime.value, /18:30/);
});

test('failed AI submission restores the question and allows an explicit retry', async () => {
  const { state, api, starts } = devicePage('ai');
  const start = api.startAgent;
  api.startAgent = async () => { throw new Error('offline'); };
  state.input.value = '这周应该怎么安排？';
  await state.send();
  assert.equal(state.input.value, '这周应该怎么安排？');
  assert.equal(state.sending.value, false);
  assert.ok(state.error.value);
  api.startAgent = start;
  await state.send();
  assert.equal(starts.length, 1);
  assert.equal(state.error.value, '');
});

test('native keyboard confirm uses the final text; a tap does not erase it', async () => {
  const { state, starts } = devicePage('ai');
  state.input.value = '未完成的输入';
  await state.submitInput({ detail: { value: '完整问题' } });
  assert.equal(starts[0][0], '完整问题');
  state.handleAiInput({ detail: { value: '按钮发送的问题' } });
  await state.submitInput({ detail: { x: 100, y: 200 } });
  assert.equal(starts[1][0], '按钮发送的问题');
  await state.submitInput();
  assert.equal(starts.length, 2);
  assert.equal(state.error.value, '请先输入你想问的问题。');
});

test('tab return while AI is running does not start a duplicate request', async () => {
  const { state, api, starts, shown, timers, dispose } = devicePage('ai', {
    agentRun: async () => ({ data: { state: 'RUNNING', output: '', artifacts: [] } }),
  });
  await state.send('解释当前计划');
  assert.equal(state.sending.value, true);
  assert.equal(timers.size, 1);
  await shown[0]();
  await state.send('重复点击');
  assert.equal(starts.length, 1);
  api.agentRun = async () => ({ data: { state: 'COMPLETED', output: '整理完成', artifacts: [] } });
  const [timerId, callback] = timers.entries().next().value;
  timers.delete(timerId);
  callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.sending.value, false);
  assert.equal(state.messages.value[1].text, '整理完成');
  dispose();
  assert.equal(timers.size, 0);
});
