// Runs the real Vue page scripts with controlled API timing, without a browser or Taro device.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const vue = require('vue');
const { parse, compileTemplate } = require('@vue/compiler-sfc');
const root = path.resolve(__dirname, '../src');
function evaluate(source, imports = {}, globals = {}) {
  const context = { exports: {}, require: name => imports[name] ?? {}, ...globals };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, context);
  return context.exports;
}
const format = evaluate(fs.readFileSync(path.join(root, 'lib/format.ts'), 'utf8'));
function page(file, names, api, globals = {}, taroOverrides = {}) {
  const filename = path.join(root, file);
  const { descriptor } = parse(fs.readFileSync(filename, 'utf8'));
  assert.equal(compileTemplate({ source: descriptor.template.content, filename, id: 'test' }).errors.length, 0);
  let load;
  const result = evaluate(descriptor.scriptSetup.content + `\nexport { ${names.join(',')} };`, {
    vue: { ...vue, onBeforeUnmount: () => {} },
    '@tarojs/taro': { default: { redirectTo: async () => {}, showModal: async () => ({ confirm: true }), ...taroOverrides }, useLoad: callback => { load = callback; } },
    '@/lib/api': { api }, '@/lib/errors': { errorMessage: e => e.message ?? String(e) }, '@/lib/format': format,
  }, globals);
  return { ...result, load };
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const offer = id => ({ id, name: id });
const quote = id => ({ quoteId: `quote-${id}`, catalogItemId: id, quoteVersion: 1, priceMinor: 5800 });
const assessment = id => ({ assessmentId: `assessment-${id}`, quoteId: `quote-${id}`, budgetItemId: 'item', periodId: 'period',
  financialVersion: 1, periodVersion: 1, quoteVersion: 1, status: 'allowed', shortfallMinor: 0 });
function offersPage(api) {
  const p = page('pages/offers/index.vue', ['choose', 'createIntent', 'period', 'item', 'selected', 'quote', 'assessment', 'checking', 'error', 'assessmentGap', 'canCreate'], api);
  p.period.value = { period: { periodId: 'period' }, basis: { financialVersion: 1, periodVersion: 1 } };
  p.item.value = { itemId: 'item', plannedOn: '2026-09-29', userEstimatedAmountMinor: 8000 };
  return p;
}
test('报价响应乱序：只提交最后选择，核对期间不建立意图', async () => {
  const a = deferred(), b = deferred(), sent = [], assessed = [];
  const p = offersPage({ offerQuote: id => id === 'A' ? a.promise : b.promise,
    assessPurchase: async body => { assessed.push(body.quoteId); return { data: assessment(body.quoteId.slice(-1)) }; },
    createPurchaseIntent: async body => { sent.push(body); return { data: { purchaseIntentId: 'intent' } }; } });
  const first = p.choose(offer('A')); const last = p.choose(offer('B'));
  await p.createIntent(); assert.equal(sent.length, 0);
  b.resolve({ data: quote('B') }); await last;
  a.resolve({ data: quote('A') }); await first;
  assert.deepEqual(assessed, ['quote-B']); assert.equal(p.selected.value.id, 'B');
  await p.createIntent(); assert.equal(sent[0].quoteId, 'quote-B'); assert.equal(sent[0].assessmentId, 'assessment-B');
});
test('较早的资金评估及错误不能覆盖新选择', async () => {
  for (const fails of [false, true]) {
    const old = deferred(), started = deferred();
    const p = offersPage({ offerQuote: async id => ({ data: quote(id) }),
      assessPurchase: body => { if (body.quoteId === 'quote-A') { started.resolve(); return old.promise; } return Promise.resolve({ data: assessment('B') }); } });
    const first = p.choose(offer('A')); await started.promise;
    await p.choose(offer('B'));
    if (fails) old.reject(new Error('旧请求失败')); else old.resolve({ data: assessment('A') });
    await first;
    assert.equal(p.quote.value.quoteId, 'quote-B'); assert.equal(p.assessment.value.assessmentId, 'assessment-B');
    assert.equal(p.error.value, ''); assert.equal(p.checking.value, false);
  }
});
test('未知缺口保持未知，提交前验证商品与评估范围', () => {
  const p = offersPage({}); p.selected.value = offer('A'); p.quote.value = quote('A');
  p.assessment.value = { ...assessment('A'), status: 'unknown', shortfallMinor: 0 };
  assert.equal(p.assessmentGap.value, '尚无法确定'); assert.equal(p.canCreate.value, false);
  p.assessment.value = assessment('A'); assert.equal(p.assessmentGap.value, '¥0'); assert.equal(p.canCreate.value, true);
  p.selected.value = offer('B'); assert.equal(p.canCreate.value, false);
});
test('候选核对失败与旧响应晚到均不能沿用旧报价；提交中重复点击只建立一次', async () => {
  const stale = deferred(), submitted = deferred(), sent = [];
  const p = offersPage({
    offerQuote: id => id === 'A' ? stale.promise : id === 'B'
      ? Promise.reject(new Error('报价暂不可用')) : Promise.resolve({ data: quote(id) }),
    assessPurchase: async body => ({ data: assessment(body.quoteId.slice(-1)) }),
    createPurchaseIntent: body => { sent.push(body); return submitted.promise; },
  });
  const old = p.choose(offer('A'));
  await p.choose(offer('B'));
  assert.match(p.error.value, /报价暂不可用/);
  assert.equal(p.canCreate.value, false);
  stale.resolve({ data: quote('A') }); await old;
  assert.equal(p.quote.value, null);
  assert.equal(p.assessment.value, null);
  await p.createIntent(); assert.equal(sent.length, 0);
  await p.choose(offer('C'));
  assert.equal(p.error.value, '');
  const first = p.createIntent();
  await p.createIntent();
  await p.choose(offer('D'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].quoteId, 'quote-C');
  assert.equal(sent[0].assessmentId, 'assessment-C');
  assert.equal(p.selected.value.id, 'C');
  submitted.resolve({ data: { purchaseIntentId: 'intent-C' } });
  await first;
});
test('意外支出使用上海日期：凌晨及月初跨日，并拒绝过去日期', async () => {
  for (const date of ['2026-09-26', '2026-10-01', '2027-01-01']) {
    class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [`${date}T01:00:00+08:00`])); } }
    let calls = 0;
    const p = page('pages/emergency/index.vue', ['plannedOn', 'period', 'assess', 'error'], {
      assessEmergency: () => { calls++; throw new Error('Past date must not submit'); },
    }, { Date: FixedDate });
    assert.equal(p.plannedOn.value, date);
    p.period.value = { period: { monthStart: `${date.slice(0, 7)}-01`, monthEnd: `${date.slice(0, 7)}-31` } };
    p.plannedOn.value = new FixedDate().toISOString().slice(0, 10);
    await p.assess(); assert.equal(calls, 0); assert.match(p.error.value, /今天或之后/);
  }
});
test('单项比较失败不丢弃已读取的周期依据', async () => {
  const p = page('pages/impact/detail.vue', ['period', 'error', 'impactError'], {
    period: async () => ({ data: { period: { periodId: 'period' }, items: [{ itemId: 'item', status: 'planned' }] } }),
    budgetItemImpact: async () => { throw new Error('单项暂不可用'); },
  });
  await p.load({ periodId: 'period', itemId: 'item' });
  assert.equal(p.period.value.period.periodId, 'period'); assert.equal(p.error.value, ''); assert.equal(p.impactError.value, '单项暂不可用');
  const stale = page('pages/impact/detail.vue', ['period', 'itemImpact', 'error', 'impactError'], {
    period: async () => ({ data: { period: { periodId: 'period' },
      basis: { financialVersion: 3, periodVersion: 5 }, items: [{ itemId: 'item', status: 'planned' }] } }),
    budgetItemImpact: async () => ({ data: { financialVersion: 2, periodVersion: 5 } }),
  });
  await stale.load({ periodId: 'period', itemId: 'item' });
  assert.equal(stale.period.value.period.periodId, 'period');
  assert.equal(stale.itemImpact.value, null);
  assert.equal(stale.error.value, '');
  assert.match(stale.impactError.value, /依据已经变化/);
});

test('单项影响沿用服务端剩余金额和比较结果，不在页面重复扣除已入账金额', async () => {
  const p = page('pages/impact/detail.vue', ['period', 'itemImpact', 'itemHeadroomImpact', 'impactError'], {
    period: async () => ({ data: {
      period: { periodId: 'period' }, basis: { financialVersion: 4, periodVersion: 7,
        confirmedCashMinor: 170000, minimumSavingsHeadroomMinor: 28000 },
      items: [{ itemId: 'item', status: 'planned', userEstimatedAmountMinor: 8000 }],
    } }),
    budgetItemImpact: async () => ({ data: { financialVersion: 4, periodVersion: 7,
      estimatedMinor: 8000, coveredMinor: 3000, remainingMinor: 5000,
      withItem: { minimumSavingsHeadroomMinor: 28000 },
      withoutItem: { minimumSavingsHeadroomMinor: 33000 } } }),
  });
  await p.load({ periodId: 'period', itemId: 'item' });
  assert.equal(p.impactError.value, '');
  assert.equal(p.itemImpact.value.coveredMinor, 3000);
  assert.equal(p.itemImpact.value.remainingMinor, 5000);
  assert.equal(p.itemHeadroomImpact.value, -5000);
  assert.equal(p.period.value.basis.confirmedCashMinor, 170000);
});

test('合并后意外安排保留上海日期，并要求手动选择方案才能确认', async () => {
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : ['2026-09-26T01:00:00+08:00'])); } }
  const sent = [];
  const proposal = { adjustmentId: 'adjustment', basisFinancialVersion: 1, basisPeriodVersion: 1,
    options: [{ optionId: 'option', assessment: { status: 'allowed' } }] };
  const p = page('pages/emergency/index.vue', ['period', 'plannedOn', 'assess', 'confirm', 'selected', 'error'], {
    assessEmergency: async body => { assert.equal(body.plannedOn, '2026-09-26'); return { data: proposal }; },
    confirmAdjustment: async (id, body) => { sent.push({ id, ...body }); },
  }, { Date: FixedDate });
  p.period.value = { period: { periodId: 'period', monthStart: '2026-09-01', monthEnd: '2026-09-30' },
    basis: { financialVersion: 1, periodVersion: 1 } };
  await p.assess(); assert.equal(p.error.value, ''); assert.equal(p.selected.value, '');
  await p.confirm(); assert.equal(sent.length, 0);
  p.selected.value = 'option'; await p.confirm();
  assert.equal(sent.length, 1); assert.equal(sent[0].acceptedOptionId, 'option');
});

test('意外安排拒绝周期外日期，确认弹窗未完成前重复点击不得重复提交', async () => {
  class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : ['2026-09-26T01:00:00+08:00'])); } }
  const modals = [], sent = [];
  const p = page('pages/emergency/index.vue', ['period', 'plannedOn', 'assess', 'confirm', 'selected', 'proposal', 'saving', 'error'], {
    assessEmergency: async () => ({ data: { adjustmentId: 'adjustment', basisFinancialVersion: 1,
      basisPeriodVersion: 1, options: [{ optionId: 'A' }, { optionId: 'B' }] } }),
    confirmAdjustment: async (id, body) => { sent.push({ id, ...body }); },
  }, { Date: FixedDate }, { showModal: () => { const modal = deferred(); modals.push(modal); return modal.promise; } });
  p.period.value = { period: { periodId: 'period', monthStart: '2026-09-01', monthEnd: '2026-09-30' },
    basis: { financialVersion: 1, periodVersion: 1 } };
  p.plannedOn.value = '2026-10-01';
  await p.assess(); assert.match(p.error.value, /本周期/);
  assert.equal(p.proposal.value, null);
  p.plannedOn.value = '2026-09-26';
  await p.assess(); p.selected.value = 'A';
  const cancelled = p.confirm();
  assert.equal(p.saving.value, true);
  modals[0].resolve({ confirm: false });
  await cancelled;
  assert.equal(p.saving.value, false);
  assert.equal(sent.length, 0);
  // Two taps can arrive before the native confirmation callback resolves.
  const first = p.confirm();
  p.selected.value = 'B'; // The confirmation must retain the option shown when it was opened.
  const second = p.confirm();
  for (const modal of modals.slice(1)) modal.resolve({ confirm: true });
  await Promise.all([first, second]);
  assert.equal(sent.length, 1);
  assert.equal(modals.length, 2);
  assert.equal(sent[0].acceptedOptionId, 'A');
  assert.equal(p.saving.value, false);
});
