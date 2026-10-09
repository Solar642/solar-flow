import { collection, doc, onSnapshot, runTransaction } from 'firebase/firestore';
import { clone, initialState, normalizeText, recalculateAssets } from './model.js';

const CHILD_KINDS = ['transaction', 'obligation', 'plan', 'importBatch'];
const CHILD_FIELD = {
  transaction: 'transactions',
  obligation: 'obligations',
  plan: 'plans',
  importBatch: 'importBatches'
};

const encode = value => encodeURIComponent(String(value ?? ''));
const keyFor = (kind, ledgerId = '', id = '') => [kind, ledgerId, id].map(encode).join('~');
const signature = record => record.deleted ? 'deleted' : JSON.stringify(record.data ?? null);
const timestamp = value => Date.parse(value || '') || 0;

function transactionSyncId(transaction) {
  if (transaction.source === 'manual' || !transaction.sourceId) return transaction.id;
  if (transaction.externalId) return `source:${transaction.sourceId}:external:${transaction.externalId}`;
  const fingerprint = [transaction.sourceId, transaction.date, transaction.direction, transaction.amountCents, normalizeText(transaction.merchant)].join('|');
  return `source:${transaction.sourceId}:fingerprint:${fingerprint}`;
}

function activeRecords(state) {
  const records = new Map();
  const put = (kind, id, ledgerId, data) => {
    const key = keyFor(kind, ledgerId, id);
    records.set(key, { key, kind, id, ledgerId, data: clone(data), deleted: false });
  };

  put('profile', 'profile', '', {
    settings: {
      currency: state.settings?.currency || 'CNY',
      demoMode: Boolean(state.settings?.demoMode)
    },
    accounts: state.accounts || [],
    billSources: state.billSources || [],
    categoryRules: state.categoryRules || []
  });

  for (const ledger of state.ledgers || []) {
    const { id, name, createdAt, allocations, totalAssetsCents, assetBaselineCents, assetBaselineDate, assetBaselineAt, plannedTargetCents } = ledger;
    put('ledger', id, id, {
      id, name, createdAt, allocations: allocations || {}, totalAssetsCents: Number(totalAssetsCents || 0),
      assetBaselineCents: Number(assetBaselineCents ?? totalAssetsCents ?? 0),
      assetBaselineDate: assetBaselineDate || '', assetBaselineAt: assetBaselineAt || '',
      plannedTargetCents: Number(plannedTargetCents || 0)
    });
    for (const [kind, field] of Object.entries(CHILD_FIELD)) {
      for (const item of ledger[field] || []) put(kind, kind === 'transaction' ? transactionSyncId(item) : item.id, id, item);
    }
  }
  return records;
}

export function prepareLocalMerge(state) {
  state._syncMeta ||= {};
  const baseline = new Date(0).toISOString();
  for (const key of activeRecords(state).keys()) {
    if (!state._syncMeta[key]) state._syncMeta[key] = baseline;
  }
  return state;
}

export function stateRecords(state) {
  const result = activeRecords(state);
  const versions = state._syncMeta || {};
  const fallbackVersion = state.updatedAt || new Date(0).toISOString();

  for (const [key, tombstone] of Object.entries(state._syncTombstones || {})) {
    if (!result.has(key)) {
      result.set(key, {
        key, kind: tombstone.kind, id: tombstone.id, ledgerId: tombstone.ledgerId || '',
        data: null, deleted: true, updatedAt: versions[key] || tombstone.updatedAt || fallbackVersion
      });
    }
  }
  for (const [key, record] of result) {
    record.updatedAt = versions[key] || fallbackVersion;
  }
  return result;
}

function chooseRecord(local, remote) {
  if (!local) return remote;
  if (!remote) return local;
  const localTime = timestamp(local.updatedAt);
  const remoteTime = timestamp(remote.updatedAt);
  if (localTime !== remoteTime) return localTime > remoteTime ? local : remote;
  const localSignature = signature(local);
  const remoteSignature = signature(remote);
  if (localSignature === remoteSignature) return local;
  // Stable tie-breaker means two devices converge even if their clocks match.
  return localSignature.localeCompare(remoteSignature) > 0 ? local : remote;
}

export function reconcileRecordMaps(localRecords, remoteRecords) {
  const merged = new Map();
  for (const key of new Set([...localRecords.keys(), ...remoteRecords.keys()])) {
    merged.set(key, chooseRecord(localRecords.get(key), remoteRecords.get(key)));
  }
  return merged;
}

function sameRecordData(a, b) {
  return Boolean(a && b && a.deleted === b.deleted && a.kind === b.kind && signature(a) === signature(b));
}

export function stampLocalChanges(state, previousRecords, now = new Date().toISOString()) {
  state._syncMeta ||= {};
  state._syncTombstones ||= {};
  const current = activeRecords(state);

  for (const [key, record] of current) {
    const previous = previousRecords.get(key);
    const metadataVersion = state._syncMeta[key] || previous?.updatedAt || state.updatedAt || now;
    if (!previous || previous.deleted || !sameRecordData(record, previous)) state._syncMeta[key] = now;
    else state._syncMeta[key] = metadataVersion;
    delete state._syncTombstones[key];
  }

  for (const [key, previous] of previousRecords) {
    if (!previous.deleted && !current.has(key)) {
      state._syncMeta[key] = now;
      state._syncTombstones[key] = { kind: previous.kind, id: previous.id, ledgerId: previous.ledgerId, updatedAt: now };
    }
  }
  return stateRecords(state);
}

export function materializeRecords(baseState, records) {
  const state = clone(baseState || initialState());
  const existingLedgers = new Map((state.ledgers || []).map(ledger => [ledger.id, ledger]));
  const ledgerRecords = [...records.values()].filter(record => record.kind === 'ledger' && !record.deleted);
  const ledgers = ledgerRecords.map(record => {
    const existing = existingLedgers.get(record.id);
    return {
      ...(existing || { transactions: [], obligations: [], plans: [], importBatches: [], history: [] }),
      ...clone(record.data),
      transactions: [], obligations: [], plans: [], importBatches: [],
      history: existing?.history || []
    };
  });
  const ledgerMap = new Map(ledgers.map(ledger => [ledger.id, ledger]));

  const profile = records.get(keyFor('profile', '', 'profile'));
  if (profile && !profile.deleted) {
    state.settings = { ...state.settings, ...(profile.data.settings || {}) };
    state.accounts = clone(profile.data.accounts || []);
    state.billSources = clone(profile.data.billSources || []);
    state.categoryRules = clone(profile.data.categoryRules || []);
  }

  for (const record of records.values()) {
    if (!CHILD_KINDS.includes(record.kind) || record.deleted) continue;
    const ledger = ledgerMap.get(record.ledgerId);
    if (ledger) ledger[CHILD_FIELD[record.kind]].push(clone(record.data));
  }

  state.ledgers = ledgers.length ? ledgers : initialState().ledgers;
  const stillActive = state.ledgers.some(ledger => ledger.id === state.activeLedgerId);
  if (!stillActive) state.activeLedgerId = state.ledgers[0].id;
  state._syncMeta = {};
  state._syncTombstones = {};
  for (const [key, record] of records) {
    if (record.updatedAt) state._syncMeta[key] = record.updatedAt;
    if (record.deleted) state._syncTombstones[key] = { kind: record.kind, id: record.id, ledgerId: record.ledgerId || '', updatedAt: record.updatedAt };
  }

  const active = state.ledgers.find(ledger => ledger.id === state.activeLedgerId) || state.ledgers[0];
  state.transactions = clone(active.transactions || []);
  state.obligations = clone(active.obligations || []);
  state.importBatches = clone(active.importBatches || []);
  state.allocations = { free: 0, emergency: 0, life: 0, planned: 0, ...(active.allocations || {}) };
  state.plans = clone(active.plans || []);
  state.settings.totalAssetsCents = Number(active.totalAssetsCents || 0);
  state.settings.assetBaselineCents = Number(active.assetBaselineCents ?? active.totalAssetsCents ?? 0);
  state.settings.assetBaselineDate = active.assetBaselineDate || state.settings.assetBaselineDate;
  state.settings.assetBaselineAt = active.assetBaselineAt || state.settings.assetBaselineAt;
  state.settings.plannedTargetCents = Number(active.plannedTargetCents || 0);
  const totalBeforeRecalc = Number(active.totalAssetsCents || 0);
  recalculateAssets(state);
  active.totalAssetsCents = Number(state.settings.totalAssetsCents || 0);
  if (active.totalAssetsCents !== totalBeforeRecalc) {
    state._syncMeta[keyFor('ledger', active.id, active.id)] = new Date().toISOString();
  }
  return state;
}

function recordCompare(a, b) {
  if (!a) return b ? -1 : 0;
  if (!b) return 1;
  const timeDifference = timestamp(a.updatedAt) - timestamp(b.updatedAt);
  if (timeDifference) return Math.sign(timeDifference);
  return signature(a).localeCompare(signature(b));
}

function sameMap(a, b) {
  if (a.size !== b.size) return false;
  for (const [key, record] of a) {
    const other = b.get(key);
    if (!other || recordCompare(record, other) !== 0) return false;
  }
  return true;
}

export function startCloudSync(db, uid, { getState, setState, persistLocal, onStatus, onRemoteState }) {
  const recordsRef = collection(db, 'users', uid, 'records');
  let remoteRecords = new Map();
  let previousRecords = stateRecords(getState());
  let pendingRecords = new Map();
  let serverReady = false;
  let stopped = false;
  let writing = false;
  let writeRequested = false;
  let unsubscribe = () => {};

  const report = (status, message = '') => onStatus?.({ status, message });

  async function pushLocalWinners() {
    if (stopped || !serverReady) return;
    if (!navigator.onLine) { report('offline'); return; }
    if (writing) { writeRequested = true; return; }

    const effectiveRemote = new Map(remoteRecords);
    for (const [key, record] of pendingRecords) effectiveRemote.set(key, record);
    const localRecords = stateRecords(getState());
    const changes = [...localRecords.values()].filter(record => recordCompare(record, effectiveRemote.get(record.key)) > 0);
    if (!changes.length) { report('synced'); return; }

    writing = true;
    report('syncing');
    let writeError = null;
    for (let start = 0; start < changes.length && !stopped; start += 12) {
      const chunk = changes.slice(start, start + 12);
      await Promise.all(chunk.map(async record => {
        pendingRecords.set(record.key, record);
        const ref = doc(recordsRef, record.key);
        try {
          const winner = await runTransaction(db, async transaction => {
            const snapshot = await transaction.get(ref);
            const current = snapshot.exists() ? { key: record.key, ...snapshot.data() } : null;
            if (recordCompare(record, current) > 0) {
              const { key, ...data } = record;
              transaction.set(ref, data);
              return record;
            }
            return current;
          });
          if (pendingRecords.get(record.key) === record) pendingRecords.delete(record.key);
          const existing = remoteRecords.get(record.key);
          if (winner && recordCompare(winner, existing) >= 0) remoteRecords.set(record.key, winner);
        } catch (error) {
          if (pendingRecords.get(record.key) === record) pendingRecords.delete(record.key);
          writeError ||= error;
        }
      }));
    }
    writing = false;
    previousRecords = stateRecords(getState());
    if (writeError) report('error', writeError.message || '云端写入失败；本机数据仍已保存。联网后可重试。');
    else if (!stopped) report(navigator.onLine ? 'synced' : 'offline');
    if (writeRequested && !stopped) {
      writeRequested = false;
      void pushLocalWinners();
    }
  }

  const retry = () => { void pushLocalWinners(); };
  const offline = () => report('offline');
  window.addEventListener('online', retry);
  window.addEventListener('offline', offline);

  unsubscribe = onSnapshot(recordsRef, snapshot => {
    if (stopped) return;
    remoteRecords = new Map(snapshot.docs.map(item => [item.id, { key: item.id, ...item.data() }]));
    for (const [key, pending] of pendingRecords) {
      const remote = remoteRecords.get(key);
      if (remote && recordCompare(remote, pending) >= 0) pendingRecords.delete(key);
    }
    if (!snapshot.metadata.fromCache) serverReady = true;

    const local = stateRecords(getState());
    const mergedRecords = reconcileRecordMaps(local, remoteRecords);
    const mergedState = materializeRecords(getState(), mergedRecords);
    const mergedStateRecords = stateRecords(mergedState);
    if (!sameMap(local, mergedStateRecords)) {
      setState(mergedState);
      persistLocal();
      onRemoteState?.();
    }
    previousRecords = mergedStateRecords;
    if (serverReady) void pushLocalWinners();
    else report(navigator.onLine ? 'connecting' : 'offline');
  }, error => report('error', error?.message || '无法读取云端账本；本机数据仍已保存。'));

  return {
    localStateChanged() {
      if (stopped) return;
      const state = getState();
      previousRecords = stampLocalChanges(state, previousRecords);
      persistLocal();
      if (serverReady) void pushLocalWinners();
      else report(navigator.onLine ? 'connecting' : 'offline');
    },
    stop() {
      stopped = true;
      unsubscribe();
      window.removeEventListener('online', retry);
      window.removeEventListener('offline', offline);
      pendingRecords.clear();
    }
  };
}
