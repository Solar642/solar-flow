import './style.css';
import {
  BUCKETS, CATEGORIES, INCOME_CATEGORIES, activateLedger, amountFor, categoryById, clearActiveLedger, clone, createLedger, dateKey, expenseBuckets,
  formatMoney, formatShortMoney, initialState, loadState, makeId, netWorth, STORAGE_KEY,
  periodRange, pushHistory, recalculateAssets, saveState, sumAllocated, sumAssets, sumLiabilities, sumPlanBalances, transactionAffectsCurrentAssets, transactionsInRange, undoLast
} from './model.js';
import { applyImport, matchImportedRows, parseWorkbook } from './importer.js';
import { transactionCategories } from './categorization.js';
import { calendarForReview, periodTitle, previousRange, rangeForReview, reviewSeries, savingsInsight, shiftReviewAnchor } from './analytics.js';

const root = document.querySelector('#app');
let state = loadState();
let storageKey = STORAGE_KEY;
let firebaseApi = null;
let syncApi = null;
let authServices = null;
let authObserver = null;
let syncEngine = null;
let signedInUser = null;
let pendingAccountUser = null;
let authMode = 'signin';
let syncStatus = { status: firebaseIsConfigured() ? 'signed-out' : 'unconfigured', message: '' };
let view = 'overview';
let period = 'month';
let transactionFilter = 'all';
let chartMode = 'line';
let reviewScope = 'month';
let reviewMetric = 'expense';
let reviewTab = 'summary';
let reviewAnchor = '';
let selectedReviewDay = '';
let modal = null;
let lockedModalScrollY = null;
let importSession = null;
let planCoverUrls = [];
let modalCoverPreviewUrl = '';

const accountStorageKey = uid => `${STORAGE_KEY}:user:${uid}`;

function firebaseIsConfigured() {
  return Boolean(import.meta.env.VITE_FIREBASE_API_KEY && import.meta.env.VITE_FIREBASE_AUTH_DOMAIN && import.meta.env.VITE_FIREBASE_PROJECT_ID && import.meta.env.VITE_FIREBASE_APP_ID);
}

function persistState({ sync = true } = {}) {
  saveState(state, storageKey);
  if (sync && syncEngine && signedInUser?.emailVerified) syncEngine.localStateChanged();
}

function hasLocalLedgerData(value) {
  return Boolean(
    value.transactions?.length || value.obligations?.length || value.plans?.length || value.ledgers?.length > 1 ||
    Number(value.settings?.totalAssetsCents || 0) || Object.values(value.allocations || {}).some(amount => Number(amount) > 0) ||
    value.ledgers?.some(ledger => ledger.transactions?.length || ledger.obligations?.length || ledger.plans?.length) ||
    value.categoryRules?.length || value.accounts?.some(account => Number(account.balanceCents || 0))
  );
}

function describeSyncStatus() {
  const labels = {
    unconfigured: '未配置', 'signed-out': '未登录', verifying: '待验证', 'awaiting-merge': '等待确认',
    connecting: '连接中', syncing: '同步中', synced: '已同步', offline: '离线 · 待同步', error: '同步异常'
  };
  return labels[syncStatus.status] || '未连接';
}

async function activateVerifiedAccount(user, mergeLocal = true, { cloudOnly = false } = {}) {
  syncEngine?.stop();
  syncEngine = null;
  if (!firebaseApi) firebaseApi = await import('./firebase.js');
  if (!syncApi) syncApi = await import('./sync.js');
  signedInUser = user;
  const nextKey = accountStorageKey(user.uid);
  if (cloudOnly) {
    storageKey = nextKey;
    state = initialState();
    syncApi.prepareLocalMerge(state);
  }
  if (mergeLocal) {
    storageKey = nextKey;
    syncApi.prepareLocalMerge(state);
    saveState(state, storageKey);
  } else if (!cloudOnly) {
    storageKey = nextKey;
    state = loadState(storageKey);
    saveState(state, storageKey);
  } else {
    storageKey = nextKey;
    saveState(state, storageKey);
  }
  syncStatus = { status: 'connecting', message: '' };
  const db = await firebaseApi.getFirebaseDatabase(authServices.app);
  syncEngine = syncApi.startCloudSync(db, user.uid, {
    getState: () => state,
    setState: next => { state = next; },
    persistLocal: () => saveState(state, storageKey),
    onStatus: next => {
      const permissionError = /permission-denied|insufficient permissions/i.test(next.message || '');
      syncStatus = permissionError
        ? { ...next, message: '云端拒绝访问，请确认邮箱已验证且 Firestore 安全规则已部署。' }
        : next;
      if (!modal && view === 'settings') render();
    },
    onRemoteState: () => { if (!modal) render(); }
  });
  modal = null;
  render();
}

async function handleAuthState(user) {
  if (!user) {
    syncEngine?.stop();
    syncEngine = null;
    signedInUser = null;
    pendingAccountUser = null;
    syncStatus = { status: firebaseIsConfigured() ? 'signed-out' : 'unconfigured', message: '' };
    if (storageKey !== STORAGE_KEY) {
      storageKey = STORAGE_KEY;
      state = loadState(storageKey);
      modal = null;
    }
    render();
    return;
  }

  signedInUser = user;
  if (!user.emailVerified) {
    syncEngine?.stop();
    syncEngine = null;
    syncStatus = { status: 'verifying', message: '' };
    render();
    return;
  }

  const nextKey = accountStorageKey(user.uid);
  if (storageKey === nextKey && syncEngine) { render(); return; }
  const existingAccountState = localStorage.getItem(nextKey);
  if (!existingAccountState && hasLocalLedgerData(state)) {
    if (pendingAccountUser?.uid === user.uid) return;
    pendingAccountUser = user;
    syncStatus = { status: 'awaiting-merge', message: '' };
    modal = { type: 'sync-import' };
    render();
    return;
  }
  pendingAccountUser = null;
  if (existingAccountState) {
    storageKey = nextKey;
    state = loadState(storageKey);
  } else {
    state = loadState(nextKey);
  }
  await activateVerifiedAccount(user, false);
}

async function initializeFirebaseAuth() {
  if (!firebaseIsConfigured()) return;
  try {
    firebaseApi = await import('./firebase.js');
    authServices = firebaseApi.getFirebaseServices();
    await firebaseApi.prepareEmailAuth(authServices.auth);
    authObserver = firebaseApi.observeAuth(authServices.auth, handleAuthState, error => {
      syncStatus = { status: 'error', message: error?.message || '账号状态读取失败' };
      if (view === 'settings' && !modal) render();
    });
    window.addEventListener('focus', async () => {
      const user = authServices?.auth?.currentUser;
      if (!user) return;
      try { await user.reload(); await handleAuthState(user); } catch { /* Keep local access during temporary network failures. */ }
    });
  } catch (error) {
    syncStatus = { status: 'error', message: error?.message || '同步初始化失败' };
    if (view === 'settings') render();
  }
}

const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const today = () => dateKey(new Date());
reviewAnchor = today();
const signedMoney = (direction, amount) => `${direction === 'transfer' ? '⇄ ' : direction === 'expense' ? '-' : '+'}${formatMoney(amount)}`;

const iconPaths = {
  food: '<path d="M6 3v7m-3-7v4a3 3 0 0 0 6 0V3M6 10v11M15 3c-2 2-3 5-3 8h6V3m-3 8v10"/>',
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-6v-7h-4v7H4a1 1 0 0 1-1-1z"/>',
  transport: '<path d="M5 17h14l-1.2-7.2A2 2 0 0 0 15.8 8H8.2a2 2 0 0 0-2 1.8L5 17Zm0 0v3m14-3v3M7 13h.01M17 13h.01M7 17v2m10-2v2M4 17h16"/>',
  communication: '<rect x="6" y="2.5" width="12" height="19" rx="2.2"/><path d="M10 18.5h4"/>',
  shopping: '<path d="M5 8h14l1 13H4L5 8Zm3 0V6a4 4 0 0 1 8 0v2"/>',
  entertainment: '<path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Zm7 12 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"/>',
  health: '<path d="M12 3v18M3 12h18"/>',
  learning: '<path d="M3 5.5A2.5 2.5 0 0 1 5.5 3H12v17H5.5A2.5 2.5 0 0 0 3 22V5.5Zm18 0A2.5 2.5 0 0 0 18.5 3H12v17h6.5A2.5 2.5 0 0 1 21 22V5.5Z"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0m2-11a3 3 0 0 1 0 6m1 2a5 5 0 0 1 3 3"/>',
  subscription: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.5 9A7 7 0 0 1 18 6l2 2M4 16l2 2a7 7 0 0 0 12.5-3"/>',
  other: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 5V3h12v12M8 10h8m-8 4h6"/>',
  income_salary: '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18M8 6V4h8v2m-5 8h2"/>',
  income_refund: '<path d="M4 8V4m0 4h4M5 8a8 8 0 1 1-1 7m8-7v5l3 2"/>',
  income_gift: '<path d="M3 10h18v11H3zM2 6h20v4H2zm10 0v15M12 6H8a2 2 0 1 1 2-2c0 1.1 2 2 2 2Zm0 0h4a2 2 0 1 0-2-2c0 1.1-2 2-2 2Z"/>',
  income_investment: '<path d="M3 19h18M5 16l5-5 4 3 6-7m-4 0h4v4"/>',
  income_other: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8m-4-4h8"/>',
  free: '<circle cx="12" cy="12" r="9"/><path d="m12 6 1.6 4.4L18 12l-4.4 1.6L12 18l-1.6-4.4L6 12l4.4-1.6L12 6Z"/>',
  emergency: '<path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="M12 8v8m-4-4h8"/>',
  planned: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  transfer: '<path d="M7 7h13l-3-3m3 3-3 3M17 17H4l3 3m-3-3 3-3"/>',
  overview: '<rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="5" rx="2"/><rect x="13" y="10" width="8" height="11" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/>',
  transactions: '<path d="M4 6h16M4 12h16M4 18h16M8 4 5 6l3 2m8 2 3 2-3 2m-8 2-3 2 3 2"/>',
  review: '<rect x="3" y="4" width="18" height="17" rx="3"/><path d="M16 2v4M8 2v4M3 9h18m-13 5h3m-3 4h7"/>',
  obligations: '<path d="M12 3 21 8v8l-9 5-9-5V8l9-5Z"/><path d="m8 12 2.5 2.5L16 9"/>',
  ledgers: '<path d="M5 3h12l3 3v15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm12 0v4h4M7 11h10m-10 4h10m-10 4h6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.7a8 8 0 0 1-1.5.9l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.5-.9l-1.7.7-1.4-2.4 1.4-1.1a7 7 0 0 1 0-1.8l-1.4-1.1 1.4-2.4 1.7.7a8 8 0 0 1 1.5-.9l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.5.9l1.7-.7 1.4 2.4-1.4 1.1a7 7 0 0 1 0 1.8Z"/>',
};

function categoryGlyph(id) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[id] || iconPaths.other}</svg>`;
}

function notify(message, tone = 'success') {
  const node = document.createElement('div');
  node.className = `toast ${tone}`;
  node.textContent = message;
  document.body.append(node);
  setTimeout(() => node.remove(), 3200);
}

function animateCounters() {
  const counters = document.querySelectorAll('[data-countup]');
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  counters.forEach(node => {
    const target = Number(node.dataset.countup || 0);
    if (reduced || target === 0) { node.textContent = formatMoney(target); return; }
    const started = performance.now();
    const duration = 700;
    const frame = now => {
      const progress = Math.min(1, (now - started) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      node.textContent = formatMoney(Math.round(target * eased));
      if (progress < 1) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

function syncModalViewportLock() {
  if (modal && lockedModalScrollY === null) {
    lockedModalScrollY = window.scrollY;
    document.body.classList.add('modal-open');
    document.body.style.top = `-${lockedModalScrollY}px`;
  } else if (!modal && lockedModalScrollY !== null) {
    const scrollY = lockedModalScrollY;
    lockedModalScrollY = null;
    document.body.classList.remove('modal-open');
    document.body.style.removeProperty('top');
    window.scrollTo(0, scrollY);
  }
}

function render() {
  syncModalViewportLock();
  planCoverUrls.forEach(url => URL.revokeObjectURL(url));
  planCoverUrls = [];
  if (modalCoverPreviewUrl) URL.revokeObjectURL(modalCoverPreviewUrl);
  modalCoverPreviewUrl = '';
  root.innerHTML = `
    <div class="app-shell">
      ${sidebar()}
      <main class="main-content">
        ${topbar()}
        <div class="page-body">${view === 'overview' ? overview() : view === 'transactions' ? transactionsPage() : view === 'review' ? reviewPage() : view === 'plan' ? planPage() : view === 'obligations' ? obligationsPage() : view === 'ledgers' ? ledgersPage() : settingsPage()}</div>
      </main>
    </div>
    ${modalMarkup()}
  `;
  animateCounters();
  bindEvents();
  hydratePlanCovers();
}

function openCoverDatabase() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('此浏览器不支持离线图片存储'));
    const request = indexedDB.open('solar-flow-media-v1', 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('covers')) request.result.createObjectStore('covers'); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开图片存储'));
  });
}

async function storePlanCover(file) {
  const db = await openCoverDatabase();
  const id = makeId('cover');
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('covers', 'readwrite');
    transaction.objectStore('covers').put(file, id);
    transaction.oncomplete = () => { db.close(); resolve(id); };
    transaction.onerror = () => { db.close(); reject(transaction.error || new Error('图片保存失败'));
    };
  });
}

async function hydratePlanCovers() {
  const images = [...document.querySelectorAll('img[data-cover-id]')];
  if (!images.length) return;
  let db;
  try { db = await openCoverDatabase(); }
  catch { images.forEach(image => image.classList.add('cover-unavailable')); return; }
  for (const image of images) {
    if (!image.isConnected || image.src) continue;
    try {
      const blob = await new Promise((resolve, reject) => {
        const transaction = db.transaction('covers', 'readonly');
        const request = transaction.objectStore('covers').get(image.dataset.coverId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (!blob || !image.isConnected) continue;
      const url = URL.createObjectURL(blob);
      planCoverUrls.push(url);
      image.src = url;
      image.addEventListener('error', () => {
        image.classList.add('cover-unavailable');
        image.closest('.plan-card')?.classList.add('cover-unavailable');
      }, { once: true });
    } catch {
      image.classList.add('cover-unavailable');
    }
  }
  db.close();
}

function sidebar() {
  const items = [
    ['overview', '总览'],
    ['transactions', '流水'],
    ['review', '收支复盘'],
    ['plan', '资金分配'],
    ['obligations', '借款与信用'],
    ['ledgers', '账本管理'],
    ['settings', '设置与同步']
  ];
  return `<aside class="sidebar">
    <div class="brand"><img class="brand-mark" src="/solar-flow/favicon.svg?v=2" alt="" aria-hidden="true" /><div><strong>Solar Flow</strong><small>让钱流向生活</small></div></div>
    <nav class="nav-list" aria-label="主导航">${items.map(([id, label]) => `<button class="nav-item ${view === id ? 'active' : ''}" data-nav="${id}"><span class="nav-icon">${categoryGlyph(id)}</span><span>${label}</span></button>`).join('')}</nav>
    <div class="sidebar-bottom">
      <div class="offline-pill"><i></i><span>本机离线可用</span></div>
      <div class="profile-chip"><img class="avatar" src="/solar-flow/favicon.svg?v=2" alt="" aria-hidden="true" /><div><strong>Solar Flow</strong><small>人民币 · 个人版</small></div></div>
    </div>
  </aside>`;
}

function topbar() {
  const names = { overview: '总览', transactions: '全部流水', review: '收支复盘', plan: '资金分配', obligations: '借款与信用', ledgers: '账本管理', settings: '设置与同步' };
  const ledger = state.ledgers?.find(item => item.id === state.activeLedgerId);
  return `<header class="topbar"><div><p class="eyebrow">${today()} · ${navigator.onLine ? '在线' : '离线'} · ${esc(ledger?.name || '我的账本')}</p><h1>${names[view]}</h1></div><div class="top-actions"><button class="primary-button import-button" data-open-import title="导入账单">⇧ <span>导入账单</span></button><button class="outline-button quick-action" data-open-quick>＋ 记一笔</button></div></header>`;
}

function overview() {
  const range = periodRange(period);
  const expenses = amountFor(state, 'expense', range.from, range.to);
  const income = amountFor(state, 'income', range.from, range.to);
  const delta = income - expenses;
  const assets = sumAssets(state);
  const liabilities = sumLiabilities(state);
  const categories = categoryTotals(range);
  const latest = state.transactions.filter(txn => txn.direction !== 'transfer' && txn.direction !== 'excluded').sort((a, b) => `${b.date}${b.id}`.localeCompare(`${a.date}${a.id}`)).slice(0, 8);
  return `<section class="hero-grid">
    <div class="net-worth-card panel-card">
      <div class="card-heading"><div><span class="eyebrow">当前总资产</span><h2>${formatMoney(assets)}</h2></div><div class="sun-orb"><span></span></div></div>
      <div class="net-worth-meta"><span>净资产 ${formatMoney(netWorth(state))}</span><span class="trend-up">${delta >= 0 ? '↗' : '↘'} ${formatMoney(Math.abs(delta))} ${periodLabel(period)}</span></div>
      ${assetBars()}
    </div>
    <div class="quick-card panel-card"><div class="card-heading"><div><span class="eyebrow">快速记录</span><h3>今天发生了什么？</h3></div><span class="spark">✦</span></div><button class="outline-button" data-open-quick>添加一笔支出或收入 <span>→</span></button><div class="quick-note"><i></i>数据先保存在本机，离线也能用</div></div>
  </section>
  <section class="stats-grid">
    ${statCard('本期支出', formatMoney(expenses), 'expense', `${periodLabel(period)} · ${categories.length} 个分类`)}
    ${statCard('本期收入', formatMoney(income), 'income', `${periodLabel(period)} · ${income ? '有进账' : '待记录'}`)}
    ${statCard('负债余额', formatMoney(liabilities), 'debt', liabilities ? '信用卡与借款' : '目前没有负债')}
  </section>
  <section class="section-head"><div><h2>收支趋势</h2></div><div class="period-switcher">${['day', 'week', 'month', 'quarter', 'half', 'year'].map(id => `<button class="${period === id ? 'active' : ''}" data-period="${id}">${periodLabel(id)}</button>`).join('')}</div></section>
  <section class="charts-grid"><div class="panel-card trend-card"><div class="chart-title"><div><strong>本期净流量</strong><span>${range.from} — ${range.to} · 收入减支出</span></div><div class="chart-tools"><div class="chart-mode-switch" role="group" aria-label="图表样式"><button class="${chartMode === 'line' ? 'active' : ''}" data-chart-mode="line" aria-pressed="${chartMode === 'line'}">趋势图</button><button class="${chartMode === 'bar' ? 'active' : ''}" data-chart-mode="bar" aria-pressed="${chartMode === 'bar'}">柱状图</button></div><span class="chart-badge">CNY</span></div></div>${chartMode === 'line' ? trendChart(range) : barChart(range)}</div><div class="panel-card category-card"><div class="chart-title"><div><strong>支出构成</strong><span>${periodLabel(period)} · 不含内部转账</span></div><button class="text-button" data-nav="transactions">查看明细 →</button></div>${donutChart(categories)}</div></section>
  <section class="bottom-grid"><div class="panel-card recent-card"><div class="chart-title"><div><strong>最近流水</strong><span>手动与导入记录都在这里</span></div><button class="text-button" data-nav="transactions">全部流水 →</button></div>${transactionRows(latest)}</div><div class="panel-card health-card"><div class="chart-title"><div><strong>资金安全层</strong><span>余额与消费顺序</span></div><span class="health-dot"></span></div>${healthSummary()}</div></section>`;
}

function statCard(label, value, kind, sub) {
  return `<div class="stat-card panel-card"><span class="eyebrow">${label}</span><strong class="stat-value ${kind}">${value}</strong><span class="stat-sub">${sub}</span><div class="mini-line ${kind}"></div></div>`;
}

function assetBars() {
  const imported = state.transactions.filter(txn => txn.source === 'imported' || txn.source === 'merged').length;
  return `<div class="asset-stack aggregate-stack"><span></span><span></span><span></span></div><div class="asset-legend aggregate-legend"><span><i class="legend-sun"></i>所有来源合并计算</span><span><i class="legend-mint"></i>${imported ? `已纳入 ${imported} 条账单流水` : '等待导入历史账单'}</span><span class="muted">互相转账不重复计入总资产</span></div>`;
}

function trendChart(range) {
  const days = dateList(range.from, range.to);
  let running = 0;
  const points = days.map(day => {
    const txns = state.transactions.filter(txn => txn.date === day);
    const flow = txns.reduce((sum, txn) => sum + (txn.direction === 'income' ? txn.amountCents : txn.direction === 'expense' ? -txn.amountCents : 0), 0);
    running += flow;
    return running;
  });
  const hasData = transactionsInRange(state, range.from, range.to).some(txn => txn.direction === 'income' || txn.direction === 'expense');
  if (!hasData) return `<div class="chart-empty"><span>↗</span><strong>趋势正在等第一笔记录</strong><p>有了收入或支出后，这里会绘出本期的资金流动。</p></div>`;
  const visible = points.length > 40 ? points.filter((_, index) => index % Math.ceil(points.length / 30) === 0) : points;
  const max = Math.max(1, ...visible.map(value => Math.abs(value)));
  const width = 720; const height = 220; const pad = 20;
  const coords = visible.map((value, index) => `${pad + (index / Math.max(1, visible.length - 1)) * (width - pad * 2)},${height / 2 - (value / max) * (height / 2 - 30)}`).join(' ');
  const fill = `M ${pad},${height / 2} ${coords.replace(/ /g, ' L ')} L ${width - pad},${height / 2} Z`;
  const coordsList = visible.map((value, index) => ({ x: pad + (index / Math.max(1, visible.length - 1)) * (width - pad * 2), y: height / 2 - (value / max) * (height / 2 - 30) }));
  const smoothPath = coordsList.map((point, index, all) => {
    if (index === 0) return `M ${point.x} ${point.y}`;
    const prev = all[index - 1]; const before = all[Math.max(0, index - 2)]; const next = all[Math.min(all.length - 1, index + 1)];
    const c1x = prev.x + (point.x - before.x) / 6; const c1y = prev.y + (point.y - before.y) / 6;
    const c2x = point.x - (next.x - prev.x) / 6; const c2y = point.y - (next.y - prev.y) / 6;
    return `C ${c1x} ${c1y}, ${c2x} ${c2y}, ${point.x} ${point.y}`;
  }).join(' ');
  return `<div class="trend-wrap"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="本期累计净流量趋势"><defs><linearGradient id="solarFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#f6b65b" stop-opacity=".28"/><stop offset="1" stop-color="#f6b65b" stop-opacity="0"/></linearGradient></defs><line x1="20" x2="700" y1="110" y2="110" stroke="rgba(255,255,255,.14)" stroke-dasharray="5 8"/><path class="trend-area-reveal" d="${fill}" fill="url(#solarFill)"/><path class="trend-line-draw" d="${smoothPath}" pathLength="1000" fill="none" stroke="#f6b65b" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>${visible.map((value, index) => index === visible.length - 1 ? `<circle class="trend-endpoint" cx="${coordsList[index].x}" cy="${coordsList[index].y}" r="6" fill="#fff" stroke="#f6b65b" stroke-width="3"/>` : '').join('')}</svg><div class="axis-labels"><span>${range.from.slice(5)}</span><span>${range.to.slice(5)}</span></div></div>`;
}

function barChart(range) {
  const rows = transactionsInRange(state, range.from, range.to).filter(txn => ['income', 'expense'].includes(txn.direction));
  if (!rows.length) return `<div class="chart-empty"><span>▥</span><strong>柱状图正在等第一笔记录</strong><p>收入与支出会按当前周期汇总成柱。</p></div>`;
  const from = new Date(`${range.from}T12:00:00`); const to = new Date(`${range.to}T12:00:00`);
  const dayCount = Math.floor((to - from) / 86400000) + 1;
  const groupBy = dayCount <= 9 ? 'day' : dayCount <= 70 ? 'week' : window.matchMedia('(max-width: 430px)').matches && dayCount > 150 ? 'bi-month' : 'month';
  const buckets = new Map();
  for (const txn of rows) {
    const date = new Date(`${txn.date}T12:00:00`);
    let key; let label;
    if (groupBy === 'day') { key = txn.date; label = `${date.getMonth() + 1}/${date.getDate()}`; }
    else if (groupBy === 'week') { const monday = new Date(date); monday.setDate(date.getDate() - ((date.getDay() + 6) % 7)); key = dateKey(monday); label = `${monday.getMonth() + 1}/${monday.getDate()}`; }
    else if (groupBy === 'bi-month') { const month = date.getMonth() + 1; const startMonth = Math.floor((month - 1) / 2) * 2 + 1; key = `${txn.date.slice(0, 4)}-${String(startMonth).padStart(2, '0')}`; label = `${startMonth}-${startMonth + 1}月`; }
    else { key = txn.date.slice(0, 7); label = `${date.getMonth() + 1}月`; }
    const value = buckets.get(key) || { label, net: 0 };
    value.net += txn.direction === 'income' ? txn.amountCents : -txn.amountCents;
    buckets.set(key, value);
  }
  const values = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, item]) => item).slice(-12);
  const max = Math.max(1, ...values.map(item => Math.abs(item.net)));
  const columns = values.map(item => {
    const tone = item.net > 0 ? 'positive' : item.net < 0 ? 'negative' : 'neutral';
    const amount = Math.abs(item.net) / 100;
    const compact = amount >= 10000 ? `${(amount / 10000).toFixed(amount >= 100000 ? 0 : 1)}万` : amount >= 1000 ? `${(amount / 1000).toFixed(amount >= 10000 ? 0 : 1)}k` : amount.toFixed(amount < 10 ? 2 : amount < 100 ? 1 : 0);
    const label = `${item.net > 0 ? '+' : item.net < 0 ? '−' : ''}${compact}`;
    const fullValue = `${item.net > 0 ? '净流入' : item.net < 0 ? '净流出' : '持平'} ${formatMoney(Math.abs(item.net))}`;
    return `<div class="bar-value ${tone}" title="${esc(item.label)} · ${esc(fullValue)}" aria-label="${esc(item.label)} ${esc(fullValue)}">${label || '0'}</div>`;
  }).join('');
  const bars = values.map((item, index) => {
    const tone = item.net > 0 ? 'positive' : item.net < 0 ? 'negative' : 'neutral';
    const size = Math.max(item.net === 0 ? 0 : 3, Math.abs(item.net) / max * 44);
    const fullValue = `${item.net > 0 ? '净流入' : item.net < 0 ? '净流出' : '持平'} ${formatMoney(Math.abs(item.net))}`;
    const delay = Math.min(index, 11) * 35;
    return `<div class="bar-column-cell" role="img" aria-label="${esc(item.label)} ${esc(fullValue)}"><span class="bar-column ${tone}" style="--bar-size:${size};--bar-delay:${delay}ms"></span></div>`;
  }).join('');
  const dates = values.map(item => `<span title="${esc(item.label)}">${esc(item.label)}</span>`).join('');
  return `<div class="trend-wrap bar-wrap"><div class="bar-chart" style="--bar-count:${values.length}" role="img" aria-label="本期收入减支出柱状图"><div class="bar-values">${columns}</div><div class="bar-plot-area">${bars}</div><div class="bar-dates">${dates}</div></div><div class="bar-legend"><span><i class="positive-dot"></i>净流入</span><span><i class="negative-dot"></i>净流出</span></div></div>`;
}

function donutChart(categories, metric = 'expense') {
  if (!categories.length) return `<div class="chart-empty chart-empty-donut"><span>◌</span><strong>${metric === 'expense' ? '支出' : '收入'}分类还没有数据</strong><p>记录几笔${metric === 'expense' ? '支出' : '收入'}后，类别构成会在这里展开。</p></div>`;
  const allTotal = categories.reduce((sum, item) => sum + item.amount, 0);
  const shown = categories.length > 5 ? [...categories.slice(0, 4), { id: 'more', label: '其他分类', color: '#bac4bf', amount: categories.slice(4).reduce((sum, item) => sum + item.amount, 0) }] : categories;
  const total = allTotal || 1;
  let cursor = 0;
  const segments = shown.map((item, index) => {
    const startAngle = -90 + cursor / total * 360;
    const sweep = item.amount / total * 359.8;
    cursor += item.amount;
    const endAngle = startAngle + sweep;
    const point = angle => [90 + 67 * Math.cos(angle * Math.PI / 180), 90 + 67 * Math.sin(angle * Math.PI / 180)];
    const [x1, y1] = point(startAngle); const [x2, y2] = point(endAngle);
    const path = `M ${x1} ${y1} A 67 67 0 ${sweep > 180 ? 1 : 0} 1 ${x2} ${y2}`;
    return `<path class="donut-segment" style="--segment-delay:${index * 55}ms;--segment-color:${item.color}" d="${path}" pathLength="100" />`;
  }).join('');
  const legend = shown.map((item, index) => `<div class="legend-item" style="--legend-delay:${80 + index * 55}ms"><span><i style="background:${item.color}"></i>${item.label}</span><div class="legend-value"><strong>${formatMoney(item.amount)}</strong><small>${Math.round(item.amount / total * 100)}%</small></div></div>`).join('');
  return `<div class="donut-layout"><div class="donut" role="img" aria-label="${metric === 'expense' ? '支出' : '收入'}分类构成"><svg viewBox="0 0 180 180" aria-hidden="true"><circle class="donut-track" cx="90" cy="90" r="67"/>${segments}</svg><div class="donut-hole"><strong>${formatShortMoney(allTotal)}</strong><span>本期${metric === 'expense' ? '支出' : '收入'}</span></div></div><div class="legend-list">${legend || '<p class="empty-copy">还没有分类</p>'}</div></div>`;
}

function categoryTotals(range) {
  const totals = new Map();
  transactionsInRange(state, range.from, range.to).filter(txn => txn.direction === 'expense' && txn.direction !== 'transfer').forEach(txn => totals.set(txn.category, (totals.get(txn.category) || 0) + txn.amountCents));
  return [...totals.entries()].map(([id, amount]) => ({ ...categoryById(id), amount })).sort((a, b) => b.amount - a.amount);
}

function transactionRows(items) {
  if (!items.length) return '<div class="empty-state"><span>◌</span><strong>还没有流水</strong><p>从今天开始，记录第一笔。</p></div>';
  const days = new Map();
  [...items].sort((a, b) => `${b.date}${b.id}`.localeCompare(`${a.date}${a.id}`)).forEach(txn => {
    if (!days.has(txn.date)) days.set(txn.date, []);
    days.get(txn.date).push(txn);
  });
  return `<div class="transaction-list">${[...days.entries()].map(([date, transactions]) => {
    const income = transactions.filter(txn => txn.direction === 'income').reduce((sum, txn) => sum + txn.amountCents, 0);
    const expense = transactions.filter(txn => txn.direction === 'expense').reduce((sum, txn) => sum + txn.amountCents, 0);
    const dayDate = new Date(`${date}T12:00:00`);
    const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(dayDate);
    const todayTag = date === today() ? ' · 今天' : '';
    return `<div class="transaction-day"><div class="day-heading"><div><strong>${date.slice(0, 4)}年${date.slice(5, 7)}月${date.slice(8, 10)}日</strong><span>${weekday}${todayTag}</span></div><small>${income ? `收入 +${formatMoney(income)}　` : ''}${expense ? `支出 -${formatMoney(expense)}` : '无收支'}</small></div>${transactions.map(txn => {
    const category = categoryById(txn.category); const categoryLabel = txn.direction === 'transfer' ? '内部转账（旧记录）' : category.label;
    const bucketLabel = txn.affectsCurrentAssets === false ? '历史流水（不改当前余额）' : txn.bucketUsage ? Object.entries(txn.bucketUsage).filter(([, amount]) => amount > 0).map(([id, amount]) => `${BUCKETS.find(bucket => bucket.id === id)?.label} ${formatMoney(amount)}`).join(' · ') || '超过可用资金' : (txn.bucket ? BUCKETS.find(bucket => bucket.id === txn.bucket)?.label : '未分配');
    return `<div class="transaction-row"><div class="category-icon" aria-hidden="true" style="--icon-color:${txn.direction === 'transfer' ? '#7ad9c6' : category.color}">${categoryGlyph(txn.direction === 'transfer' ? 'transfer' : txn.category)}</div><div class="transaction-main"><strong>${esc(txn.merchant || '未填写商户')}</strong><span>${esc(categoryLabel)} · ${esc(bucketLabel)} · ${txn.source === 'imported' ? '账单导入' : txn.source === 'merged' ? '已匹配账单' : '手动记录'}</span></div><strong class="transaction-amount ${txn.direction}">${signedMoney(txn.direction, txn.amountCents)}</strong></div>`;
  }).join('')}</div>`;
  }).join('')}</div>`;
}

function healthSummary() {
  const assets = sumAssets(state);
  const emergency = state.allocations.emergency || 0;
  const planned = sumPlanBalances(state);
  return `<div class="health-score"><div class="health-ring static-ring"><strong>${formatShortMoney(emergency)}</strong><span>紧急资金</span></div><div class="health-copy"><strong>${emergency ? '紧急资金已留存' : '紧急资金尚未分配'}</strong><p>总资产 ${formatShortMoney(assets)} · 计划资金 ${formatShortMoney(planned)}。紧急资金仅在前四类余额用尽后启用。</p><button class="text-button" data-nav="plan">查看资金分配 →</button></div></div>`;
}

function transactionsPage() {
  const allRows = state.transactions.filter(row => row.direction !== 'transfer' && row.direction !== 'excluded').sort((a, b) => `${b.date}${b.id}`.localeCompare(`${a.date}${a.id}`));
  const rows = transactionFilter === 'all' ? allRows : allRows.filter(row => row.direction === transactionFilter);
  return `<section class="section-head page-title"><div><h2>全部流水</h2></div><div class="top-actions"><button class="primary-button import-button" data-open-import>⇧ 导入账单</button><button class="outline-button" data-open-quick>＋ 记一笔</button></div></section><div class="filter-bar"><button class="filter-chip ${transactionFilter === 'all' ? 'active' : ''}" data-filter="all">全部 ${allRows.length}</button><button class="filter-chip ${transactionFilter === 'expense' ? 'active' : ''}" data-filter="expense">支出 ${allRows.filter(row => row.direction === 'expense').length}</button><button class="filter-chip ${transactionFilter === 'income' ? 'active' : ''}" data-filter="income">收入 ${allRows.filter(row => row.direction === 'income').length}</button><span class="filter-spacer"></span><span class="muted">导入前可预览并去重</span></div><section class="panel-card full-list">${transactionRows(rows)}</section>`;
}

function reviewPage() {
  const range = rangeForReview(reviewScope, reviewAnchor);
  const previous = previousRange(reviewScope, reviewAnchor);
  const rows = transactionsInRange(state, range.from, range.to).filter(txn => ['income', 'expense'].includes(txn.direction));
  const previousRows = transactionsInRange(state, previous.from, previous.to).filter(txn => txn.direction === reviewMetric);
  const amount = rows.filter(txn => txn.direction === reviewMetric).reduce((sum, txn) => sum + txn.amountCents, 0);
  const previousAmount = previousRows.reduce((sum, txn) => sum + txn.amountCents, 0);
  const change = previousAmount ? (amount - previousAmount) / previousAmount * 100 : null;
  const average = Math.round(amount / Math.max(1, range.elapsedDays));
  const income = rows.filter(txn => txn.direction === 'income').reduce((sum, txn) => sum + txn.amountCents, 0);
  const expense = rows.filter(txn => txn.direction === 'expense').reduce((sum, txn) => sum + txn.amountCents, 0);
  const net = income - expense;
  const series = reviewSeries(state.transactions, reviewScope, reviewAnchor, reviewMetric);
  const categories = categoryTotalsForReview(rows, reviewMetric);
  const calendar = calendarForReview(state.transactions, reviewScope, reviewAnchor, reviewMetric);
  const insight = savingsInsight(state.transactions, { totalAssetsCents: sumAssets(state), emergencyCents: state.allocations.emergency }, range.to);
  const activeDays = rows.filter(txn => txn.direction === reviewMetric).length;
  const currentLabel = reviewMetric === 'expense' ? '支出' : '收入';
  if (calendar && !calendar.days.some(day => day.date === selectedReviewDay)) selectedReviewDay = range.to;
  const selectedDay = calendar?.days.find(day => day.date === selectedReviewDay);
  const dayRows = selectedDay ? state.transactions.filter(txn => txn.date === selectedDay.date && txn.direction === reviewMetric) : [];
  return `<section class="review-controls">
    <div class="review-scope-switch" role="group" aria-label="统计周期">${[['week','周度'],['month','月度'],['half','半年'],['year','年度']].map(([id,label]) => `<button class="${reviewScope === id ? 'active' : ''}" data-review-scope="${id}" aria-pressed="${reviewScope === id}">${label}</button>`).join('')}</div>
    <div class="review-range"><button class="range-arrow" data-review-shift="-1" aria-label="上一周期">‹</button><div><span class="eyebrow">查看周期</span><strong>${periodTitle(reviewScope, reviewAnchor)}</strong></div><button class="range-arrow" data-review-shift="1" aria-label="下一周期" ${range.to >= today() ? 'disabled' : ''}>›</button></div>
    <div class="review-metric-switch" role="group" aria-label="查看收支">${[['expense','支出'],['income','收入']].map(([id,label]) => `<button class="${reviewMetric === id ? 'active' : ''} ${id}" data-review-metric="${id}" aria-pressed="${reviewMetric === id}">${label}</button>`).join('')}</div>
  </section>
  <section class="review-hero panel-card"><div class="review-hero-top"><div><span class="eyebrow">${periodTitle(reviewScope, reviewAnchor)} ${currentLabel}</span><p class="review-subtitle">${reviewScope === 'week' ? '按天汇总' : reviewScope === 'year' || reviewScope === 'half' ? '按月汇总' : '按日汇总'} · 内部转账不计入</p></div><span class="review-sun">${reviewMetric === 'expense' ? '↘' : '↗'}</span></div><strong class="review-total ${reviewMetric}" data-countup="${amount}">${formatMoney(amount)}</strong><div class="review-meta"><span>${change === null ? '暂无上期数据可比较' : `较上期 ${change > 0 ? '↑' : change < 0 ? '↓' : '持平'} ${Math.abs(change).toFixed(1)}%`}</span><span>日均 ${formatMoney(average)}</span><span>${activeDays} 笔${currentLabel}</span></div><div class="review-metrics"><div><span>收入</span><strong>${formatMoney(income)}</strong></div><div><span>支出</span><strong>${formatMoney(expense)}</strong></div><div><span>收支结余</span><strong class="${net >= 0 ? 'positive' : 'negative'}">${net >= 0 ? '+' : '−'}${formatMoney(Math.abs(net))}</strong></div><div><span>当前总资产</span><strong>${formatMoney(sumAssets(state))}</strong></div></div></section>
  <section class="panel-card review-chart-card"><div class="chart-title"><div><strong>${reviewMetric === 'expense' ? '支出' : '收入'}节奏</strong><span>${reviewScope === 'week' ? '逐日比较' : '逐月比较'}</span></div><span class="chart-badge">${series.length} 个区间</span></div>${reviewBars(series, reviewMetric)}</section>
  <div class="review-tabs" role="tablist" aria-label="复盘内容"><button class="${reviewTab === 'summary' ? 'active' : ''}" data-review-tab="summary" role="tab" aria-selected="${reviewTab === 'summary'}">本期小结</button><button class="${reviewTab === 'categories' ? 'active' : ''}" data-review-tab="categories" role="tab" aria-selected="${reviewTab === 'categories'}">分类构成</button></div>
  ${reviewTab === 'summary' ? `<section class="review-summary-grid">${calendar ? `<div class="panel-card review-calendar"><div class="chart-title"><div><strong>${reviewScope === 'week' ? '本周每日' : '每日'}${currentLabel}</strong><span>点日期查看当天流水 · 每天只汇总一次</span></div></div>${calendarGrid(calendar, selectedReviewDay, reviewMetric)}<div class="selected-day"><div><span class="eyebrow">${selectedDay?.date || ''}</span><strong>${selectedDay?.count ? `${selectedDay.count} 笔${currentLabel}` : `当天暂无${currentLabel}`}</strong></div><strong>${formatMoney(selectedDay?.amount || 0)}</strong></div>${dayRows.length ? `<div class="day-detail-list">${dayRows.slice(0,5).map(txn => `<div><span>${esc(txn.merchant || '未命名交易')}</span><strong>${formatMoney(txn.amountCents)}</strong></div>`).join('')}</div>` : ''}</div>` : `<div class="panel-card review-calendar"><div class="chart-title"><div><strong>${reviewScope === 'year' ? '年度月度分布' : '近六个月分布'}</strong><span>同一量纲，避免把单月波动看成全年趋势</span></div></div>${monthGrid(series, reviewMetric)}</div>`}
    <aside class="panel-card insight-card ${insight.kind}"><div class="insight-heading"><span class="insight-mark">✦</span><div><span class="eyebrow">本期小结 · 参考建议</span><h3>${esc(insight.title)}</h3></div></div><p>${esc(insight.body)}</p><div class="insight-foot"><span>结合收支、历史波动与资金储备</span><button class="text-button" data-nav="plan">查看资金分配 →</button></div><div class="summary-separator"></div><div class="summary-facts"><div><span>本期收入</span><strong>${formatMoney(income)}</strong></div><div><span>本期支出</span><strong>${formatMoney(expense)}</strong></div><div><span>收支结余</span><strong class="${net >= 0 ? 'positive' : 'negative'}">${net >= 0 ? '+' : '−'}${formatMoney(Math.abs(net))}</strong></div></div></aside></section>` : `<section class="panel-card review-category-card"><div class="chart-title"><div><strong>${currentLabel}类别</strong><span>${periodTitle(reviewScope, reviewAnchor)} · 从已分类流水汇总</span></div><span class="chart-badge">${categories.length} 类</span></div>${donutChart(categories, reviewMetric)}</section>`}`;
}

function categoryTotalsForReview(rows, direction) {
  const totals = new Map();
  rows.filter(txn => txn.direction === direction && txn.direction !== 'transfer').forEach(txn => totals.set(txn.category, (totals.get(txn.category) || 0) + txn.amountCents));
  return [...totals.entries()].map(([id, amount]) => ({ ...categoryById(id), amount })).sort((a, b) => b.amount - a.amount);
}

function reviewBars(series, metric) {
  const nonzero = series.some(item => item.amount > 0);
  if (!nonzero) return `<div class="chart-empty compact-empty"><span>▥</span><strong>还没有${metric === 'expense' ? '支出' : '收入'}记录</strong><p>选定周期内的金额会逐步长成这张图。</p></div>`;
  const max = Math.max(1, ...series.map(item => item.amount));
  return `<div class="review-bars">${series.map((item, index) => { const height = item.amount ? Math.max(5, item.amount / max * 100) : 2; return `<div class="review-bar-item"><span class="bar-value">${item.amount ? formatShortMoney(item.amount) : '—'}</span><div class="review-bar-track"><i class="${metric}" style="--bar-height:${height}%;--bar-delay:${Math.min(index,20)*28}ms"></i></div><span class="bar-label">${item.label}</span></div>`; }).join('')}</div>`;
}

function calendarGrid(calendar, selected, metric) {
  const weekday = ['一','二','三','四','五','六','日'];
  const max = Math.max(1, ...calendar.days.map(day => day.amount));
  return `<div class="calendar-grid"><div class="weekday-row">${weekday.map(label => `<span>${label}</span>`).join('')}</div><div class="calendar-days">${'<span class="calendar-spacer"></span>'.repeat(calendar.offset)}${calendar.days.map(day => `<button class="calendar-day ${day.date === selected ? 'selected' : ''} ${day.future ? 'future' : ''} ${day.amount ? 'has-value' : ''}" data-review-day="${day.date}" aria-label="${day.date}，${day.amount ? formatMoney(day.amount) : '无'}${metric === 'expense' ? '支出' : '收入'}" aria-pressed="${day.date === selected}" ${day.future ? 'disabled' : ''}><strong>${day.day}</strong><span>${day.amount ? formatMoney(day.amount).replace('¥','') : '—'}</span><i style="--heat-opacity:${day.amount ? Math.max(.06,day.amount/max*.11) : 0}"></i></button>`).join('')}</div></div>`;
}

function monthGrid(series, metric) {
  const max = Math.max(1, ...series.map(item => item.amount));
  return `<div class="month-grid">${series.map(item => `<div class="month-cell"><span>${item.label}</span><strong>${item.amount ? formatShortMoney(item.amount) : '—'}</strong><i class="${metric}" style="--month-fill:${item.amount ? Math.max(5,item.amount/max*100) : 0}%"></i></div>`).join('')}</div>`;
}

function planPage() {
  const total = sumAssets(state);
  const allocated = sumAllocated(state);
  const residual = Math.max(0, total - allocated);
  const priority = ['生活资金', '其他资金', '自由资金', '计划资金', '紧急资金'];
  const fixedBuckets = BUCKETS.filter(bucket => bucket.id !== 'planned');
  return `<section class="section-head page-title allocation-summary" aria-label="总资产"><div></div><div class="allocation-total"><span>当前总资产</span><strong>${formatMoney(total)}</strong></div></section><div class="callout"><span>✦</span><div><strong>支出优先顺序</strong><p class="priority-flow">${priority.map((label, index) => `<span>${index + 1}. ${label}</span>${index < priority.length - 1 ? '<b>→</b>' : ''}`).join('')}</p></div></div><section class="bucket-grid">${fixedBuckets.map(bucket => {
    const value = bucket.id === 'other' ? residual : Number(state.allocations[bucket.id] || 0);
    const editable = bucket.id !== 'other';
    return `<article class="bucket-card ${bucket.tone} ${editable ? 'interactive' : 'automatic'}" ${editable ? `data-bucket-open="${bucket.id}" role="button" tabindex="0" aria-label="调整${bucket.label}余额"` : ''}><div class="bucket-top"><span class="bucket-symbol">${categoryGlyph(bucket.id)}</span>${editable ? '<span class="card-open-mark" aria-hidden="true">↗</span>' : '<span class="auto-tag">自动</span>'}</div><span class="eyebrow">${bucket.label}</span><strong>${formatMoney(value)}</strong><p>${bucket.description}</p>${bucket.id === 'other' ? '<div class="bucket-footnote">总资产扣除已分配金额</div>' : ''}</article>`;
  }).join('')}</section><section class="plans-section"><div class="plans-heading"><div><h3>计划资金</h3><span>${(state.plans || []).length} 个计划</span></div><button class="primary-button" data-plan-new>＋ 新建计划</button></div>${state.plans?.length ? `<div class="plans-grid">${state.plans.map(plan => {
    const amount = Math.max(0, Number(plan.amountCents || 0));
    const target = Math.max(0, Number(plan.targetCents || 0));
    const ratio = target ? Math.min(100, amount / target * 100) : 0;
    return `<article class="plan-card ${plan.coverId ? 'has-cover' : ''}" data-plan-open="${esc(plan.id)}" role="button" tabindex="0" aria-label="编辑计划：${esc(plan.name)}">${plan.coverId ? `<img class="plan-cover-image" data-cover-id="${esc(plan.coverId)}" alt="${esc(plan.name)}计划封面" />` : '<div class="plan-cover-placeholder"><span>✦</span></div>'}<div class="plan-card-content"><span class="plan-card-action">打开计划 ↗</span><h4>${esc(plan.name || '未命名计划')}</h4><strong>${formatMoney(amount)}</strong>${target ? `<div class="target-line"><span style="width:${ratio}%"></span></div><div class="target-meta"><span>目标 ${formatMoney(target)}</span><span>${Math.round(ratio)}%</span></div>` : ''}${plan.note ? `<p>${esc(plan.note)}</p>` : ''}</div></article>`;
  }).join('')}</div>` : '<div class="plans-empty"><span>✦</span><p>还没有计划，添加一个目标开始分配资金。</p></div>'}</section>`;
}

function obligationsPage() {
  const debt = sumLiabilities(state);
  const obligations = state.obligations || [];
  const obligationRows = obligations.filter(item => item.active !== false).map(item => `<div class="obligation-row"><div class="category-icon debt-icon">${item.type === 'installment' ? '≋' : item.type === 'loan' ? '↘' : '◇'}</div><div class="transaction-main"><strong>${esc(item.name)}</strong><span>${esc(item.provider || '个人记录')} · ${item.type === 'installment' ? `分期 · 月供 ${formatMoney(item.monthlyPaymentCents || 0)}` : item.type === 'loan' ? '借款' : '信用账户'}${item.dueDay ? ` · 每月 ${item.dueDay} 日` : ''}</span></div><strong class="transaction-amount expense">${formatMoney(item.balanceCents || 0)}</strong><button class="more-button" data-obligation-done="${item.id}" title="划掉">划掉</button></div>`).join('');
  return `<section class="section-head page-title"><div><h2>借款与信用</h2></div><div class="top-actions"><button class="outline-button" data-open-quick>记录还款</button><button class="primary-button" data-open-obligation>＋ 新增负债</button></div></section><div class="obligation-hero panel-card"><div><span class="eyebrow">当前待还</span><strong>${formatMoney(debt)}</strong><p>还清后可从清单中划掉。</p></div><div class="obligation-graphic">${debt ? '↘' : '✓'}</div></div><section class="panel-card full-list"><div class="chart-title"><div><strong>待还清单</strong></div></div>${obligationRows || '<div class="empty-state"><span>✓</span><strong>目前没有待还事项</strong><p>需要记录时，点击右上角新增负债。</p></div>'}</section>`;
}

function ledgersPage() {
  const ledgers = state.ledgers || [];
  const current = ledgers.find(ledger => ledger.id === state.activeLedgerId) || ledgers[0];
  const historyCount = current?.history?.length || 0;
  return `<section class="section-head page-title"><div><h2>账本管理</h2></div><button class="primary-button" data-new-ledger>＋ 新建账本</button></section><div class="ledger-hero panel-card"><div><span class="eyebrow">当前账本</span><strong>${esc(current?.name || '我的账本')}</strong><p>每个账本的流水、总资产、资金分配和借款清单彼此独立。</p></div><div class="ledger-actions"><button class="outline-button" data-set-assets>设置总资产</button><button class="outline-button" data-undo ${historyCount ? '' : 'disabled'}>↶ 撤销上一步</button><button class="danger-button" data-clear-ledger>清空当前账本</button></div></div><section class="panel-card full-list ledger-list"><div class="chart-title"><div><strong>我的账本</strong><span>${ledgers.length} 个 · 撤销记录 ${historyCount}/30</span></div></div>${ledgers.map(ledger => `<div class="ledger-row ${ledger.id === state.activeLedgerId ? 'active' : ''}"><div class="ledger-mark">▤</div><div class="transaction-main"><strong>${esc(ledger.name)}</strong><span>${ledger.id === state.activeLedgerId ? '正在使用' : '独立数据空间'} · ${ledger.transactions?.length || 0} 条流水 · 总资产 ${formatMoney(ledger.id === state.activeLedgerId ? sumAssets(state) : ledger.totalAssetsCents || 0)}</span></div>${ledger.id === state.activeLedgerId ? '<span class="active-badge">当前</span>' : `<button class="more-button" data-switch-ledger="${ledger.id}">切换</button>`}</div>`).join('')}</section>`;
}

function settingsPage() {
  const accountContent = !firebaseIsConfigured()
    ? `<p class="settings-copy">邮箱登录和云同步代码已准备，等配置 Firebase 项目后启用。账单数据目前仍只保存在这台设备。</p><button class="outline-button" disabled>等待云端项目配置</button>`
    : !signedInUser
      ? `<p class="settings-copy">用同一个邮箱账号登录手机和电脑。每个账号的数据相互隔离；本机现有账本首次同步前会先征求你的确认。</p><button class="primary-button" data-auth-open>邮箱登录 / 注册</button>`
      : !signedInUser.emailVerified
        ? `<p class="settings-copy">验证邮件已发送至 <strong>${esc(signedInUser.email)}</strong>。验证完成后才会连接云端；离线记账仍可继续。</p><div class="account-actions"><button class="outline-button" data-auth-resend>重新发送验证邮件</button><button class="setting-action" data-auth-signout>退出账号</button></div>`
        : `<p class="settings-copy">已登录 <strong>${esc(signedInUser.email)}</strong>。账本按账号隔离；云端未连接时，记录仍会保存在本机并等待同步。</p><div class="account-actions"><button class="outline-button" data-sync-now>立即同步</button><button class="setting-action" data-auth-signout>退出登录</button></div>`;
  const errorMessage = syncStatus.status === 'error' && syncStatus.message ? `<p class="sync-error">${esc(syncStatus.message)}</p>` : '';
  return `<section class="section-head page-title"><div><h2>设置与同步</h2></div></section><div class="settings-grid"><section class="panel-card settings-card"><div class="chart-title"><div><strong>多设备同步</strong><span>手机、电脑使用同一个邮箱</span></div><span class="sync-state ${syncStatus.status}">${describeSyncStatus()}</span></div><div class="sync-visual"><div class="device">手机</div><div class="sync-line"><i></i><span>⇄</span><i></i></div><div class="device">电脑</div></div>${accountContent}${errorMessage}</section><section class="panel-card settings-card"><div class="chart-title"><div><strong>数据安全</strong><span>本机优先，随时可带走</span></div><span class="safe-badge">安全</span></div><div class="settings-actions"><button class="setting-action" data-export>导出本机账本 <span>↓</span></button><button class="setting-action" data-clear-ledger>清空当前账本 <span>⌫</span></button><button class="setting-action import-setting" data-open-import>导入账单 <span>⇧</span></button><button class="setting-action" data-nav="ledgers">管理账本 <span>→</span></button></div></section></div><div class="data-contract panel-card"><span class="eyebrow">数据规则</span><div class="contract-grid"><p><strong>总资产单一口径</strong>不建立微信、支付宝或银行卡账户。</p><p><strong>收入支出清晰</strong>转账类账单自动排除，不污染统计。</p><p><strong>账本彼此独立</strong>每本账保存自己的流水和资金计划。</p><p><strong>撤销可恢复</strong>每个账本保留最近 30 次关键修改。</p></div></div>`;
}

function periodLabel(value) { return ({ day: '今天', week: '近 7 天', month: '本月', quarter: '近 3 个月', half: '近 6 个月', year: '本年度' }[value] || value); }

function dateList(from, to) {
  const list = []; let cursor = new Date(`${from}T12:00:00`); const end = new Date(`${to}T12:00:00`);
  while (cursor <= end && list.length < 400) { list.push(dateKey(cursor)); cursor.setDate(cursor.getDate() + 1); }
  return list;
}

function modalMarkup() {
  if (!modal) return '';
  if (modal.type === 'auth') return `<div class="modal-backdrop" data-stop><section class="modal compact-modal auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-title" data-stop><div class="modal-head"><div><span class="eyebrow">Solar Flow 账号</span><h2 id="auth-title">${authMode === 'signup' ? '创建账号' : '邮箱登录'}</h2></div><button class="close-button" data-auth-close>×</button></div><form id="auth-form"><label class="single-field">邮箱地址<input name="email" type="email" autocomplete="email" placeholder="name@example.com" required autofocus /></label><label class="single-field">密码<input name="password" type="password" autocomplete="${authMode === 'signup' ? 'new-password' : 'current-password'}" minlength="8" placeholder="至少 8 位" required /></label><p class="form-help">${authMode === 'signup' ? '注册后需要验证邮箱，验证前不会上传账本。' : '使用同一邮箱即可在手机和电脑间同步。'}</p><div class="modal-actions auth-actions"><button type="button" class="setting-action" data-auth-switch>${authMode === 'signup' ? '已有账号？去登录' : '没有账号？创建一个'}</button>${authMode === 'signin' ? '<button type="button" class="setting-action" data-auth-reset>忘记密码？</button>' : ''}</div><div class="modal-actions"><button type="button" class="outline-button" data-auth-close>取消</button><button type="submit" class="primary-button">${authMode === 'signup' ? '创建账号并发送验证邮件' : '登录并继续'}</button></div></form></section></div>`;
  if (modal.type === 'sync-import') return `<div class="modal-backdrop" data-stop><section class="modal compact-modal" role="dialog" aria-modal="true" aria-labelledby="sync-import-title" data-stop><div class="modal-head"><div><span class="eyebrow">首次连接 · ${esc(pendingAccountUser?.email || '')}</span><h2 id="sync-import-title">发现这台设备已有账本</h2></div></div><p class="form-help">是否将本机账本合并到这个邮箱账号的云端？现有流水和资金设置会保留；重复流水按记录 ID 合并。选择“只用云端数据”不会删除本机账本。</p><div class="modal-actions"><button type="button" class="outline-button" data-auth-merge-cancel>暂不连接</button><button type="button" class="outline-button" data-auth-merge-cloud>只用云端数据</button><button type="button" class="primary-button" data-auth-merge-local>合并本机账本</button></div></section></div>`;
  if (modal.type === 'assets') return `<div class="modal-backdrop" data-close-modal><section class="modal compact-modal" role="dialog" aria-modal="true" aria-labelledby="assets-title" data-stop><div class="modal-head"><div><span class="eyebrow">账单与余额对齐</span><h2 id="assets-title">设置总资产基准</h2></div><button class="close-button" data-close-modal>×</button></div><form id="assets-form"><label class="single-field">基准日总资产（元）<input name="amount" type="number" min="0" step="0.01" value="${(sumAssets(state) / 100).toFixed(2)}" required autofocus /></label><label class="single-field">余额截至日期<input name="baselineDate" type="date" value="${today()}" max="${today()}" required /></label><p class="form-help">默认把当前总资产 <strong>${formatMoney(sumAssets(state))}</strong> 设为今天的已结清余额；此后日期的收入和支出会继续调整总资产。若要补算更早的历史流水，请把基准日改到首笔待补流水之前，并填入当日实际余额（例如 7 月 9 日开始的账单，期初 ¥4,000 就设为 7 月 8 日）。基准日当天按“已结清”处理，重复流水不会再次计入。</p><div class="modal-actions"><button type="button" class="outline-button" data-close-modal>取消</button><button type="submit" class="primary-button">保存基准并重算</button></div></form></section></div>`;
  if (modal.type === 'new-ledger') return `<div class="modal-backdrop" data-close-modal><section class="modal compact-modal" role="dialog" aria-modal="true" aria-labelledby="ledger-title" data-stop><div class="modal-head"><div><span class="eyebrow">独立数据空间</span><h2 id="ledger-title">新建账本</h2></div><button class="close-button" data-close-modal>×</button></div><form id="ledger-form"><label class="single-field">账本名称<input name="name" placeholder="例如：真实记录、旅行测试" maxlength="24" required autofocus /></label><p class="form-help">新账本从 0 开始，不会沿用当前账本的流水、资产或借款。</p><div class="modal-actions"><button type="button" class="outline-button" data-close-modal>取消</button><button type="submit" class="primary-button">创建并切换</button></div></form></section></div>`;
  if (modal.type === 'quick') return `<div class="modal-backdrop" data-close-modal><section class="modal quick-entry-modal" role="dialog" aria-modal="true" aria-labelledby="quick-title" data-stop><div class="modal-head"><div><span class="eyebrow">快速记录 · ${today()}</span><h2 id="quick-title">记下一笔</h2></div><button class="close-button" data-close-modal>×</button></div><form id="quick-form"><div class="amount-field"><span>¥</span><input name="amount" type="number" min="0.01" step="0.01" placeholder="0.00" required autofocus /></div><div class="segmented"><label><input type="radio" name="direction" value="expense" checked /><span>支出</span></label><label><input type="radio" name="direction" value="income" /><span>收入</span></label></div><div class="form-grid"><label>日期<input name="date" type="date" value="${today()}" required /></label><label>商户或来源（可选）<input name="merchant" placeholder="可留空 · 例如午餐、工资" /></label><label>分类<select name="category">${CATEGORIES.map(category => `<option value="${category.id}">${category.icon} ${category.label}</option>`).join('')}</select></label><label data-income-bucket hidden>收入归入<select name="bucket">${BUCKETS.filter(bucket => !['other', 'planned'].includes(bucket.id)).map(bucket => `<option value="${bucket.id}" ${bucket.id === 'life' ? 'selected' : ''}>${bucket.label}</option>`).join('')}</select></label><label class="wide-field">备注<input name="note" placeholder="可选" /></label></div><p class="quick-priority-note">支出按生活 → 其他 → 自由 → 计划 → 紧急顺序扣减。</p><div class="modal-actions"><button type="button" class="outline-button" data-close-modal>取消</button><button type="submit" class="primary-button">保存这笔</button></div></form></section></div>`;
  if (modal.type === 'obligation') return `<div class="modal-backdrop" data-close-modal><section class="modal" role="dialog" aria-modal="true" aria-labelledby="obligation-title" data-stop><div class="modal-head"><div><span class="eyebrow">负债记录</span><h2 id="obligation-title">新增借款、信用卡或分期</h2></div><button class="close-button" data-close-modal>×</button></div><form id="obligation-form"><div class="form-grid"><label>名称<input name="name" placeholder="例如：招行信用卡、朋友借款" required /></label><label>机构或对方<input name="provider" placeholder="可选" /></label><label>类型<select name="type"><option value="credit">信用卡</option><option value="loan">借款</option><option value="installment">分期</option></select></label><label>当前剩余金额<input name="balance" type="number" min="0.01" step="0.01" placeholder="0.00" required /></label><label>每月还款<input name="monthlyPayment" type="number" min="0" step="0.01" placeholder="分期或固定还款可填" /></label><label>还款日<input name="dueDay" type="number" min="1" max="31" placeholder="例如 18" /></label></div><div class="import-note"><span>◎</span><p>这笔金额会计入负债，不会自动算成消费支出。还款流水仍可在“记一笔”里记录。</p></div><div class="modal-actions"><button type="button" class="outline-button" data-close-modal>取消</button><button type="submit" class="primary-button">保存负债</button></div></form></section></div>`;
  if (modal.type === 'bucket') { const bucket = BUCKETS.find(item => item.id === modal.bucketId); const value = Math.round((state.allocations[modal.bucketId] || 0) / 100 * 100) / 100; return `<div class="modal-backdrop" data-close-modal><section class="modal compact-modal" role="dialog" aria-modal="true" aria-labelledby="bucket-title" data-stop><div class="modal-head"><div><span class="eyebrow">${esc(bucket?.label || '资金')}</span><h2 id="bucket-title">调整金额</h2></div><button class="close-button" data-close-modal>×</button></div><form id="bucket-form"><label class="single-field">分配金额（元）<input name="amount" type="number" min="0" step="0.01" value="${value.toFixed(2)}" required /></label><div class="modal-actions"><button type="button" class="outline-button" data-close-modal>取消</button><button type="submit" class="primary-button">保存</button></div></form></section></div>`; }
  if (modal.type === 'plan') { const plan = state.plans?.find(item => item.id === modal.planId); const amount = ((Number(plan?.amountCents || 0)) / 100).toFixed(2); const target = ((Number(plan?.targetCents || 0)) / 100).toFixed(2); return `<div class="modal-backdrop" data-close-modal><section class="modal plan-modal" role="dialog" aria-modal="true" aria-labelledby="plan-title" data-stop><div class="modal-head"><div><span class="eyebrow">计划资金</span><h2 id="plan-title">${plan ? '编辑计划' : '新建计划'}</h2></div><button class="close-button" data-close-modal>×</button></div><form id="plan-form"><div class="form-grid"><label>计划名称<input name="name" maxlength="32" placeholder="例如：旅行、换电脑" value="${esc(plan?.name || '')}" required autofocus /></label><label>当前金额（元）<input name="amount" type="number" min="0" step="0.01" value="${amount}" required /></label><label>目标金额（元）<input name="target" type="number" min="0" step="0.01" value="${target}" placeholder="可不设置" /></label><label class="wide-field">留言<textarea name="note" rows="3" maxlength="240" placeholder="写下这个计划的备注">${esc(plan?.note || '')}</textarea></label></div><label class="cover-upload">计划封面<input id="plan-cover-file" name="cover" type="file" accept="image/*" /><span>选择图片</span></label><div class="plan-modal-preview ${plan?.coverId ? 'has-cover' : ''}">${plan?.coverId ? `<img id="plan-cover-preview" data-cover-id="${esc(plan.coverId)}" alt="当前计划封面" />` : '<img id="plan-cover-preview" alt="封面预览" hidden />'}<span>封面预览</span></div><div class="modal-actions"><button type="button" class="outline-button" data-close-modal>取消</button><button type="submit" class="primary-button">保存计划</button></div></form></section></div>`; }
  if (modal.type === 'import') return `<div class="modal-backdrop" data-close-modal><section class="modal import-modal ${importSession ? 'import-review-modal' : ''}" role="dialog" aria-modal="true" data-stop>${importModalContent()}</section></div>`;
  return '';
}

function importModalContent() {
  if (!importSession) return `<div class="modal-head"><div><span class="eyebrow">账单导入</span><h2>把历史补完整</h2></div><button class="close-button" data-close-modal>×</button></div><div class="dropzone"><div class="upload-symbol">⇧</div><strong>选择微信、支付宝或银行卡账单</strong><p>支持 XLSX、XLS、CSV、OFX；文件只在本机解析，先预览，再写入账本。</p><label class="primary-button file-button">选择文件<input id="import-file" type="file" accept=".xlsx,.xls,.csv,.ofx" hidden /></label></div><div class="import-note"><span>◎</span><p>账单来源只用于区分不同导出文件、避免重复，不会生成账户，也不会把总资产拆开。</p></div>`;
  const { candidates, parsed, selectedSourceId } = importSession;
  const counts = { new: candidates.filter(item => item.match === 'new').length, merge: candidates.filter(item => item.match === 'merge').length, duplicate: candidates.filter(item => item.match === 'duplicate').length, review: candidates.filter(item => item.match === 'review').length, excluded: candidates.filter(item => item.match === 'excluded').length, neutral: candidates.filter(item => item.direction === 'transfer').length, categories: candidates.filter(item => item.categoryNeedsReview && !['excluded', 'transfer'].includes(item.direction)).length };
  const assetImpact = importAssetImpact(candidates);
  const sources = state.billSources || [{ id: 'source-1', label: '默认账单来源' }];
  return `<div class="modal-head"><div><span class="eyebrow">导入预览 · ${esc(parsed.fileName)}</span><h2>确认这批流水</h2></div><button class="close-button" data-close-modal>×</button></div><div class="import-controls"><label>账单来源（仅用于去重）<select id="import-source">${sources.map(source => `<option value="${source.id}" ${source.id === selectedSourceId ? 'selected' : ''}>${esc(source.label)}</option>`).join('')}</select></label><span class="muted">识别到 ${candidates.length} 行 · 表头第 ${parsed.headerIndex + 1} 行 · ${esc(parsed.sheetName)}</span></div><div class="import-summary"><span><i class="new-dot"></i>${counts.new} 条新记录</span><span><i class="merge-dot"></i>${counts.merge} 条匹配手动记录</span><span><i class="duplicate-dot"></i>${counts.duplicate} 条已存在</span><span><i class="review-dot"></i>${counts.review} 条流水待确认</span><span><i class="review-dot"></i>${counts.categories} 条分类待确认</span><span><i class="excluded-dot"></i>${counts.neutral + counts.excluded} 条不计收支</span></div><section class="import-impact ${assetImpact.deltaCents < 0 ? 'negative' : assetImpact.deltaCents > 0 ? 'positive' : ''}" aria-label="本批流水对总资产的影响"><div><span class="eyebrow">总资产预估变化 · 基准日 ${esc(state.settings.assetBaselineDate || today())}</span><strong>${assetImpact.deltaCents > 0 ? '+' : assetImpact.deltaCents < 0 ? '−' : ''}${formatMoney(Math.abs(assetImpact.deltaCents))}</strong></div><div><span>导入后总资产</span><strong>${formatMoney(sumAssets(state) + assetImpact.deltaCents)}</strong></div><p>${assetImpact.eligibleCount ? `按基准日之后 ${assetImpact.eligibleCount} 条新增或合并的收入、支出估算；重复、待确认和内部转账不计入。` : assetImpact.hasNewRows ? '可导入的流水均不晚于基准日，或没有新增收支，因此不会改变当前总资产。若这笔余额其实是账单开始前的期初余额，请把基准日调到首笔流水之前。' : '本批没有尚未入账的收支会改变当前总资产；重复流水不会重复计算。'}</p></section><div class="import-preview">${candidates.map((item, index) => { const neutral = ['excluded','transfer'].includes(item.direction); return `<div class="import-row ${item.categoryNeedsReview ? 'needs-category-review' : ''}"><span class="import-status ${item.match}">${item.match === 'new' ? '新' : item.match === 'merge' ? '合并' : item.match === 'duplicate' ? '重复' : item.match === 'excluded' ? '跳过' : '确认'}</span><strong>${esc(item.date)}</strong><span class="import-merchant" title="${esc(item.merchant)}">${esc(item.merchant)}</span>${neutral ? `<span class="category-neutral">${item.direction === 'transfer' ? '内部流转' : '不计收支'}</span>` : `<label class="import-category"><select data-import-category="${index}" aria-label="${esc(item.merchant)}的分类">${transactionCategories(item.direction).map(option => `<option value="${option.id}" ${option.id === item.category ? 'selected' : ''}>${option.label}</option>`).join('')}</select><small class="category-confidence">${item.categoryNeedsReview ? '建议确认' : '已识别'}</small></label>`}<strong class="transaction-amount ${item.direction}">${item.direction === 'excluded' ? '—' : signedMoney(item.direction, item.amountCents)}</strong><small>${esc(item.categoryReason || item.reason)}${item.match === 'review' ? ` · ${esc(item.reason)}` : ''}</small></div>`; }).join('')}</div><div class="modal-actions import-actions"><button class="outline-button" data-close-modal>取消</button><button class="primary-button" data-import-apply>导入新记录并合并匹配项</button></div>`;
}

function importAssetImpact(candidates) {
  const baselineDate = state.settings.assetBaselineDate || today();
  const baselineAt = state.settings.assetBaselineAt || '';
  let deltaCents = 0;
  let eligibleCount = 0;
  let hasNewRows = false;
  for (const candidate of candidates) {
    if (!['income', 'expense'].includes(candidate.direction) || !['new', 'merge'].includes(candidate.match)) continue;
    hasNewRows = true;
    const signed = candidate.direction === 'income' ? candidate.amountCents : -candidate.amountCents;
    if (candidate.match === 'merge' && candidate.matchedId) {
      const existing = state.transactions.find(transaction => transaction.id === candidate.matchedId);
      if (!existing) continue;
      const beforeIncluded = transactionAffectsCurrentAssets(existing, baselineDate, baselineAt);
      const after = { ...existing, date: candidate.date, direction: candidate.direction, amountCents: candidate.amountCents };
      const afterIncluded = transactionAffectsCurrentAssets(after, baselineDate, baselineAt);
      const correction = (afterIncluded ? signed : 0) - (beforeIncluded ? (existing.direction === 'income' ? existing.amountCents : -existing.amountCents) : 0);
      if (correction) eligibleCount++;
      deltaCents += correction;
      continue;
    }
    if (transactionAffectsCurrentAssets(candidate, baselineDate, baselineAt)) {
      deltaCents += signed;
      eligibleCount++;
    }
  }
  return { deltaCents, eligibleCount, hasNewRows };
}

function messageForAuthError(error) {
  const messages = {
    'auth/invalid-email': '邮箱地址格式不正确。',
    'auth/email-already-in-use': '这个邮箱已经注册，请直接登录。',
    'auth/invalid-credential': '邮箱或密码不正确。',
    'auth/user-not-found': '没有找到这个邮箱对应的账号。',
    'auth/weak-password': '密码强度不足，请换一个更长的密码。',
    'auth/too-many-requests': '尝试次数过多，请稍后再试。',
    'auth/network-request-failed': '网络暂时不可用；本机账本仍可离线使用。',
    'auth/operation-not-allowed': 'Firebase 尚未启用邮箱和密码登录。'
  };
  return messages[error?.code] || error?.message || '账号操作失败，请稍后重试。';
}

async function submitAuth(form) {
  if (!authServices) return notify('云端账号服务尚未配置。', 'error');
  const email = String(new FormData(form).get('email') || '').trim();
  const password = String(new FormData(form).get('password') || '');
  if (authMode === 'signup' && password.length < 8) return notify('密码请至少使用 8 位。', 'error');
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  submit.textContent = authMode === 'signup' ? '正在创建…' : '正在登录…';
  try {
    if (authMode === 'signup') {
      const credential = await firebaseApi.createEmailAccount(authServices.auth, email, password);
      await firebaseApi.sendVerificationEmail(credential.user);
      modal = null;
      syncStatus = { status: 'verifying', message: '' };
      render();
      notify('验证邮件已发送。验证邮箱后即可开启跨设备同步。', 'success');
    } else {
      const credential = await firebaseApi.signInWithEmail(authServices.auth, email, password);
      if (!credential.user.emailVerified) {
        modal = null;
        await handleAuthState(credential.user);
        notify('请先验证邮箱，再开启云同步。', 'info');
      } else {
        await handleAuthState(credential.user);
      }
    }
  } catch (error) {
    if (!modal && !syncEngine) modal = { type: 'auth' };
    render();
    notify(messageForAuthError(error), 'error');
  }
}

function bindEvents() {
  document.querySelectorAll('[data-nav]').forEach(button => button.addEventListener('click', () => { view = button.dataset.nav; render(); }));
  document.querySelectorAll('[data-period]').forEach(button => button.addEventListener('click', () => { period = button.dataset.period; render(); }));
  document.querySelectorAll('[data-chart-mode]').forEach(button => button.addEventListener('click', () => { chartMode = button.dataset.chartMode; render(); }));
  document.querySelectorAll('[data-review-scope]').forEach(button => button.addEventListener('click', () => { reviewScope = button.dataset.reviewScope; reviewAnchor = today(); selectedReviewDay = ''; render(); }));
  document.querySelectorAll('[data-review-metric]').forEach(button => button.addEventListener('click', () => { reviewMetric = button.dataset.reviewMetric; render(); }));
  document.querySelectorAll('[data-review-tab]').forEach(button => button.addEventListener('click', () => { reviewTab = button.dataset.reviewTab; render(); }));
  document.querySelectorAll('[data-review-shift]').forEach(button => button.addEventListener('click', () => { const next = shiftReviewAnchor(reviewScope, reviewAnchor, Number(button.dataset.reviewShift)); if (next <= today()) { reviewAnchor = next; selectedReviewDay = ''; render(); } }));
  document.querySelectorAll('[data-review-day]').forEach(button => button.addEventListener('click', () => { if (!button.disabled) { selectedReviewDay = button.dataset.reviewDay; render(); } }));
  document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => { transactionFilter = button.dataset.filter; render(); }));
  document.querySelectorAll('[data-open-quick]').forEach(button => button.addEventListener('click', () => { modal = { type: 'quick' }; render(); }));
  document.querySelectorAll('[data-new-ledger]').forEach(button => button.addEventListener('click', () => { modal = { type: 'new-ledger' }; render(); }));
  document.querySelectorAll('[data-set-assets]').forEach(button => button.addEventListener('click', () => { modal = { type: 'assets' }; render(); }));
  document.querySelectorAll('[data-open-obligation]').forEach(button => button.addEventListener('click', () => { modal = { type: 'obligation' }; render(); }));
  document.querySelectorAll('[data-plan-new]').forEach(button => button.addEventListener('click', () => { modal = { type: 'plan' }; render(); }));
  document.querySelectorAll('[data-plan-open]').forEach(card => {
    const open = () => { modal = { type: 'plan', planId: card.dataset.planOpen }; render(); };
    card.addEventListener('click', open);
    card.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
  });
  document.querySelectorAll('[data-open-import]').forEach(button => button.addEventListener('click', () => { modal = { type: 'import' }; importSession = null; render(); }));
  document.querySelectorAll('[data-close-modal]').forEach(button => button.addEventListener('click', event => { if (event.target === button || button.classList.contains('close-button')) { modal = null; importSession = null; render(); } }));
  document.querySelectorAll('[data-stop]').forEach(node => node.addEventListener('click', event => event.stopPropagation()));
  const quickForm = document.querySelector('#quick-form');
  if (quickForm) {
    const bucketField = quickForm.querySelector('[data-income-bucket]');
    const categorySelect = quickForm.querySelector('select[name="category"]');
    const updateDirectionFields = () => {
      const direction = quickForm.querySelector('input[name="direction"]:checked')?.value || 'expense';
      if (bucketField) bucketField.hidden = direction !== 'income';
      if (categorySelect) categorySelect.innerHTML = transactionCategories(direction).map(category => `<option value="${category.id}">${category.label}</option>`).join('');
    };
    quickForm.querySelectorAll('input[name="direction"]').forEach(input => input.addEventListener('change', updateDirectionFields));
    updateDirectionFields();
    quickForm.addEventListener('submit', event => { event.preventDefault(); addTransaction(new FormData(quickForm)); });
  }
  const ledgerForm = document.querySelector('#ledger-form');
  if (ledgerForm) ledgerForm.addEventListener('submit', event => { event.preventDefault(); createNewLedger(new FormData(ledgerForm)); });
  const assetsForm = document.querySelector('#assets-form');
  if (assetsForm) assetsForm.addEventListener('submit', event => { event.preventDefault(); setTotalAssets(new FormData(assetsForm)); });
  const obligationForm = document.querySelector('#obligation-form');
  if (obligationForm) obligationForm.addEventListener('submit', event => { event.preventDefault(); addObligation(new FormData(obligationForm)); });
  const bucketForm = document.querySelector('#bucket-form');
  if (bucketForm) bucketForm.addEventListener('submit', event => { event.preventDefault(); saveBucket(new FormData(bucketForm)); });
  const planForm = document.querySelector('#plan-form');
  if (planForm) planForm.addEventListener('submit', event => { event.preventDefault(); savePlan(new FormData(planForm), planForm); });
  const planCoverInput = document.querySelector('#plan-cover-file');
  if (planCoverInput) planCoverInput.addEventListener('change', () => {
    const file = planCoverInput.files?.[0];
    const preview = document.querySelector('#plan-cover-preview');
    const previewBox = preview?.closest('.plan-modal-preview');
    if (!file || !preview) return;
    modalCoverPreviewUrl = URL.createObjectURL(file);
    preview.src = modalCoverPreviewUrl;
    preview.hidden = false;
    previewBox?.classList.add('has-cover');
  });
  const fileInput = document.querySelector('#import-file');
  if (fileInput) fileInput.addEventListener('change', event => handleImportFile(event.target.files[0]));
  const sourceSelect = document.querySelector('#import-source');
  if (sourceSelect) sourceSelect.addEventListener('change', () => { importSession.selectedSourceId = sourceSelect.value; importSession.candidates = matchImportedRows(importSession.parsed.rows.map(row => ({ ...row, sourceId: sourceSelect.value })), state.transactions); render(); });
  document.querySelectorAll('[data-import-category]').forEach(select => select.addEventListener('change', () => {
    const candidate = importSession?.candidates[Number(select.dataset.importCategory)];
    if (!candidate) return;
    candidate.category = select.value;
    candidate.categoryConfidence = 1;
    candidate.categorySource = 'manual';
    candidate.categoryReason = '已手动确认';
    candidate.categoryNeedsReview = false;
    select.closest('.import-category')?.classList.remove('needs-category-review');
    const hint = select.parentElement.querySelector('.category-confidence');
    if (hint) hint.textContent = '已确认';
    select.closest('.import-row')?.classList.remove('needs-category-review');
  }));
  const applyButton = document.querySelector('[data-import-apply]');
  if (applyButton) applyButton.addEventListener('click', () => { pushHistory(state); const result = applyImport(state, importSession.candidates.filter(item => item.match !== 'review'), { fileName: importSession.parsed.fileName, sheetName: importSession.parsed.sheetName, sourceId: importSession.selectedSourceId }); persistState(); modal = null; importSession = null; render(); notify(`导入完成：${result.imported.length} 条新增，${result.merged.length} 条已匹配，${result.skipped.length} 条跳过`); });
  document.querySelectorAll('[data-bucket-open]').forEach(card => {
    const open = () => editBucket(card.dataset.bucketOpen);
    card.addEventListener('click', open);
    card.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
  });
  document.querySelectorAll('[data-obligation-done]').forEach(button => button.addEventListener('click', () => doneObligation(button.dataset.obligationDone)));
  document.querySelectorAll('[data-switch-ledger]').forEach(button => button.addEventListener('click', () => switchLedger(button.dataset.switchLedger)));
  document.querySelectorAll('[data-undo]').forEach(button => button.addEventListener('click', undoChange));
  document.querySelectorAll('[data-clear-ledger]').forEach(button => button.addEventListener('click', clearLedger));
  const exportButton = document.querySelector('[data-export]');
  if (exportButton) exportButton.addEventListener('click', exportData);
  document.querySelectorAll('[data-auth-open]').forEach(button => button.addEventListener('click', () => { authMode = 'signin'; modal = { type: 'auth' }; render(); }));
  document.querySelectorAll('[data-auth-close]').forEach(button => button.addEventListener('click', () => { modal = null; render(); }));
  document.querySelectorAll('[data-auth-switch]').forEach(button => button.addEventListener('click', () => { authMode = authMode === 'signup' ? 'signin' : 'signup'; render(); }));
  const authForm = document.querySelector('#auth-form');
  if (authForm) authForm.addEventListener('submit', event => { event.preventDefault(); submitAuth(authForm); });
  document.querySelectorAll('[data-auth-reset]').forEach(button => button.addEventListener('click', async () => {
    const email = String(new FormData(document.querySelector('#auth-form') || document.createElement('form')).get('email') || '').trim();
    if (!email) return notify('先填写邮箱地址，再点忘记密码。', 'info');
    try { await firebaseApi.requestPasswordReset(authServices.auth, email); notify('如果该邮箱已注册，密码重置邮件很快会到达。'); }
    catch (error) { notify(messageForAuthError(error), 'error'); }
  }));
  document.querySelectorAll('[data-auth-resend]').forEach(button => button.addEventListener('click', async () => {
    try { await firebaseApi.sendVerificationEmail(authServices.auth.currentUser); notify('验证邮件已重新发送。'); }
    catch (error) { notify(messageForAuthError(error), 'error'); }
  }));
  document.querySelectorAll('[data-auth-signout]').forEach(button => button.addEventListener('click', async () => {
    try { await firebaseApi.signOutAccount(authServices.auth); notify('已退出云端账号，本机账本仍保留。'); }
    catch (error) { notify(messageForAuthError(error), 'error'); }
  }));
  document.querySelectorAll('[data-sync-now]').forEach(button => button.addEventListener('click', () => {
    if (!navigator.onLine) return notify('当前离线，联网后会自动同步。', 'info');
    if (!syncEngine) return notify('同步服务尚未就绪，请刷新页面后重试。', 'error');
    if (['connecting', 'error'].includes(syncStatus.status)) {
      syncEngine.retry();
      notify('正在重新连接云端账本。');
    } else {
      syncEngine.localStateChanged();
      notify('正在检查并同步账本。');
    }
  }));
  document.querySelectorAll('[data-auth-merge-local]').forEach(button => button.addEventListener('click', () => {
    const user = pendingAccountUser;
    if (!user) return;
    pendingAccountUser = null;
    void activateVerifiedAccount(user, true).catch(error => notify(messageForAuthError(error), 'error'));
    notify('本机账本已加入同步队列。');
  }));
  document.querySelectorAll('[data-auth-merge-cloud]').forEach(button => button.addEventListener('click', () => {
    const user = pendingAccountUser;
    if (!user) return;
    pendingAccountUser = null;
    void activateVerifiedAccount(user, false, { cloudOnly: true }).catch(error => notify(messageForAuthError(error), 'error'));
    notify('正在读取该账号的云端账本。');
  }));
  document.querySelectorAll('[data-auth-merge-cancel]').forEach(button => button.addEventListener('click', async () => {
    pendingAccountUser = null;
    modal = null;
    await firebaseApi.signOutAccount(authServices.auth);
    notify('暂未连接云同步，本机账本保持不变。', 'info');
  }));
}

function addTransaction(formData) {
  const amountCents = Math.round(Number(formData.get('amount')) * 100);
  const direction = formData.get('direction');
  if (!amountCents || amountCents < 1) return notify('请输入有效金额', 'error');
  if (!['expense', 'income'].includes(direction)) return notify('请选择收入或支出', 'error');
  pushHistory(state);
  const createdAt = new Date().toISOString();
  const transactionDate = formData.get('date');
  const affectsCurrentAssets = transactionAffectsCurrentAssets({ date: transactionDate, createdAt, direction }, state.settings.assetBaselineDate || today(), state.settings.assetBaselineAt || '');
  const txn = { id: makeId('txn'), date: transactionDate, createdAt, affectsCurrentAssets, direction, amountCents, merchant: String(formData.get('merchant') || '').trim(), category: formData.get('category'), bucket: direction === 'income' ? formData.get('bucket') || 'life' : 'life', note: formData.get('note'), source: 'manual' };
  if (affectsCurrentAssets && direction === 'expense') txn.bucketUsage = expenseBuckets(state, amountCents).used;
  state.transactions.push(txn);
  if (affectsCurrentAssets) {
    state.settings.totalAssetsCents = Number(state.settings.totalAssetsCents || 0) + (direction === 'income' ? amountCents : -amountCents);
    if (direction === 'income') state.allocations[txn.bucket] = Number(state.allocations[txn.bucket] || 0) + amountCents;
  }
  recalculateAssets(state);
  persistState(); modal = null; render(); notify('已保存这笔流水');
}

function addObligation(formData) {
  const balanceCents = Math.round(Number(formData.get('balance')) * 100);
  const monthlyPaymentCents = Math.round(Number(formData.get('monthlyPayment') || 0) * 100);
  if (!balanceCents || balanceCents < 1) return notify('请输入有效的剩余金额', 'error');
  const type = formData.get('type');
  pushHistory(state);
  const provider = formData.get('provider') || (type === 'credit' ? '信用卡' : '个人记录');
  state.obligations = state.obligations || [];
  state.obligations.push({ id: makeId('obligation'), type, name: formData.get('name'), provider, balanceCents, originalCents: balanceCents, monthlyPaymentCents, dueDay: Number(formData.get('dueDay') || 0) || null, active: true });
  persistState(); modal = null; render(); notify('负债记录已保存');
}

async function handleImportFile(file) {
  if (!file) return;
  try {
    const name = file.name.toLowerCase();
    const provider = name.includes('支付宝') || name.includes('alipay') ? 'alipay' : name.includes('微信') || name.includes('wechat') ? 'wechat' : 'bank';
    const firstSource = (state.billSources || []).find(source => source.id.startsWith(provider))?.id || (state.billSources || [])[0]?.id || 'source-1';
    const parsed = await parseWorkbook(file, state, firstSource);
    importSession = { parsed, selectedSourceId: firstSource, candidates: matchImportedRows(parsed.rows, state.transactions) };
    render();
  } catch (error) { notify(error.message || '账单读取失败', 'error'); }
}

function editBucket(bucketId) {
  if (bucketId === 'other') return notify('其他资金由系统自动计算', 'info');
  modal = { type: 'bucket', bucketId }; render();
}

function saveBucket(formData) {
  const cents = Math.round(Number(formData.get('amount')) * 100);
  if (!Number.isFinite(cents) || cents < 0) return notify('请输入有效金额', 'error');
  const available = Math.max(0, sumAssets(state) - sumAllocated(state, modal.bucketId));
  if (cents > available) return notify(`当前可分配上限为 ${formatMoney(available)}`, 'error');
  pushHistory(state);
  state.allocations[modal.bucketId] = cents;
  persistState(); modal = null; render(); notify('资金类型已更新');
}

async function savePlan(formData, form) {
  const name = String(formData.get('name') || '').trim();
  const amountCents = Math.round(Number(formData.get('amount')) * 100);
  const targetCents = Math.round(Number(formData.get('target') || 0) * 100);
  const note = String(formData.get('note') || '').trim();
  const file = formData.get('cover');
  if (!name) return notify('请填写计划名称', 'error');
  if (!Number.isFinite(amountCents) || amountCents < 0 || !Number.isFinite(targetCents) || targetCents < 0) return notify('金额需为 0 或正数', 'error');
  const planId = modal.planId || '';
  const available = Math.max(0, sumAssets(state) - sumAllocated(state, '', planId));
  if (amountCents > available) return notify(`此计划最多可分配 ${formatMoney(available)}`, 'error');
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  submit.textContent = '保存中…';
  try {
    const coverId = file?.size ? await storePlanCover(file) : '';
    pushHistory(state);
    const existing = state.plans.find(plan => plan.id === planId);
    const next = { id: planId || makeId('plan'), name, amountCents, targetCents, note, coverId: coverId || existing?.coverId || '' };
    if (existing) Object.assign(existing, next);
    else (state.plans ||= []).push(next);
    persistState();
    modal = null;
    render();
    notify(existing ? '计划已更新' : '计划已创建');
  } catch (error) {
    submit.disabled = false;
    submit.textContent = '保存计划';
    notify(error.message || '封面保存失败，请重试', 'error');
  }
}

function doneObligation(id) {
  const item = (state.obligations || []).find(obligation => obligation.id === id);
  if (!item) return;
  pushHistory(state);
  item.active = false;
  persistState(); render(); notify('这笔负债已划掉');
}

function createNewLedger(formData) {
  const name = String(formData.get('name') || '').trim();
  if (!name) return notify('请先填写账本名称', 'error');
  createLedger(state, name); persistState(); modal = null; view = 'overview'; render(); notify(`已切换到「${name}」`);
}

function setTotalAssets(formData) {
  const amountCents = Math.round(Number(formData.get('amount')) * 100);
  if (!Number.isFinite(amountCents) || amountCents < 0) return notify('请输入不小于 0 的总资产', 'error');
  const baselineDate = String(formData.get('baselineDate') || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(baselineDate) || baselineDate > today()) return notify('请选择不晚于今天的基准日期', 'error');
  const assignedCents = sumAllocated(state);
  if (amountCents < assignedCents) return notify(`当前已分配 ${formatMoney(assignedCents)}，请先调整资金类型再降低总资产。`, 'error');
  const now = new Date();
  const baselineAt = baselineDate === today() ? now.toISOString() : new Date(`${baselineDate}T23:59:59.999+08:00`).toISOString();
  pushHistory(state);
  state.settings.assetBaselineCents = amountCents;
  state.settings.totalAssetsCents = amountCents;
  state.settings.assetBaselineDate = baselineDate;
  state.settings.assetBaselineAt = baselineAt;
  recalculateAssets(state);
  persistState(); modal = null; render(); notify(`已按 ${baselineDate} 重算总资产`);
}

function switchLedger(id) {
  if (!activateLedger(state, id)) return notify('账本切换失败', 'error');
  persistState(); render(); notify('已切换账本');
}

function undoChange() {
  if (!undoLast(state)) return notify('当前账本没有可撤销的修改', 'info');
  persistState(); render(); notify('已撤销上一步');
}

function clearLedger() {
  if (!window.confirm('清空当前账本会移除流水、资金分配、借款与导入批次，但可以用“撤销上一步”恢复。确定继续吗？')) return;
  clearActiveLedger(state); persistState(); render(); notify('当前账本已清空，可随时撤销');
}

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `solar-flow-backup-${today()}.json`; anchor.click(); URL.revokeObjectURL(url); notify('本机账本备份已导出');
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/solar-flow/sw.js').catch(() => {});
render();
initializeFirebaseAuth();
