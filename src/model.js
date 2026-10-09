export const STORAGE_KEY = 'solar-flow-state-v1';

export const CATEGORIES = [
  { id: 'food', label: '吃喝', icon: '◒', color: '#f6b65b' },
  { id: 'home', label: '居住', icon: '⌂', color: '#7ad9c6' },
  { id: 'transport', label: '交通', icon: '↗', color: '#a2b4ff' },
  { id: 'communication', label: '通讯', icon: '⌁', color: '#d7a6ff' },
  { id: 'shopping', label: '购物', icon: '◇', color: '#ff8d7a' },
  { id: 'entertainment', label: '娱乐', icon: '✦', color: '#83c6ff' },
  { id: 'health', label: '医疗', icon: '+', color: '#ff9ec4' },
  { id: 'learning', label: '学习', icon: '⌘', color: '#c8d982' },
  { id: 'people', label: '人情', icon: '∿', color: '#f5d17d' },
  { id: 'subscription', label: '订阅', icon: '∞', color: '#98a7b0' },
  { id: 'other', label: '其他', icon: '·', color: '#a8b1b5' }
];

export const INCOME_CATEGORIES = [
  { id: 'income_salary', label: '工资与劳务', icon: '↗', color: '#159b7e' },
  { id: 'income_refund', label: '退款与返还', icon: '↩', color: '#58b69c' },
  { id: 'income_gift', label: '红包与人情', icon: '♡', color: '#e88b7a' },
  { id: 'income_investment', label: '利息与收益', icon: '⌁', color: '#697fd5' },
  { id: 'income_other', label: '其他收入', icon: '＋', color: '#82938a' }
];

export const TRANSACTION_CATEGORIES = [...CATEGORIES, ...INCOME_CATEGORIES];

export const BUCKETS = [
  { id: 'free', label: '自由资金', tone: 'gold', description: '灵活使用', target: false },
  { id: 'emergency', label: '紧急资金', tone: 'coral', description: '为意外情况保留，最后启用', target: false },
  { id: 'life', label: '生活资金', tone: 'mint', description: '日常消费优先从这里支出', target: false },
  { id: 'planned', label: '计划资金', tone: 'blue', description: '为未来目标持续留存', target: true },
  { id: 'other', label: '其他资金', tone: 'slate', description: '尚未分配的总资产余额', target: false }
];

const cents = value => Math.round(Number(value || 0) * 100);

export function makeId(prefix = 'sf') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeText(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, '').replace(/[（）()【】\[\]，,。.!！?？:：\-_]/g, '');
}

export function dateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(date);
}

export function transactionAffectsCurrentAssets(transaction, baselineDate, baselineAt = '') {
  if (!['income', 'expense'].includes(transaction?.direction)) return false;
  const date = String(transaction.date || '');
  if (date > baselineDate) return true;
  if (date < baselineDate) return false;
  // Manual entries retain the time they were entered. Imported rows generally
  // have only a date, so the baseline day itself is treated as already included.
  return Boolean(transaction.createdAt && baselineAt && transaction.createdAt >= baselineAt);
}

function transactionDelta(transaction) {
  return Number(transaction.amountCents || 0) * (transaction.direction === 'income' ? 1 : -1);
}

function inferBaselineCents(totalAssetsCents, transactions = [], baselineDate, baselineAt) {
  const applied = transactions.reduce((sum, transaction) => {
    const wasApplied = transaction.affectsCurrentAssets === undefined
      ? transactionAffectsCurrentAssets(transaction, baselineDate, baselineAt)
      : transaction.affectsCurrentAssets;
    return wasApplied ? sum + transactionDelta(transaction) : sum;
  }, 0);
  return Number(totalAssetsCents || 0) - applied;
}

export function recalculateAssets(state) {
  const settings = state.settings || (state.settings = {});
  const baselineDate = settings.assetBaselineDate || dateKey();
  const baselineAt = settings.assetBaselineAt || '';
  let total = Number(settings.assetBaselineCents ?? settings.totalAssetsCents ?? 0);
  for (const transaction of state.transactions || []) {
    const affects = transactionAffectsCurrentAssets(transaction, baselineDate, baselineAt);
    transaction.affectsCurrentAssets = affects;
    if (affects) total += transactionDelta(transaction);
  }
  settings.totalAssetsCents = total;
  return total;
}

export function initialState() {
  return {
    version: 2,
    updatedAt: new Date().toISOString(),
    activeLedgerId: 'ledger-main',
    ledgers: [{ id: 'ledger-main', name: '我的账本', createdAt: new Date().toISOString(), transactions: [], obligations: [], importBatches: [], allocations: { free: 0, emergency: 0, life: 0, planned: 0 }, plans: [], totalAssetsCents: 0, assetBaselineCents: 0, assetBaselineDate: dateKey(), assetBaselineAt: new Date().toISOString(), plannedTargetCents: 0, history: [] }],
    settings: {
      currency: 'CNY',
      demoMode: false,
      syncStatus: 'not-configured',
      totalAssetsCents: 0,
      assetBaselineCents: 0,
      assetBaselineDate: dateKey(),
      assetBaselineAt: new Date().toISOString(),
      emergencyTargetCents: 0,
      lifeTargetCents: 0,
      plannedTargetCents: 0
    },
    accounts: [],
    billSources: [
      { id: 'wechat-1', label: '微信流水 · 1' },
      { id: 'wechat-2', label: '微信流水 · 2' },
      { id: 'alipay-1', label: '支付宝流水 · 1' },
      { id: 'alipay-2', label: '支付宝流水 · 2' },
      { id: 'bank-1', label: '银行卡流水 · 1' }
    ],
    transactions: [],
    obligations: [],
    importBatches: [],
    plans: [],
    allocations: { free: 0, emergency: 0, life: 0, planned: 0 }
  };
}

export function loadState(storageKey = STORAGE_KEY) {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return initialState();
    const parsed = JSON.parse(raw);
    const base = initialState();
    const settings = { ...base.settings, ...(parsed.settings || {}) };
    if (!Number.isFinite(Number(parsed.settings?.totalAssetsCents))) {
      settings.totalAssetsCents = (parsed.accounts || base.accounts).filter(account => account.kind === 'asset' && account.active).reduce((total, account) => total + Number(account.balanceCents || 0), 0);
    }
    const storedPlans = Array.isArray(parsed.plans) ? parsed.plans : null;
    const migrated = { ...base, ...parsed, obligations: parsed.obligations || [], settings, allocations: { ...base.allocations, ...(parsed.allocations || {}) }, plans: storedPlans || [] };
    if (!Array.isArray(parsed.ledgers) || !parsed.ledgers.length) {
      const transactions = migrated.transactions || [];
      const baselineDate = settings.assetBaselineDate || dateKey();
      const baselineAt = settings.assetBaselineAt || new Date().toISOString();
      const totalAssetsCents = Number(settings.totalAssetsCents || 0);
      const baselineCents = Object.hasOwn(parsed.settings || {}, 'assetBaselineCents')
        ? Number(settings.assetBaselineCents || 0)
        : inferBaselineCents(totalAssetsCents, transactions, baselineDate, baselineAt);
      migrated.ledgers = [{ id: 'ledger-main', name: '我的账本', createdAt: migrated.updatedAt, transactions, obligations: migrated.obligations || [], importBatches: migrated.importBatches || [], allocations: migrated.allocations || base.allocations, plans: storedPlans || undefined, totalAssetsCents, assetBaselineCents: baselineCents, assetBaselineDate: baselineDate, assetBaselineAt: baselineAt, plannedTargetCents: Number(settings.plannedTargetCents || 0), history: [] }];
      migrated.activeLedgerId = 'ledger-main';
    }
    migrated.ledgers = migrated.ledgers.map(ledger => {
      const transactions = ledger.transactions || [];
      const baselineDate = ledger.assetBaselineDate || settings.assetBaselineDate || dateKey();
      const baselineAt = ledger.assetBaselineAt || settings.assetBaselineAt || new Date().toISOString();
      const totalAssetsCents = Number(ledger.totalAssetsCents ?? settings.totalAssetsCents ?? 0);
      const baselineCents = Object.hasOwn(ledger, 'assetBaselineCents')
        ? Number(ledger.assetBaselineCents || 0)
        : ledger.id === migrated.activeLedgerId && Object.hasOwn(parsed.settings || {}, 'assetBaselineCents')
          ? Number(settings.assetBaselineCents || 0)
          : inferBaselineCents(totalAssetsCents, transactions, baselineDate, baselineAt);
      const allocations = { ...base.allocations, ...(ledger.allocations || {}) };
      const plannedTargetCents = Number(ledger.plannedTargetCents ?? settings.plannedTargetCents ?? 0);
      const plans = Array.isArray(ledger.plans)
        ? clone(ledger.plans)
        : allocations.planned > 0 || plannedTargetCents > 0
          ? [{ id: `legacy-plan-${ledger.id}`, name: '原计划资金', amountCents: Number(allocations.planned || 0), targetCents: plannedTargetCents, note: '', coverId: '' }]
          : [];
      // The old single planned bucket is migrated once into a named plan.
      allocations.planned = 0;
      return { ...ledger, transactions, allocations, plans, totalAssetsCents, assetBaselineCents: baselineCents, assetBaselineDate: baselineDate, assetBaselineAt: baselineAt, plannedTargetCents, history: ledger.history || [] };
    });
    const active = migrated.ledgers.find(ledger => ledger.id === migrated.activeLedgerId);
    if (active) {
      settings.totalAssetsCents = active.totalAssetsCents;
      settings.assetBaselineCents = active.assetBaselineCents;
      settings.assetBaselineDate = active.assetBaselineDate;
      settings.assetBaselineAt = active.assetBaselineAt;
      settings.plannedTargetCents = active.plannedTargetCents;
      migrated.allocations = { ...base.allocations, ...(active.allocations || {}) };
      migrated.plans = clone(active.plans || []);
    }
    return migrated;
  } catch {
    return initialState();
  }
}

export function saveState(state, storageKey = STORAGE_KEY) {
  const active = state.ledgers?.find(ledger => ledger.id === state.activeLedgerId);
  if (active) {
    active.transactions = clone(state.transactions || []);
    active.obligations = clone(state.obligations || []);
    active.importBatches = clone(state.importBatches || []);
    active.allocations = clone(state.allocations || {});
    active.plans = clone(state.plans || []);
    active.totalAssetsCents = Number(state.settings?.totalAssetsCents || 0);
    active.assetBaselineCents = Number(state.settings?.assetBaselineCents ?? state.settings?.totalAssetsCents ?? 0);
    active.assetBaselineDate = state.settings?.assetBaselineDate || dateKey();
    active.assetBaselineAt = state.settings?.assetBaselineAt || new Date().toISOString();
    active.plannedTargetCents = Number(state.settings?.plannedTargetCents || 0);
  }
  state.plans = clone(state.plans || []);
  state.updatedAt = new Date().toISOString();
  localStorage.setItem(storageKey, JSON.stringify(state));
  return state;
}

export function sumAssets(state) {
  if (Number.isFinite(Number(state.settings?.totalAssetsCents))) return Number(state.settings.totalAssetsCents);
  return state.accounts.filter(account => account.kind === 'asset' && account.active).reduce((total, account) => total + Number(account.balanceCents || 0), 0);
}

export function sumPlanBalances(state, excludingId = '') {
  return (state.plans || []).reduce((sum, plan) => plan.id === excludingId ? sum : sum + Math.max(0, Number(plan.amountCents || 0)), 0);
}

export function sumAllocated(state, excludingBucket = '', excludingPlanId = '') {
  const bucketTotal = ['free', 'emergency', 'life'].filter(key => key !== excludingBucket)
    .reduce((sum, key) => sum + Math.max(0, Number(state.allocations?.[key] || 0)), 0);
  return bucketTotal + sumPlanBalances(state, excludingPlanId);
}

export function sumLiabilities(state) {
  const obligations = (state.obligations || []).filter(item => item.active !== false && Number(item.balanceCents || 0) > 0);
  if (state.ledgers?.length || obligations.length) return obligations.reduce((total, item) => total + Number(item.balanceCents || 0), 0);
  return Math.abs(state.accounts.filter(account => account.kind === 'credit' || account.kind === 'debt').reduce((total, account) => total + Math.min(0, Number(account.balanceCents || 0)), 0));
}

export function activeLedger(state) {
  return state.ledgers?.find(ledger => ledger.id === state.activeLedgerId) || state.ledgers?.[0];
}

export function pushHistory(state) {
  const ledger = activeLedger(state);
  if (!ledger) return;
  ledger.history = ledger.history || [];
  ledger.history.push({ transactions: clone(state.transactions || []), obligations: clone(state.obligations || []), importBatches: clone(state.importBatches || []), allocations: clone(state.allocations || {}), plans: clone(state.plans || []), totalAssetsCents: Number(state.settings?.totalAssetsCents || 0), assetBaselineCents: Number(state.settings?.assetBaselineCents ?? state.settings?.totalAssetsCents ?? 0), assetBaselineDate: state.settings?.assetBaselineDate || dateKey(), assetBaselineAt: state.settings?.assetBaselineAt || new Date().toISOString(), plannedTargetCents: Number(state.settings?.plannedTargetCents || 0) });
  if (ledger.history.length > 30) ledger.history.shift();
}

export function undoLast(state) {
  const ledger = activeLedger(state);
  const previous = ledger?.history?.pop();
  if (!previous) return false;
  state.transactions = previous.transactions;
  state.obligations = previous.obligations;
  state.importBatches = previous.importBatches;
  state.allocations = previous.allocations;
  state.plans = previous.plans ? clone(previous.plans) : Number(previous.allocations?.planned || 0) > 0 || Number(previous.plannedTargetCents || 0) > 0
    ? [{ id: `legacy-plan-undo-${ledger.id}`, name: '原计划资金', amountCents: Number(previous.allocations?.planned || 0), targetCents: Number(previous.plannedTargetCents || 0), note: '', coverId: '' }]
    : clone(state.plans || []);
  if (!previous.plans) state.allocations.planned = 0;
  state.settings.totalAssetsCents = previous.totalAssetsCents;
  state.settings.assetBaselineCents = Number(previous.assetBaselineCents ?? inferBaselineCents(previous.totalAssetsCents, previous.transactions, previous.assetBaselineDate || dateKey(), previous.assetBaselineAt || ''));
  state.settings.assetBaselineDate = previous.assetBaselineDate || dateKey();
  state.settings.assetBaselineAt = previous.assetBaselineAt || new Date().toISOString();
  state.settings.plannedTargetCents = previous.plannedTargetCents || 0;
  return true;
}

export function activateLedger(state, ledgerId) {
  const current = activeLedger(state);
  if (current) {
    current.transactions = clone(state.transactions || []);
    current.obligations = clone(state.obligations || []);
    current.importBatches = clone(state.importBatches || []);
    current.allocations = clone(state.allocations || {});
    current.plans = clone(state.plans || []);
    current.totalAssetsCents = Number(state.settings?.totalAssetsCents || 0);
    current.assetBaselineCents = Number(state.settings?.assetBaselineCents ?? state.settings?.totalAssetsCents ?? 0);
    current.assetBaselineDate = state.settings?.assetBaselineDate || dateKey();
    current.assetBaselineAt = state.settings?.assetBaselineAt || new Date().toISOString();
    current.plannedTargetCents = Number(state.settings?.plannedTargetCents || 0);
  }
  const next = state.ledgers?.find(ledger => ledger.id === ledgerId);
  if (!next) return false;
  state.activeLedgerId = next.id;
  state.transactions = clone(next.transactions || []);
  state.obligations = clone(next.obligations || []);
  state.importBatches = clone(next.importBatches || []);
  state.allocations = { free: 0, emergency: 0, life: 0, planned: 0, ...(next.allocations || {}) };
  state.plans = clone(next.plans || []);
  state.settings.totalAssetsCents = Number(next.totalAssetsCents || 0);
  state.settings.assetBaselineCents = Number(next.assetBaselineCents ?? next.totalAssetsCents ?? 0);
  state.settings.assetBaselineDate = next.assetBaselineDate || dateKey();
  state.settings.assetBaselineAt = next.assetBaselineAt || new Date().toISOString();
  state.settings.plannedTargetCents = Number(next.plannedTargetCents || 0);
  return true;
}

export function createLedger(state, name) {
  const ledger = { id: makeId('ledger'), name: String(name || '新账本').trim() || '新账本', createdAt: new Date().toISOString(), transactions: [], obligations: [], importBatches: [], allocations: { free: 0, emergency: 0, life: 0, planned: 0 }, plans: [], totalAssetsCents: 0, assetBaselineCents: 0, assetBaselineDate: dateKey(), assetBaselineAt: new Date().toISOString(), plannedTargetCents: 0, history: [] };
  state.ledgers = state.ledgers || [];
  state.ledgers.push(ledger);
  activateLedger(state, ledger.id);
  return ledger;
}

export function clearActiveLedger(state) {
  pushHistory(state);
  state.transactions = [];
  state.obligations = [];
  state.importBatches = [];
  state.plans = [];
  state.allocations = { free: 0, emergency: 0, life: 0, planned: 0 };
  state.settings.totalAssetsCents = 0;
  state.settings.assetBaselineCents = 0;
  state.settings.assetBaselineDate = dateKey();
  state.settings.assetBaselineAt = new Date().toISOString();
  state.settings.plannedTargetCents = 0;
}

export function expenseBuckets(state, expenseCents) {
  let remaining = Math.max(0, Number(expenseCents || 0));
  const legacyPlan = Math.max(0, Number(state.allocations?.planned || 0));
  const plans = state.plans || [];
  const planBalance = plans.reduce((sum, plan) => sum + Math.max(0, Number(plan.amountCents || 0)), 0) + (plans.length ? 0 : legacyPlan);
  const allocated = ['free', 'emergency', 'life'].reduce((sum, key) => sum + Math.max(0, Number(state.allocations?.[key] || 0)), 0) + planBalance;
  const balances = {
    life: Math.max(0, Number(state.allocations?.life || 0)),
    other: Math.max(0, Number(state.settings?.totalAssetsCents || 0) - allocated),
    free: Math.max(0, Number(state.allocations?.free || 0)),
    planned: planBalance,
    emergency: Math.max(0, Number(state.allocations?.emergency || 0))
  };
  const used = {};
  for (const key of ['life', 'other', 'free', 'planned', 'emergency']) {
    used[key] = Math.min(remaining, balances[key]);
    remaining -= used[key];
    if (key === 'planned') {
      let plannedUse = used.planned;
      if (plans.length) {
        for (const plan of plans) {
          const fromPlan = Math.min(plannedUse, Math.max(0, Number(plan.amountCents || 0)));
          plan.amountCents = Math.max(0, Number(plan.amountCents || 0) - fromPlan);
          plannedUse -= fromPlan;
        }
      } else state.allocations.planned = Math.max(0, Number(state.allocations.planned || 0) - used.planned);
    } else if (key !== 'other') state.allocations[key] = Math.max(0, Number(state.allocations[key] || 0) - used[key]);
  }
  return { used, uncovered: remaining };
}

export function netWorth(state) {
  return sumAssets(state) - sumLiabilities(state);
}

export function transactionsInRange(state, from, to = from) {
  return state.transactions.filter(txn => txn.date >= from && txn.date <= to);
}

export function amountFor(state, direction, from, to) {
  return transactionsInRange(state, from, to).filter(txn => txn.direction === direction).reduce((total, txn) => total + Number(txn.amountCents || 0), 0);
}

export function formatMoney(valueCents, options = {}) {
  const value = Number(valueCents || 0) / 100;
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency: options.currency || 'CNY', maximumFractionDigits: 2 }).format(value);
}

export function formatShortMoney(valueCents) {
  const value = Number(valueCents || 0) / 100;
  if (Math.abs(value) >= 10000) return `${value < 0 ? '-' : ''}¥${(Math.abs(value) / 10000).toFixed(1)}万`;
  if (Math.abs(value) >= 1000) return `${value < 0 ? '-' : ''}¥${(Math.abs(value) / 1000).toFixed(1)}k`;
  return `¥${Math.round(value)}`;
}

export function categoryById(id) {
  return TRANSACTION_CATEGORIES.find(category => category.id === id) || CATEGORIES.at(-1);
}

export function accountById(state, id) {
  return state.accounts.find(account => account.id === id);
}

export function periodRange(period = 'month') {
  const now = new Date();
  const end = dateKey(now);
  const start = new Date(now);
  if (period === 'day') start.setDate(now.getDate());
  if (period === 'week') start.setDate(now.getDate() - 6);
  if (period === 'month') start.setDate(1);
  if (period === 'quarter') start.setMonth(now.getMonth() - 2, 1);
  if (period === 'half') start.setMonth(now.getMonth() - 5, 1);
  if (period === 'year') start.setMonth(0, 1);
  return { from: dateKey(start), to: end };
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
