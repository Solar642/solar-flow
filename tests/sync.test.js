import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../src/model.js';
import { materializeRecords, prepareLocalMerge, reconcileRecordMaps, stampLocalChanges, stateRecords } from '../src/sync.js';

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
