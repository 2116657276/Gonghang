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
    assert.equal(state.chartPoints.value.length, 0, '没有服务端预测时不得生成示例资金曲线');
    assert.equal(state.chartFacts.value.length, 0, '没有服务端预测时不得显示编造的金额摘要');
  }
});

test('logout keeps H5 session on network failure but clears miniapp credentials', async () => {
  const filename = path.resolve(__dirname, '../src/lib/api.ts');
  const source = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true },
  }).outputText;
  async function attempt(isH5Runtime, statusCode) {
    let cleared = 0;
    class ApiError extends Error { constructor(status) { super('退出未确认'); this.status = status; } }
    const module = { exports: {} };
    vm.runInNewContext(source, {
      module, exports: module.exports,
      require(id) {
        if (id === '@tarojs/taro') return { request: async () => {
          if (statusCode === 0) throw new Error('offline');
          return { statusCode, data: {} };
        } };
        if (id === './errors') return { ApiError, parseApiError: (_, status) => new ApiError(status) };
        if (id === './runtime-config') return { apiBase: () => '', isH5Runtime };
        if (id === './idempotency') return { beginIdempotentRequest: () => null, completeIdempotentRequest() {} };
        if (id === './session') return { clearClientSession: () => { cleared++; }, sessionHeaders: () => ({}) };
        throw new Error(`Unexpected dependency: ${id}`);
      },
    }, { filename });
    let error = null;
    try { await module.exports.api.logout(); } catch (reason) { error = reason; }
    return { cleared, error };
  }
  assert.equal((await attempt(true, 0)).cleared, 0);
  assert.equal((await attempt(true, 503)).cleared, 0);
  assert.equal((await attempt(true, 204)).cleared, 1);
  assert.equal((await attempt(true, 401)).cleared, 1);
  const offlineMiniapp = await attempt(false, 0);
  assert.equal(offlineMiniapp.cleared, 1);
  assert.ok(offlineMiniapp.error);
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


test('home trend facts do not duplicate the hidden account balance', async () => {
  const { state } = devicePage('home');
  await state.loadOverviewAndForecast();
  state.rolling.value = { forecast: { status: 'allowed', minimumCashOn: '2026-09-28', daily: [
    { on: '2026-09-27', projectedCashMinor: 120000 },
    { on: '2026-09-28', projectedCashMinor: 110000 },
  ] } };
  state.toggleBalanceVisibility();
  assert.equal(state.balanceVisible.value, false);
  assert.deepEqual(Array.from(state.chartFacts.value, item => item.label), ['最低', '预测期末']);
  assert.equal(state.chartFacts.value.some(item => item.value === 120000), false);
  state.toggleBalanceVisibility();
  assert.equal(state.balanceVisible.value, true);
});

test('PageShell preserves normal back and uses the orders-specific fallback only on failure', async () => {
  const filename = path.resolve(__dirname, '../src/components/PageShell.vue');
  const { descriptor } = parse(readFileSync(filename, 'utf8'));
  const script = compileScript(descriptor, { id: 'navigation-regression' });
  const source = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021, esModuleInterop: true },
  }).outputText;
  const orders = readFileSync(path.resolve(__dirname, '../src/pages/orders/index.vue'), 'utf8');
  const fallback = orders.match(/back-fallback="([^"]+)"/)[1];
  assert.equal(fallback, '/pages/profile/index');
  for (const destination of [undefined, fallback]) {
    for (const fails of [false, true]) {
      const calls = [];
      const module = { exports: {} };
      vm.runInNewContext(source, { module, exports: module.exports, require(id) {
        if (id === 'vue') return vue;
        if (id === '@/lib/system-insets') return { getSystemInsetStyle: () => ({}) };
        if (id === '@tarojs/taro') return {
          navigateBack: async () => { calls.push('back'); if (fails) throw new Error('no previous page'); },
          switchTab: async ({ url }) => { calls.push(url); },
        };
        throw new Error(`Unexpected dependency: ${id}`);
      } });
      const component = module.exports.default;
      const backFallback = destination ?? component.props.backFallback.default;
      const state = component.setup({ compact: true, layout: 'legacy', back: false, backFallback }, { expose() {} });
      assert.equal(state.navigationLayout.value, 'detail');
      assert.equal(state.showBack.value, true);
      await state.goBack();
      assert.deepEqual(calls, fails ? ['back', destination ?? '/pages/home/index'] : ['back']);
    }
  }
});


test('首页时间线使用预测剩余金额，无事件保留原估价标识且未知不变零', async () => {
  const { state: p } = devicePage('home');
  await p.loadOverviewAndForecast();
  const item = (itemId, kind = 'planned_spend') => ({ itemId, kind, title: itemId,
    status: 'planned', plannedOn: '2026-09-29', userEstimatedAmountMinor: 10000 });
  p.overview.periods.value = [{ period: { accountId: 'account-1', status: 'active' },
    items: [item('untouched'), item('partial'), item('covered'), item('income', 'expected_income')] }];
  p.rolling.value = { forecast: { status: 'allowed', daily: [{ on: '2026-09-29', events: [
    { kind: 'planned_expense', referenceId: 'untouched', deltaMinor: -10000 },
    { kind: 'planned_expense', referenceId: 'partial', deltaMinor: -6000 },
  ] }] } };
  let rows = p.timeline.value;
  assert.equal(rows.find(v => v.id === 'item-untouched').amountMinor, 10000);
  assert.equal(rows.find(v => v.id === 'item-partial').amountMinor, 6000);
  assert.equal(rows.find(v => v.id === 'item-partial').amountLabel, '剩余安排');
  const covered = rows.find(v => v.id === 'item-covered');
  assert.equal(covered.included, false); assert.equal(covered.amountMinor, 10000);
  assert.equal(covered.amountLabel, '原计划金额（非预测扣款）');
  assert.equal(rows.find(v => v.id === 'item-income').included, false);
  p.rolling.value.forecast.status = 'unknown';
  p.rolling.value.forecast.daily[0].events = [];
  rows = p.timeline.value;
  assert.equal(rows.find(v => v.id === 'item-partial').included, false);
  assert.equal(rows.find(v => v.id === 'item-partial').amountLabel, '原计划金额（非预测扣款）');
  assert.equal(rows.find(v => v.id === 'item-partial').amountMinor, 10000);
});


test('首日收入前的期初最低值不被替换成当天收入后的曲线点', () => {
  const { state } = devicePage('home');
  const forecast = { status: 'allowed', minimumProjectedCashMinor: 10000, minimumCashOn: '2026-09-28', daily: [
    { on: '2026-09-28', projectedCashMinor: 20000 },
    { on: '2026-09-29', projectedCashMinor: 15000 },
  ] };
  state.rolling.value = { forecast, conditionalForecast: forecast };
  assert.equal(state.chartFacts.value[0].value, 10000);
  assert.match(state.trendSummary.value, /100/);
  assert.equal(state.chartPoints.value.some(point => point.minimum), false);
  assert.deepEqual(Array.from(state.chartPoints.value, point => point.value), [20000, 15000]);
  state.rolling.value.conditionalForecast = { ...forecast, minimumProjectedCashMinor: 15000,
    minimumCashOn: '2026-09-29' };
  assert.equal(state.chartFacts.value[0].value, 15000);
  assert.equal(state.chartPoints.value.find(point => point.minimum).value, 15000);
  state.rolling.value.conditionalForecast = { ...forecast, status: 'unknown',
    minimumProjectedCashMinor: null, minimumCashOn: null,
    daily: [...forecast.daily, { on: '2026-09-30', projectedCashMinor: null }] };
  assert.equal(state.chartFacts.value[0].label, '已知最低');
  assert.equal(state.chartFacts.value[0].value, 15000);
  assert.equal(state.chartFacts.value.length, 1);
  assert.equal(state.chartPoints.value.find(point => point.minimum).value, 15000);
});
