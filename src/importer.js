import * as XLSX from 'xlsx';
import { dateKey, expenseBuckets, makeId, normalizeText, recalculateAssets, transactionAffectsCurrentAssets } from './model.js';
import { classifyTransaction } from './categorization.js';

const aliases = {
  date: ['日期', '交易日期', '记账日期', '时间', '交易时间', 'date', 'time'],
  amount: ['金额', '交易金额', '发生额', 'amount', '金额(元)', '金额（元）'],
  income: ['收入', '收入金额', '入账金额', 'credit', 'income'],
  expense: ['支出', '支出金额', '出账金额', 'debit', 'expense'],
  merchant: ['商户', '交易对方', '对方', '商品', '商品说明', '交易说明', '摘要', 'merchant', 'payee', 'description'],
  id: ['交易单号', '交易订单号', '流水号', '订单号', '商户单号', '商家订单号', '交易id', 'transactionid', 'id'],
  type: ['交易类型', '收支类型', '类型', '交易分类', 'type'],
  direction: ['收/支', '收支', 'direction'],
  account: ['账户', '资金账户', '付款账户', '收款账户', '收/付款方式', '支付方式', 'account'],
  status: ['交易状态', '当前状态', '状态', 'status'],
  details: ['商品说明', '商品', '产品名称', '备注说明', 'description']
};

function cleanHeader(value) {
  return normalizeText(String(value ?? '').replace(/^\uFEFF/, '').replace(/\t/g, '')).replace(/(（元）|\(元\)|人民币|rmb|cny)/g, '');
}

function findColumn(headers, type) {
  const candidates = aliases[type].map(cleanHeader);
  return headers.find(header => candidates.includes(cleanHeader(header))) || headers.find(header => candidates.some(candidate => cleanHeader(header).includes(candidate)));
}

function numberValue(value) {
  if (value === null || value === undefined || value === '') return 0;
  const cleaned = String(value).replace(/[¥￥,，\s]/g, '').replace(/元$/g, '');
  const num = Number(cleaned);
  return Number.isFinite(num) ? Math.round(num * 100) : 0;
}

function readDate(value) {
  if (value instanceof Date) return dateKey(value);
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
  }
  const text = String(value || '').trim().replace(/[年./]/g, '-').replace(/月/g, '-').replace(/日/g, '');
  const match = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) return `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
  return dateKey(new Date(value));
}

function cleanCell(value) {
  return String(value ?? '').replace(/^\uFEFF/, '').replace(/\t+$/g, '').trim();
}

function headerColumns(headers) {
  return Object.fromEntries(Object.keys(aliases).map(type => [type, findColumn(headers, type)]));
}

function looksLikeHeader(row) {
  const headers = row.map(cleanCell);
  const columns = headerColumns(headers);
  return Boolean(columns.date && (columns.amount || columns.income || columns.expense) && (columns.merchant || columns.type || columns.id));
}

function findHeaderRow(rows) {
  return rows.findIndex(row => looksLikeHeader(row));
}

function rowObject(headers, row) {
  return Object.fromEntries(headers.map((header, index) => [header, cleanCell(row[index])]));
}

function readBestWorkbook(buffer, fileName = '') {
  const bytes = new Uint8Array(buffer);
  if (/\.csv$/i.test(fileName)) {
    const utf8 = new TextDecoder('utf-8').decode(bytes);
    const text = utf8.includes('�') ? new TextDecoder('gb18030').decode(bytes) : utf8;
    return XLSX.read(text, { type: 'string', cellDates: true, raw: true });
  }
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  const read = codepage => XLSX.read(binary, { type: 'binary', cellDates: true, codepage });
  let workbook = read(65001);
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  const firstValues = XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: '' }).flat().slice(0, 80).map(cleanCell).join('');
  if (firstValues.includes('�')) workbook = read(936);
  return workbook;
}

function detectDirection(row, columns) {
  const stated = cleanCell(columns.direction ? row[columns.direction] || '' : '').toLowerCase();
  const transactionType = cleanCell(columns.type ? row[columns.type] || '' : '').toLowerCase();
  const type = `${stated} ${transactionType}`;
  if (/不计收支|中性|不计入|neutral/.test(stated)) return 'excluded';
  if (/^(微信)?转账$|^资金转入转出$/.test(normalizeText(transactionType))) return 'transfer';
  if (/收入|入账|收款|credit|income|deposit/.test(stated)) return 'income';
  if (/支出|消费|付款|debit|expense|withdraw/.test(stated)) return 'expense';
  if (/退款|退货|退还|返还|冲正|refund/.test(transactionType)) return 'income';
  if (/收入|入账|收款|credit|income|deposit|refund/.test(type)) return 'income';
  if (/支出|消费|付款|转出|支付|debit|expense|withdraw/.test(type)) return 'expense';
  const income = columns.income ? numberValue(row[columns.income]) : 0;
  const expense = columns.expense ? numberValue(row[columns.expense]) : 0;
  if (income > 0 && expense === 0) return 'income';
  if (income === 0 && expense === 0) return 'excluded';
  return 'expense';
}

export async function parseWorkbook(file, state, sourceId = 'source-1') {
  const workbook = readBestWorkbook(await file.arrayBuffer(), file.name);
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
  if (!rawRows.length) throw new Error('没有读取到可用的表格行。');
  const headerIndex = findHeaderRow(rawRows);
  if (headerIndex < 0) throw new Error('无法识别账单表头。请确认文件包含日期、金额、收支或交易类型列。');
  const headers = rawRows[headerIndex].map(cleanCell);
  const columns = headerColumns(headers);
  const rows = rawRows.slice(headerIndex + 1).map(row => rowObject(headers, row)).filter(row => Object.values(row).some(Boolean));
  const transactions = rows.map((row, index) => {
    const direction = detectDirection(row, columns);
    const income = columns.income ? numberValue(row[columns.income]) : 0;
    const expense = columns.expense ? numberValue(row[columns.expense]) : 0;
    let amountCents = columns.amount ? Math.abs(numberValue(row[columns.amount])) : Math.max(income, expense);
    if (!amountCents) return null;
    const merchant = cleanCell(row[columns.merchant] || row[columns.type] || '未命名交易');
    const details = cleanCell(row[columns.details] || '');
    const externalId = cleanCell(row[columns.id] || '');
    const date = readDate(row[columns.date]);
    const rawType = cleanCell(row[columns.type] || '');
    const status = cleanCell(row[columns.status] || '');
    const excluded = direction === 'excluded' || /失败|关闭|撤销|作废/.test(status);
    const finalDirection = excluded ? 'excluded' : direction;
    const categoryResult = classifyTransaction({ merchant, rawType, details, direction: finalDirection, learnedRules: state.categoryRules || [] });
    return {
      id: makeId('import'), date, direction: finalDirection, amountCents, sourceId,
      merchant, details, category: categoryResult.category, categoryConfidence: categoryResult.confidence,
      categorySource: categoryResult.categorySource, categoryReason: categoryResult.categoryReason,
      categoryNeedsReview: categoryResult.confidence < 0.7, bucket: direction === 'income' ? 'free' : 'life',
      note: `来自 ${file.name} · 第 ${headerIndex + index + 2} 行`, source: 'imported', externalId,
      importRow: headerIndex + index + 2, rawType, status, sourceFile: file.name, sourceLabel: sourceId,
      excludedReason: excluded ? (status || rawType || '不计入收支') : ''
    };
  }).filter(Boolean);
  return { fileName: file.name, sheetName, headers, rows: transactions, columns, headerIndex };
}

function dayDistance(a, b) {
  const left = new Date(`${a}T12:00:00`).getTime();
  const right = new Date(`${b}T12:00:00`).getTime();
  return Math.abs(left - right) / 86400000;
}

function merchantSimilarity(a, b) {
  const left = normalizeText(a);
  const right = normalizeText(b);
  return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)));
}

export function fingerprint(txn) {
  return [txn.sourceId || txn.accountId || 'legacy', txn.date, txn.direction, txn.amountCents, normalizeText(txn.merchant)].join('|');
}

function sourceKey(txn) {
  return txn.sourceId || txn.accountId || 'legacy';
}

export function matchImportedRows(rows, existing) {
  const seenExternalIds = new Set();
  const seenFingerprints = new Set();
  return rows.map(row => {
    if (row.direction === 'excluded') return { ...row, match: 'excluded', reason: row.excludedReason || '不计入收入和支出' };
    if (row.externalId && seenExternalIds.has(`${sourceKey(row)}|${row.externalId}`)) return { ...row, match: 'duplicate', reason: '同一文件里出现了重复流水号' };
    if (seenFingerprints.has(fingerprint(row))) return { ...row, match: 'duplicate', reason: '同一文件里出现了重复的日期、金额和商户' };
    const exactId = row.externalId && existing.find(txn => sourceKey(txn) === sourceKey(row) && txn.externalId && txn.externalId === row.externalId);
    if (exactId) {
      if (row.externalId) seenExternalIds.add(`${sourceKey(row)}|${row.externalId}`);
      seenFingerprints.add(fingerprint(row));
      return { ...row, match: 'duplicate', matchedId: exactId.id, reason: '同一来源的流水号已存在' };
    }
    const exact = existing.find(txn => sourceKey(txn) === sourceKey(row) && fingerprint(txn) === fingerprint(row)) || existing.find(txn => txn.source === 'manual' && !txn.sourceId && txn.date === row.date && txn.direction === row.direction && txn.amountCents === row.amountCents && merchantSimilarity(txn.merchant, row.merchant));
    if (exact) {
      if (row.externalId) seenExternalIds.add(`${sourceKey(row)}|${row.externalId}`);
      seenFingerprints.add(fingerprint(row));
      return { ...row, match: 'duplicate', matchedId: exact.id, reason: '来源、日期、金额和商户完全一致' };
    }
    const nearby = existing.filter(txn => (sourceKey(txn) === sourceKey(row) || (txn.source === 'manual' && !txn.sourceId)) && txn.direction === row.direction && txn.amountCents === row.amountCents && dayDistance(txn.date, row.date) <= 2);
    const sameMerchant = nearby.filter(txn => merchantSimilarity(txn.merchant, row.merchant));
    const result = sameMerchant.length === 1
      ? { ...row, match: 'merge', matchedId: sameMerchant[0].id, reason: '与手动记录高度匹配，将补充原始流水信息' }
      : nearby.length > 0
        ? { ...row, match: 'review', matchedId: nearby[0].id, reason: '金额和日期接近，但商户需要确认' }
        : { ...row, match: 'new', reason: '新交易' };
    if (row.externalId) seenExternalIds.add(`${sourceKey(row)}|${row.externalId}`);
    seenFingerprints.add(fingerprint(row));
    return result;
  });
}

export function applyImport(state, candidates, batchMeta) {
  const imported = [];
  const merged = [];
  const skipped = [];
  // Providers commonly export newest-first. Apply ledger effects oldest-first so
  // bucket depletion is deterministic and matches the chronology of the ledger.
  const chronological = [...candidates].sort((a, b) => String(a.date).localeCompare(String(b.date)) || Number(a.importRow || 0) - Number(b.importRow || 0));
  for (const candidate of chronological) {
    if (candidate.match === 'excluded' || candidate.direction === 'excluded') { skipped.push(candidate); continue; }
    if (candidate.match === 'duplicate') { skipped.push(candidate); continue; }
    if (candidate.match === 'merge' && candidate.matchedId) {
      const existing = state.transactions.find(txn => txn.id === candidate.matchedId);
      if (existing) {
        existing.externalId = candidate.externalId || existing.externalId;
        existing.sourceId = candidate.sourceId || existing.sourceId;
        existing.sourceFile = candidate.sourceFile;
        existing.source = 'merged';
        existing.rawType = candidate.rawType;
        existing.importRow = candidate.importRow;
        existing.date = candidate.date;
        existing.merchant = existing.merchant || candidate.merchant;
        merged.push(existing);
        continue;
      }
    }
    const transaction = { ...candidate, id: makeId('txn'), match: undefined };
    state.transactions.push(transaction);
    const affectsCurrentAssets = transactionAffectsCurrentAssets(transaction, state.settings.assetBaselineDate || dateKey(), state.settings.assetBaselineAt || '');
    transaction.affectsCurrentAssets = affectsCurrentAssets;
    if (affectsCurrentAssets && transaction.direction === 'expense') transaction.bucketUsage = expenseBuckets(state, transaction.amountCents).used;
    if (affectsCurrentAssets) state.settings.totalAssetsCents = Number(state.settings.totalAssetsCents || 0) + (transaction.direction === 'income' ? transaction.amountCents : -transaction.amountCents);
    imported.push(transaction);
  }
  recalculateAssets(state);
  state.importBatches.unshift({ id: makeId('batch'), ...batchMeta, imported: imported.length, merged: merged.length, skipped: skipped.length, createdAt: new Date().toISOString() });
  return { imported, merged, skipped };
}
