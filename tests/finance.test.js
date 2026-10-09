import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTransaction } from '../src/categorization.js';
import { calendarForReview, emergencyReserveRecommendation, rangeForReview, reviewSeries, robustWeightedAverage, savingsInsight } from '../src/analytics.js';
import { applyImport, matchImportedRows, parseWorkbook } from '../src/importer.js';
import { BUCKETS, activateLedger, clearActiveLedger, createLedger, expenseBuckets, initialState, loadState, pushHistory, sumAllocated, undoLast } from '../src/model.js';

test('merchant rules identify Wallace and China Mobile precisely', () => {
  assert.equal(classifyTransaction({ merchant: '华莱士河南', rawType: '商户消费', direction: 'expense' }).category, 'food');
  assert.equal(classifyTransaction({ merchant: '中国移动', rawType: '充值缴费', direction: 'expense' }).category, 'communication');
});

test('schools and likely person-name merchants follow the requested food default', () => {
  assert.equal(classifyTransaction({ merchant: '武汉工程职业技术学院', rawType: '商户消费' }).category, 'food');
  assert.equal(classifyTransaction({ merchant: 'RuoLi', rawType: '商户消费' }).category, 'food');
  assert.equal(classifyTransaction({ merchant: '李明', rawType: '商户消费' }).category, 'food');
  assert.equal(classifyTransaction({ merchant: '中国移动', rawType: '商户消费' }).category, 'communication');
});

test('only planned funds expose a target', () => {
  assert.deepEqual(BUCKETS.filter(bucket => bucket.target).map(bucket => bucket.id), ['planned']);
});

test('multiple named plans stay separate and expenses follow the configured priority', () => {
  const state = initialState();
  state.settings.totalAssetsCents = 100000;
  state.allocations = { free: 10000, emergency: 20000, life: 10000, planned: 0 };
  state.plans = [
    { id: 'trip', name: '旅行', amountCents: 10000, targetCents: 50000 },
    { id: 'laptop', name: '电脑', amountCents: 10000, targetCents: 80000 }
  ];
  assert.equal(sumAllocated(state), 60000);
  const result = expenseBuckets(state, 80000);
  assert.deepEqual(result.used, { life: 10000, other: 40000, free: 10000, planned: 20000, emergency: 0 });
  assert.equal(result.uncovered, 0);
  assert.deepEqual(state.plans.map(plan => plan.amountCents), [0, 0]);
  assert.equal(state.allocations.emergency, 20000);
});

test('plans persist per ledger and are restored by undo', () => {
  const state = initialState();
  state.settings.totalAssetsCents = 10000;
  state.plans = [{ id: 'trip', name: '旅行', amountCents: 5000, targetCents: 9000, note: '暑假' }];
  pushHistory(state);
  state.plans[0].amountCents = 1000;
  assert.equal(undoLast(state), true);
  assert.equal(state.plans[0].amountCents, 5000);
  const firstLedgerId = state.activeLedgerId;
  createLedger(state, '新账本');
  assert.deepEqual(state.plans, []);
  assert.equal(activateLedger(state, firstLedgerId), true);
  assert.equal(state.plans[0].name, '旅行');
  clearActiveLedger(state);
  assert.deepEqual(state.plans, []);
  assert.equal(undoLast(state), true);
  assert.equal(state.plans[0].name, '旅行');
});

test('legacy single planned allocation migrates into a named plan without changing total allocation', () => {
  const previousStorage = globalThis.localStorage;
  const legacy = {
    activeLedgerId: 'old',
    settings: { totalAssetsCents: 100000, assetBaselineCents: 100000, plannedTargetCents: 80000 },
    ledgers: [{ id: 'old', name: '旧账本', transactions: [], allocations: { free: 10000, emergency: 20000, life: 30000, planned: 40000 }, totalAssetsCents: 100000, assetBaselineCents: 100000, plannedTargetCents: 80000 }]
  };
  globalThis.localStorage = { getItem: () => JSON.stringify(legacy) };
  try {
    const state = loadState();
    assert.equal(state.plans.length, 1);
    assert.equal(state.plans[0].amountCents, 40000);
    assert.equal(state.plans[0].targetCents, 80000);
    assert.equal(state.allocations.planned, 0);
    assert.equal(sumAllocated(state), 100000);
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

test('source taxonomy and uncertain merchants stay distinguishable', () => {
  const source = classifyTransaction({ merchant: '某商户', rawType: '餐饮美食', direction: 'expense' });
  const unknown = classifyTransaction({ merchant: 'Nediya', rawType: '其他', direction: 'expense' });
  assert.equal(source.category, 'food');
  assert.ok(source.confidence > unknown.confidence);
  assert.ok(unknown.confidence < 0.7);
});

test('provider transfer rows are neutral and not counted as expenses', async () => {
  const csv = '交易时间,交易类型,交易对方,收/支,金额,当前状态\n2026-10-08 12:00:00,转账,本人另一微信,支出,20.00,对方已收钱\n2026-10-08 12:01:00,商户消费,华莱士河南,支出,16.80,支付成功';
  const bytes = new TextEncoder().encode(csv);
  const parsed = await parseWorkbook({ name: '微信测试.csv', arrayBuffer: async () => bytes.buffer }, initialState());
  assert.deepEqual(parsed.rows.map(row => row.direction), ['transfer', 'expense']);
  assert.equal(parsed.rows[1].category, 'food');
});

test('import settlement is chronological and only income/expense changes total assets', () => {
  const state = initialState();
  state.settings.assetBaselineDate = '2026-10-09';
  state.settings.assetBaselineAt = '2026-10-09T15:59:59.999Z';
  state.settings.assetBaselineCents = 100000;
  state.settings.totalAssetsCents = 100000;
  const result = applyImport(state, [
    { date: '2026-10-09', direction: 'income', amountCents: 33333, category: 'income_salary', match: 'new', importRow: 1 },
    { date: '2026-10-11', direction: 'expense', amountCents: 10000, category: 'food', match: 'new', importRow: 1 },
    { date: '2026-10-10', direction: 'transfer', amountCents: 50000, category: 'other', match: 'new', importRow: 2 },
    { date: '2026-10-10', direction: 'expense', amountCents: 80000, category: 'food', match: 'new', importRow: 3 }
  ], { fileName: 'test.csv' });
  assert.deepEqual(result.imported.map(row => row.date), ['2026-10-09', '2026-10-10', '2026-10-10', '2026-10-11']);
  assert.equal(state.settings.totalAssetsCents, 10000);
  assert.equal(state.transactions.find(row => row.date === '2026-10-09').affectsCurrentAssets, false);
});

test('delayed imports replay against an explicit opening-balance date', () => {
  const state = initialState();
  state.settings.assetBaselineDate = '2026-07-08';
  state.settings.assetBaselineAt = '2026-07-09T07:59:59.999Z';
  state.settings.assetBaselineCents = 400000;
  state.settings.totalAssetsCents = 400000;
  const result = applyImport(state, [
    { date: '2026-07-07', direction: 'expense', amountCents: 99000, category: 'food', match: 'new', importRow: 2 },
    { date: '2026-07-09', direction: 'expense', amountCents: 25000, category: 'food', match: 'new', importRow: 3 },
    { date: '2026-07-10', direction: 'income', amountCents: 80000, category: 'income_salary', match: 'new', importRow: 4 },
    { date: '2026-07-10', direction: 'transfer', amountCents: 100000, category: 'other', match: 'new', importRow: 5 }
  ], { fileName: 'three-months.csv' });
  assert.equal(result.imported.length, 4);
  assert.equal(state.settings.totalAssetsCents, 455000);
  assert.equal(state.transactions.find(row => row.direction === 'transfer').affectsCurrentAssets, false);
  assert.equal(state.transactions.find(row => row.date === '2026-07-07').affectsCurrentAssets, false);
});

test('re-importing an overlapping bill is deduplicated and does not change assets twice', () => {
  const state = initialState();
  state.settings.assetBaselineDate = '2026-01-01';
  state.settings.assetBaselineCents = 500000;
  state.settings.totalAssetsCents = 500000;
  const row = { id: 'row-1', date: '2026-02-03', direction: 'expense', amountCents: 1299, category: 'food', merchant: '华莱士', sourceId: 'wechat-1', externalId: 'wx-123', source: 'imported', match: 'new' };
  applyImport(state, [row], { fileName: 'three-months.xlsx' });
  assert.equal(state.settings.totalAssetsCents, 498701);
  const overlapping = matchImportedRows([{ ...row, id: 'row-2' }], state.transactions);
  assert.equal(overlapping[0].match, 'duplicate');
  const repeated = applyImport(state, overlapping, { fileName: 'one-year.xlsx' });
  assert.equal(repeated.imported.length, 0);
  assert.equal(state.transactions.length, 1);
  assert.equal(state.settings.totalAssetsCents, 498701);
});

test('review periods, calendar aggregation, and income/expense series use the selected range', () => {
  const now = new Date();
  const anchor = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-09`;
  const range = rangeForReview('month', anchor);
  assert.equal(range.from.slice(8), '01');
  const rows = [
    { date: `${anchor.slice(0,7)}-02`, direction: 'expense', amountCents: 1200 },
    { date: `${anchor.slice(0,7)}-02`, direction: 'income', amountCents: 3000 }
  ];
  assert.equal(calendarForReview(rows, 'month', anchor, 'expense').days[1].amount, 1200);
  assert.equal(reviewSeries(rows, 'month', anchor, 'income').at(-1).amount, 3000);
});

test('robust monthly baseline resists a one-off income/spending spike', () => {
  const baseline = robustWeightedAverage([100000, 110000, 90000, 10000000]);
  assert.ok(baseline < 250000);
  assert.ok(baseline > 90000);
});

test('emergency reserve reference line adapts to robust recent essential spending', () => {
  const rows = [
    { date: '2026-07-08', direction: 'expense', amountCents: 100000, category: 'food' },
    { date: '2026-08-08', direction: 'expense', amountCents: 110000, category: 'food' },
    { date: '2026-09-08', direction: 'expense', amountCents: 1000000, category: 'food' },
    { date: '2026-10-03', direction: 'expense', amountCents: 9000000, category: 'food' }
  ];
  const advice = emergencyReserveRecommendation(rows, '2026-10-09');
  assert.equal(advice.sampleMonths, 3);
  assert.equal(advice.provisional, false);
  assert.equal(advice.basis, 'essential');
  assert.ok(advice.targetCents > 0);
  assert.ok(advice.targetCents < 600000, 'a one-off month should not dominate the suggested line');
  assert.equal(emergencyReserveRecommendation([], '2026-10-09').targetCents, 0);
});

test('emergency reserve line is visibly provisional with fewer than three recorded months', () => {
  const advice = emergencyReserveRecommendation([
    { date: '2026-07-08', direction: 'expense', amountCents: 10000, category: 'food' },
    { date: '2026-08-08', direction: 'expense', amountCents: 12000, category: 'food' }
  ], '2026-10-09');
  assert.equal(advice.sampleMonths, 2);
  assert.equal(advice.provisional, true);
  assert.equal(advice.targetCents, 33000);
});

test('income-only months do not dilute the emergency reserve reference', () => {
  const rows = [
    { date: '2026-07-08', direction: 'expense', amountCents: 10000, category: 'food' },
    { date: '2026-07-15', direction: 'income', amountCents: 300000, category: 'salary' },
    { date: '2026-08-08', direction: 'expense', amountCents: 12000, category: 'food' },
    { date: '2026-08-15', direction: 'income', amountCents: 300000, category: 'salary' }
  ];
  const advice = emergencyReserveRecommendation(rows, '2026-10-09');
  assert.equal(advice.sampleMonths, 2);
  assert.equal(advice.targetCents, 33000);
});

test('savings guidance waits for enough observed months', () => {
  const rows = [
    { date: '2026-07-02', direction: 'expense', amountCents: 30000, category: 'food' },
    { date: '2026-08-02', direction: 'expense', amountCents: 32000, category: 'food' }
  ];
  const insight = savingsInsight(rows, { totalAssetsCents: 50000 }, '2026-10-09');
  assert.equal(insight.kind, 'neutral');
  assert.match(insight.title, /节奏/);
});
