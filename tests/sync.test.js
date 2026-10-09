import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../src/model.js';
import {
  materializeRecords, prepareLocalMerge, reconcileRecordMaps, stampLocalChanges, stateRecords,
  startCloudSync, SYNC_CONNECT_TIMEOUT_MESSAGE
} from '../src/sync.js';

function addTransaction(state, transaction) {
  state.transactions.push(transaction);
  state.ledgers[0].transactions = structuredClone(state.transactions);
  return state;
}

test('two devices keep distinct new transactions when their ledgers merge', () => {
  const phone = initialState();
  phone.updatedAt = '2026-10-09T10:00:00.000Z';
  addTransaction(phone, { id: 'phone-txn', date: '2026-10-10', direction: 'expense', amountCents: 1250, merchant: '午饭', source: 'manual' });

  const computer = initialState();
  computer.updatedAt = '2026-10-09T10:01:00.000Z';
  addTransaction(computer, { id: 'desktop-txn', date: '2026-10-11', direction: 'income', amountCents: 50000, merchant: '工资', source: 'manual' });

  const merged = reconcileRecordMaps(stateRecords(phone), stateRecords(computer));
  const result = materializeRecords(phone, merged);
  assert.deepEqual(result.transactions.map(item => item.id).sort(), ['desktop-txn', 'phone-txn']);
});

test('first merge adds local-only rows but preserves the existing cloud version on collisions', () => {
  const local = initialState();
  local.updatedAt = '2026-10-09T12:00:00.000Z';
  addTransaction(local, { id: 'same-id', date: '2026-10-08', direction: 'expense', amountCents: 500, merchant: '本机旧备注', source: 'manual' });
  addTransaction(local, { id: 'local-only', date: '2026-10-09', direction: 'expense', amountCents: 700, merchant: '本机新增', source: 'manual' });
  prepareLocalMerge(local);

  const cloud = initialState();
  cloud.updatedAt = '2026-10-01T10:00:00.000Z';
  addTransaction(cloud, { id: 'same-id', date: '2026-10-08', direction: 'expense', amountCents: 500, merchant: '云端较新记录', source: 'manual' });
  const merged = reconcileRecordMaps(stateRecords(local), stateRecords(cloud));
  const result = materializeRecords(local, merged);

  assert.equal(result.transactions.find(item => item.id === 'same-id').merchant, '云端较新记录');
  assert.ok(result.transactions.some(item => item.id === 'local-only'));
});

test('same imported bill row on two devices maps to one cloud transaction', () => {
  const makeImported = id => {
    const state = initialState();
    state.updatedAt = '2026-10-09T10:00:00.000Z';
    addTransaction(state, { id, date: '2026-10-08', direction: 'expense', amountCents: 3590, merchant: '华莱士', source: 'imported', sourceId: 'wechat-1', externalId: '' });
    return state;
  };
  const a = stateRecords(makeImported('import-phone'));
  const b = stateRecords(makeImported('import-desktop'));
  const txnKeysA = [...a.keys()].filter(key => key.startsWith('transaction~'));
  const txnKeysB = [...b.keys()].filter(key => key.startsWith('transaction~'));
  assert.equal(txnKeysA.length, 1);
  assert.deepEqual(txnKeysA, txnKeysB);
  const merged = reconcileRecordMaps(a, b);
  assert.equal(materializeRecords(makeImported('import-phone'), merged).transactions.length, 1);
});

test('a newer tombstone removes a previously synced transaction', () => {
  const original = initialState();
  original.updatedAt = '2026-10-09T10:00:00.000Z';
  addTransaction(original, { id: 'delete-me', date: '2026-10-08', direction: 'expense', amountCents: 200, merchant: '测试', source: 'manual' });
  const remote = stateRecords(original);

  const cleared = structuredClone(original);
  cleared.transactions = [];
  cleared.ledgers[0].transactions = [];
  const local = stampLocalChanges(cleared, remote, '2026-10-09T10:05:00.000Z');
  const merged = reconcileRecordMaps(local, remote);
  assert.equal(materializeRecords(cleared, merged).transactions.length, 0);
});

test('cloud connection timeout is visible and manual retry reconnects the listener', async () => {
  const originalWindow = globalThis.window;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });

  const subscriptions = [];
  const statuses = [];
  let unsubscribed = 0;
  const firestore = {
    collection: () => ({}),
    doc: (_records, id) => ({ id }),
    onSnapshot: (_records, onNext, onError) => {
      subscriptions.push({ onNext, onError });
      return () => { unsubscribed += 1; };
    },
    runTransaction: async (_db, operation) => operation({
      get: async () => ({ exists: () => false }),
      set() {}
    })
  };
  const state = initialState();
  const engine = startCloudSync({}, 'test-user', {
    getState: () => state,
    setState: next => Object.assign(state, next),
    persistLocal() {},
    onStatus: status => statuses.push(status),
    firestore,
    connectionTimeoutMs: 5
  });

  try {
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(statuses.at(-1).status, 'error');
    assert.equal(statuses.at(-1).message, SYNC_CONNECT_TIMEOUT_MESSAGE);

    engine.retry();
    assert.equal(statuses.at(-1).status, 'connecting');
    assert.equal(subscriptions.length, 2);
    assert.ok(unsubscribed >= 1);

    subscriptions.at(-1).onNext({ docs: [], metadata: { fromCache: false } });
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(statuses.at(-1).status, 'synced');
  } finally {
    engine.stop();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
  }
});

test('a burst of remote snapshots updates app state immediately but coalesces UI refreshes', async () => {
  const originalWindow = globalThis.window;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });

  const subscriptions = [];
  const firestore = {
    collection: () => ({}),
    doc: (_records, id) => ({ id }),
    onSnapshot: (_records, onNext) => {
      subscriptions.push(onNext);
      return () => {};
    },
    runTransaction: async (_db, operation) => operation({
      get: async () => ({ exists: () => false }),
      set() {}
    })
  };
  const state = initialState();
  let remoteRefreshes = 0;
  const asSnapshot = remoteState => ({
    docs: [...stateRecords(remoteState).values()].map(({ key, ...record }) => ({
      id: key,
      data: () => structuredClone(record)
    })),
    metadata: { fromCache: false }
  });
  const firstRemote = initialState();
  addTransaction(firstRemote, { id: 'remote-one', date: '2026-10-08', direction: 'expense', amountCents: 500, merchant: '午餐', source: 'manual' });
  const secondRemote = structuredClone(firstRemote);
  addTransaction(secondRemote, { id: 'remote-two', date: '2026-10-09', direction: 'expense', amountCents: 700, merchant: '晚餐', source: 'manual' });

  const engine = startCloudSync({}, 'test-user', {
    getState: () => state,
    setState: next => Object.assign(state, next),
    persistLocal() {},
    onStatus() {},
    onRemoteState: () => { remoteRefreshes++; },
    remoteStateDebounceMs: 25,
    firestore
  });

  try {
    subscriptions[0](asSnapshot(firstRemote));
    await new Promise(resolve => setTimeout(resolve, 5));
    subscriptions[0](asSnapshot(secondRemote));
    assert.equal(state.transactions.length, 2);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(remoteRefreshes, 1);
  } finally {
    engine.stop();
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
  }
});
