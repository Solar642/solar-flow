const DAY_MS = 86400000;
const localDate = value => new Date(`${value}T12:00:00`);
const dateString = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const monthString = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
const monthDate = key => new Date(`${key}-01T12:00:00`);
const endOfMonth = date => new Date(date.getFullYear(), date.getMonth() + 1, 0, 12);
const clampEnd = (date, today) => date > localDate(today) ? localDate(today) : date;

export function rangeForReview(scope, anchor = dateString(new Date())) {
  const date = localDate(anchor);
  let from; let to; let elapsedFrom;
  if (scope === 'week') {
    const weekday = (date.getDay() + 6) % 7;
    from = new Date(date); from.setDate(date.getDate() - weekday);
    to = new Date(from); to.setDate(from.getDate() + 6);
  } else if (scope === 'half') {
    from = new Date(date.getFullYear(), date.getMonth() - 5, 1, 12);
    to = endOfMonth(date);
  } else if (scope === 'year') {
    from = new Date(date.getFullYear(), 0, 1, 12);
    to = new Date(date.getFullYear(), 11, 31, 12);
  } else {
    from = new Date(date.getFullYear(), date.getMonth(), 1, 12);
    to = endOfMonth(date);
  }
  const today = dateString(new Date());
  const capped = clampEnd(to, today);
  elapsedFrom = from;
  return { from: dateString(from), to: dateString(capped), calendarTo: dateString(to), elapsedDays: Math.max(1, Math.floor((capped - elapsedFrom) / DAY_MS) + 1) };
}

export function shiftReviewAnchor(scope, anchor, offset) {
  const date = localDate(anchor);
  if (scope === 'week') date.setDate(date.getDate() + offset * 7);
  else if (scope === 'half') date.setMonth(date.getMonth() + offset * 6, 1);
  else if (scope === 'year') date.setFullYear(date.getFullYear() + offset, 0, 1);
  else date.setMonth(date.getMonth() + offset, 1);
  return dateString(date);
}

export function periodTitle(scope, anchor) {
  const date = localDate(anchor);
  if (scope === 'year') return `${date.getFullYear()} 年`;
  if (scope === 'half') {
    const start = new Date(date.getFullYear(), date.getMonth() - 5, 1, 12);
    return `${start.getFullYear()}年${start.getMonth() + 1}月 — ${date.getFullYear()}年${date.getMonth() + 1}月`;
  }
  if (scope === 'week') {
    const { from, to } = rangeForReview(scope, anchor);
    return `${from.slice(5).replace('-', '月')}日 — ${to.slice(5).replace('-', '月')}日`;
  }
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月`;
}

export function previousRange(scope, anchor) {
  const previousAnchor = shiftReviewAnchor(scope, anchor, -1);
  return rangeForReview(scope, previousAnchor);
}

export function reviewSeries(transactions, scope, anchor, direction) {
  const date = localDate(anchor);
  const periods = [];
  if (scope === 'week') {
    const range = rangeForReview('week', anchor);
    const first = localDate(range.from);
    for (let day = 0; day < 7; day++) {
      const current = new Date(first); current.setDate(first.getDate() + day);
      const key = dateString(current);
      periods.push({ key, label: `${current.getMonth() + 1}/${current.getDate()}`, from: key, to: key });
    }
  } else if (scope === 'year') {
    for (let month = 0; month < 12; month++) {
      const current = new Date(date.getFullYear(), month, 1, 12);
      periods.push({ key: monthString(current), label: `${month + 1}月`, from: dateString(current), to: dateString(endOfMonth(current)) });
    }
  } else {
    const count = scope === 'half' ? 6 : 6;
    const first = new Date(date.getFullYear(), date.getMonth() - count + 1, 1, 12);
    for (let i = 0; i < count; i++) {
      const current = new Date(first.getFullYear(), first.getMonth() + i, 1, 12);
      periods.push({ key: monthString(current), label: `${current.getMonth() + 1}月`, from: dateString(current), to: dateString(endOfMonth(current)) });
    }
  }
  return periods.map(period => ({ ...period, amount: transactions.filter(txn => txn.direction === direction && txn.date >= period.from && txn.date <= period.to).reduce((sum, txn) => sum + Number(txn.amountCents || 0), 0) }));
}

export function calendarForReview(transactions, scope, anchor, direction) {
  const range = rangeForReview(scope, anchor);
  let start; let count;
  if (scope === 'week') { start = localDate(range.from); count = 7; }
  else if (scope === 'month') {
    const date = localDate(anchor);
    start = new Date(date.getFullYear(), date.getMonth(), 1, 12);
    count = endOfMonth(date).getDate();
  } else return null;
  const offset = scope === 'month' ? (start.getDay() + 6) % 7 : 0;
  const days = Array.from({ length: count }, (_, index) => {
    const date = new Date(start); date.setDate(start.getDate() + index);
    const key = dateString(date);
    const rows = transactions.filter(txn => txn.date === key && txn.direction === direction);
    return { date: key, day: date.getDate(), amount: rows.reduce((sum, txn) => sum + Number(txn.amountCents || 0), 0), count: rows.length, future: key > dateString(new Date()) };
  });
  return { offset, days };
}

export function median(values) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function robustWeightedAverage(values, alpha = 0.35) {
  const finite = values.filter(value => Number.isFinite(value) && value >= 0);
  if (!finite.length) return 0;
  const center = median(finite);
  const deviation = median(finite.map(value => Math.abs(value - center)));
  const ceiling = deviation > 0 ? center + 3 * 1.4826 * deviation : center * 1.75;
  const bounded = finite.map(value => Math.min(value, ceiling));
  let smooth = bounded[0];
  for (const value of bounded.slice(1)) smooth = alpha * value + (1 - alpha) * smooth;
  return Math.round(center * 0.55 + smooth * 0.45);
}

export function emergencyReserveRecommendation(transactions, anchor = dateString(new Date())) {
  const date = localDate(anchor);
  const latestClosedMonth = new Date(date.getFullYear(), date.getMonth() - 1, 1, 12);
  const monthKeys = Array.from({ length: 6 }, (_, index) => monthString(new Date(latestClosedMonth.getFullYear(), latestClosedMonth.getMonth() - 5 + index, 1, 12)));
  const essential = new Set(['food', 'home', 'transport', 'communication', 'health']);
  const observed = monthKeys.map(key => {
    const rows = transactions.filter(txn => txn.date.startsWith(key) && ['income', 'expense'].includes(txn.direction));
    return {
      rows,
      essentialExpense: rows.filter(txn => txn.direction === 'expense' && essential.has(txn.category)).reduce((sum, txn) => sum + Number(txn.amountCents || 0), 0),
      totalExpense: rows.filter(txn => txn.direction === 'expense').reduce((sum, txn) => sum + Number(txn.amountCents || 0), 0)
    };
  }).filter(month => month.totalExpense > 0);

  if (!observed.length) return { targetCents: 0, monthlyBaselineCents: 0, sampleMonths: 0, provisional: true, basis: 'essential' };
  const hasEssentialSpending = observed.some(month => month.essentialExpense > 0);
  const monthlyValues = observed.map(month => hasEssentialSpending ? month.essentialExpense : month.totalExpense);
  const monthlyBaselineCents = observed.length >= 3 ? robustWeightedAverage(monthlyValues) : median(monthlyValues);
  return {
    targetCents: Math.round(monthlyBaselineCents * 3),
    monthlyBaselineCents,
    sampleMonths: observed.length,
    provisional: observed.length < 3,
    basis: hasEssentialSpending ? 'essential' : 'total'
  };
}

export function savingsInsight(transactions, context = {}, anchor = dateString(new Date())) {
  const date = localDate(anchor);
  const latestClosedMonth = new Date(date.getFullYear(), date.getMonth() - 1, 1, 12);
  const monthKeys = Array.from({ length: 6 }, (_, index) => monthString(new Date(latestClosedMonth.getFullYear(), latestClosedMonth.getMonth() - 5 + index, 1, 12)));
  const completed = monthKeys.map(key => {
    const rows = transactions.filter(txn => txn.date.startsWith(key) && ['income', 'expense'].includes(txn.direction));
    return { key, rows, income: rows.filter(txn => txn.direction === 'income').reduce((sum, txn) => sum + Number(txn.amountCents || 0), 0), expense: rows.filter(txn => txn.direction === 'expense').reduce((sum, txn) => sum + Number(txn.amountCents || 0), 0) };
  });
  const active = completed.filter(month => month.rows.length > 0);
  if (active.length < 3) {
    return { kind: 'neutral', title: '先看清自己的节奏', body: `最近六个月里有 ${active.length} 个月记录了流水。样本还不够稳定，先不根据单周或单月给省钱结论；继续记录后，再结合收入起伏、必要支出和资金余额看趋势。` };
  }

  const monthlyExpenses = active.map(month => month.expense);
  const monthlyIncomes = active.map(month => month.income);
  const expenseBaseline = robustWeightedAverage(monthlyExpenses);
  const incomeBaseline = robustWeightedAverage(monthlyIncomes);
  const expenseMedian = median(monthlyExpenses);
  const incomeMedian = median(monthlyIncomes);
  const incomeMad = median(monthlyIncomes.map(value => Math.abs(value - incomeMedian)));
  const incomeVolatility = incomeMedian > 0 ? incomeMad / incomeMedian : 0;
  const currentAssets = Number(context.totalAssetsCents || 0);
  const emergency = Number(context.emergencyCents || 0);
  const essential = new Set(['food', 'home', 'transport', 'communication', 'health']);
  const essentialBaseline = robustWeightedAverage(active.map(month => month.rows.filter(txn => txn.direction === 'expense' && essential.has(txn.category)).reduce((sum, txn) => sum + Number(txn.amountCents || 0), 0)));

  if (expenseBaseline > incomeBaseline && incomeBaseline > 0 && currentAssets < expenseBaseline) {
    return { kind: 'careful', title: '先留出生活缓冲', body: `近几个月的稳健支出水平高于收入，当前总资产约覆盖 ${Math.max(0, Math.floor(currentAssets / Math.max(1, expenseBaseline) * 10) / 10)} 个月。先保证必要支出与紧急资金，再考虑压缩可选消费。` };
  }
  if (essentialBaseline > 0 && emergency < essentialBaseline * 0.5) {
    return { kind: 'careful', title: '先为必要支出留缓冲', body: `紧急资金约覆盖 ${(emergency / essentialBaseline).toFixed(1)} 个月的稳健必要支出。收入波动${incomeVolatility > 0.35 ? '较大，建议按较稳健的收入基线安排' : '较小'}，可先逐步增加安全储备，再安排可选支出。` };
  }

  const flexible = new Set(['food', 'shopping', 'entertainment', 'subscription', 'people', 'other']);
  const categoryTotals = new Map();
  for (const month of active) {
    for (const txn of month.rows) if (txn.direction === 'expense' && flexible.has(txn.category)) categoryTotals.set(txn.category, (categoryTotals.get(txn.category) || 0) + txn.amountCents);
  }
  const monthWithMostRows = active.at(-1);
  const recentCategories = new Map();
  for (const txn of monthWithMostRows.rows) if (txn.direction === 'expense' && flexible.has(txn.category)) recentCategories.set(txn.category, (recentCategories.get(txn.category) || 0) + txn.amountCents);
  const recentTotal = [...recentCategories.values()].reduce((sum, value) => sum + value, 0);
  if (recentTotal > 0 && incomeVolatility <= 0.65) {
    const largest = [...recentCategories].sort((a, b) => b[1] - a[1])[0];
    const categoryBaseline = Math.round((categoryTotals.get(largest[0]) || 0) / active.length);
    const excess = largest[1] - categoryBaseline;
    if (categoryBaseline > 0 && largest[1] > categoryBaseline * 1.3 && excess >= 3000) {
      return { kind: 'action', title: `${categoryLabel(largest[0])}比平时偏高`, body: `最近一个完整月比稳健月均多约 ¥${(excess / 100).toFixed(0)}。可以先把下月这类可选支出预算减少约 10%，再看实际感受。` };
    }
  }

  const reserveCoverage = expenseBaseline > 0 ? currentAssets / expenseBaseline : 0;
  return { kind: 'neutral', title: incomeVolatility > 0.35 ? '收入有起伏，按中位节奏安排' : '目前收支节奏平稳', body: `近六个月稳健月支出约 ¥${(expenseBaseline / 100).toFixed(0)}，稳健月收入约 ¥${(incomeBaseline / 100).toFixed(0)}；总资产约覆盖 ${reserveCoverage.toFixed(1)} 个月支出。建议仅作参考，实际优先级由你决定。` };
}

function categoryLabel(id) {
  return ({ food: '吃喝', shopping: '购物', entertainment: '娱乐', subscription: '订阅', people: '人情', other: '其他' })[id] || id;
}
