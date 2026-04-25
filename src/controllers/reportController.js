const Transaction = require('../models/Transaction');
const Booking = require('../models/Booking');
const GuestBooking = require('../models/GuestBooking');
const Room = require('../models/Room');
const Stock = require('../models/Stock');
const Invoice = require('../models/Invoice');
const Debtor = require('../models/Debtor');
const Supplier = require('../models/Supplier');
const Salary = require('../models/Salary');
const Report = require('../models/Report');
const PDFDocument = require('pdfkit');
const { asyncHandler } = require('../utils/helpers');
const logAudit = require('../utils/audit');

const MS_PER_DAY = 86400000;

function collapseTransactionDuplicateRows(rows) {
  const byKey = new Map();
  for (const tx of rows || []) {
    const d = tx.date ? new Date(tx.date).toISOString().slice(0, 10) : '';
    const key = [
      d,
      tx.type,
      String(tx.category || '').toLowerCase(),
      String(tx.description || '').trim().toLowerCase(),
      Number(tx.amount),
      String(tx.createdBy || ''),
    ].join('\t');
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, tx);
      continue;
    }
    const prevJ = !!prev.journalEntryId;
    const curJ = !!tx.journalEntryId;
    if (curJ && !prevJ) {
      byKey.set(key, tx);
      continue;
    }
    if (curJ === prevJ) {
      const pt = new Date(prev.updatedAt || prev.createdAt || 0).getTime();
      const ct = new Date(tx.updatedAt || tx.createdAt || 0).getTime();
      if (ct >= pt) byKey.set(key, tx);
    }
  }
  return Array.from(byKey.values());
}

function normalizeDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Sold nights overlapping [rangeStart, rangeEnd] (checkout date treated as non-occupied). */
function overlapSoldNights(checkIn, checkOut, rangeStart, rangeEnd) {
  if (!checkIn || !checkOut) return 0;
  const ci = normalizeDay(checkIn);
  const co = normalizeDay(checkOut);
  const rs = normalizeDay(rangeStart);
  const re = normalizeDay(rangeEnd);
  const start = new Date(Math.max(ci.getTime(), rs.getTime()));
  const end = new Date(Math.min(co.getTime(), re.getTime()));
  if (end <= start) return 0;
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / MS_PER_DAY));
}

function recognizedTransactionAmount(tx, start, end) {
  const amount = Number(tx?.amount || 0);
  if (!Number.isFinite(amount) || amount === 0) return 0;
  const category = String(tx?.category || '').toLowerCase();
  const booking = tx?.booking || null;
  const guestBooking = tx?.guestBooking || null;

  if (category === 'booking') {
    const checkIn = booking?.checkIn || guestBooking?.checkIn;
    // Strict booking revenue recognition: check-in date only (no transaction-date fallback).
    if (!checkIn) return 0;
    const ci = normalizeDay(checkIn);
    const ps = normalizeDay(start);
    const pe = normalizeDay(end);
    return ci >= ps && ci <= pe ? amount : 0;
  } else if (category === 'event') {
    const eventDate = booking?.eventDate ? new Date(booking.eventDate) : null;
    if (eventDate && !Number.isNaN(eventDate.getTime())) {
      return eventDate >= new Date(start) && eventDate <= new Date(end) ? amount : 0;
    }
  }

  const txDate = new Date(tx?.date);
  return txDate >= new Date(start) && txDate <= new Date(end) ? amount : 0;
}

async function fetchRecognizedTransactions(start, end) {
  const rows = await Transaction.find({
    $or: [
      { date: { $gte: new Date(start), $lte: new Date(end) } },
      { type: 'income', category: { $in: ['booking', 'event'] } },
    ],
  })
    .select(
      'type category amount date description createdBy journalEntryId createdAt updatedAt booking guestBooking'
    )
    .populate('booking', 'checkIn checkOut eventDate type')
    .populate('guestBooking', 'checkIn checkOut')
    .lean();
  return collapseTransactionDuplicateRows(rows);
}

async function fetchReportMetrics(start, end) {
  const checkInMatch = { checkIn: { $gte: new Date(start), $lte: new Date(end) } };
  const overlapMatch = { checkIn: { $lt: new Date(end) }, checkOut: { $gt: new Date(start) } };

  const [
    internalOverlap,
    guestOverlap,
    bnbInternalCount,
    eventInternalCount,
    lowStockCount,
    bnbRoomCount,
    internalBnbNightsRows,
    guestNightsRows,
    recognizedRows,
  ] = await Promise.all([
    Booking.countDocuments({ status: { $ne: 'cancelled' }, ...checkInMatch }),
    GuestBooking.countDocuments({ status: { $ne: 'cancelled' }, ...checkInMatch }),
    Booking.countDocuments({ status: { $ne: 'cancelled' }, type: 'bnb', ...checkInMatch }),
    Booking.countDocuments({
      status: { $ne: 'cancelled' },
      $or: [{ type: 'event', ...checkInMatch }, { type: 'event', eventDate: { $gte: new Date(start), $lte: new Date(end) } }],
    }),
    Stock.countDocuments({
      reorderLevel: { $ne: null },
      $expr: { $lt: ['$quantity', '$reorderLevel'] },
    }),
    Room.countDocuments({ type: 'bnb' }),
    Booking.find({ status: { $ne: 'cancelled' }, type: 'bnb', ...overlapMatch }).select('checkIn checkOut').lean(),
    GuestBooking.find({ status: { $ne: 'cancelled' }, ...overlapMatch }).select('checkIn checkOut').lean(),
    fetchRecognizedTransactions(start, end),
  ]);

  let bnbTxnTotal = 0;
  let eventTxnTotal = 0;
  for (const tx of recognizedRows) {
    if (String(tx.type || '').toLowerCase() !== 'income') continue;
    const category = String(tx.category || '').toLowerCase();
    const recognized = recognizedTransactionAmount(tx, start, end);
    if (!recognized) continue;
    if (category === 'booking') bnbTxnTotal += recognized;
    if (category === 'event') eventTxnTotal += recognized;
  }

  let soldNights = 0;
  for (const b of internalBnbNightsRows) {
    soldNights += overlapSoldNights(b.checkIn, b.checkOut, start, end);
  }
  for (const g of guestNightsRows) {
    soldNights += overlapSoldNights(g.checkIn, g.checkOut, start, end);
  }

  const periodDays = Math.max(1, Math.floor((normalizeDay(end).getTime() - normalizeDay(start).getTime()) / MS_PER_DAY) + 1);
  const capacityNights = Math.max(0, bnbRoomCount) * periodDays;
  const occupancyPct =
    capacityNights > 0 ? Math.min(100, Math.round((soldNights / capacityNights) * 1000) / 10) : 0;

  return {
    bookingsAll: internalOverlap + guestOverlap,
    bnbBookings: bnbInternalCount + guestOverlap,
    eventBookings: eventInternalCount,
    bnbRevenueTxn: bnbTxnTotal,
    eventRevenueTxn: eventTxnTotal,
    stockAlerts: lowStockCount,
    occupancyPct,
    soldNights,
    capacityNights,
    bnbRooms: bnbRoomCount,
  };
}

const runAggregation = async (start, end) => {
  const rows = await fetchRecognizedTransactions(start, end);
  let income = 0;
  let expense = 0;
  for (const tx of rows) {
    const type = String(tx.type || '').toLowerCase();
    const category = String(tx.category || '').toLowerCase();
    const amount = recognizedTransactionAmount(tx, start, end);
    if (!amount) continue;
    if (type === 'income') {
      if (category === 'booking_payment') continue;
      income += amount;
    } else if (type === 'expense') {
      expense += amount;
    }
  }
  return {
    income: Number(income.toFixed(2)),
    expense: Number(expense.toFixed(2)),
    profit: Number((income - expense).toFixed(2)),
  };
};

const runTransactionCashSplit = async (start, end) => {
  const rows = await Transaction.find({
    date: { $gte: new Date(start), $lte: new Date(end) },
    type: 'income',
  })
    .select('category amount')
    .lean();
  let paymentsCollected = 0;
  let incomeTransactionsTotal = 0;
  for (const tx of rows) {
    const amount = Number(tx.amount || 0);
    if (!amount) continue;
    const category = String(tx.category || '').toLowerCase();
    if (category === 'booking_payment') {
      paymentsCollected += amount;
      continue;
    }
    // "Income transactions" should represent revenue-type income only (exclude collections).
    incomeTransactionsTotal += amount;
  }
  return {
    paymentsCollected: Number(paymentsCollected.toFixed(2)),
    incomeTransactionsTotal: Number(incomeTransactionsTotal.toFixed(2)),
  };
};

const runTransactionCategoryBreakdown = async (start, end) => {
  const rows = await fetchRecognizedTransactions(start, end);
  const map = new Map();
  for (const tx of rows) {
    const type = String(tx.type || 'unknown').toLowerCase();
    const category = String(tx.category || 'uncategorized').toLowerCase();
    const recognized = recognizedTransactionAmount(tx, start, end);
    if (!recognized) continue;
    const key = `${type}::${category}`;
    const prev = map.get(key) || { type, category, count: 0, total: 0 };
    prev.count += 1;
    prev.total += recognized;
    map.set(key, prev);
  }
  return Array.from(map.values())
    .map((r) => ({ ...r, total: Number((r.total || 0).toFixed(2)) }))
    .sort((a, b) => (a.type === b.type ? b.total - a.total : a.type.localeCompare(b.type)));
};

async function fetchDbReportDetail(start, end) {
  const [topBookingsRaw, invoices, debtors, supplierCount, salaries, inventoryCount, lowStockItems] = await Promise.all([
    Booking.find({
      status: { $ne: 'cancelled' },
      checkIn: { $gte: new Date(start), $lte: new Date(end) },
    })
      .populate('roomId', 'name type')
      .sort({ amount: -1, checkIn: 1 })
      .limit(5)
      .lean(),
    Invoice.find({
      $or: [
        { issueDate: { $gte: new Date(start), $lte: new Date(end) } },
        { createdAt: { $gte: new Date(start), $lte: new Date(end) } },
      ],
      status: { $ne: 'void' },
    })
      .sort({ issueDate: -1 })
      .limit(5)
      .lean(),
    Debtor.find({ createdAt: { $gte: new Date(start), $lte: new Date(end) } }).select('amountOwed amountPaid').lean(),
    Supplier.countDocuments({ isActive: true }),
    Salary.find({ paidOn: { $gte: new Date(start), $lte: new Date(end) } }).select('amount paidOn').lean(),
    Stock.countDocuments(),
    Stock.find({
      reorderLevel: { $ne: null },
      $expr: { $lt: ['$quantity', '$reorderLevel'] },
    })
      .select('name category quantity reorderLevel')
      .sort({ reorderLevel: -1, quantity: 1 })
      .limit(10)
      .lean(),
  ]);

  const topBookings = topBookingsRaw.map((b) => ({
    guest: b.guestName || 'Guest',
    type: String(b.type || '').toUpperCase(),
    room: b.roomId?.name || b.roomName || '—',
    date: b.checkIn || null,
    amount: Number(b.amount || 0),
  }));

  const invoiceTotal = invoices.reduce((s, i) => s + Number(i.total || 0), 0);
  const debtorBalance = debtors.reduce(
    (s, d) => s + Math.max(0, Number(d.amountOwed || 0) - Number(d.amountPaid || 0)),
    0
  );
  const salaryPaid = salaries.reduce((s, row) => s + Number(row.amount || 0), 0);

  return {
    topBookings,
    invoiceFocus: invoices.map((i) => ({
      reference: i.invoiceNumber || '—',
      party: i.type || 'guest',
      status: i.status || 'draft',
      dueDate: i.dueDate || null,
      amount: Number(i.total || 0),
    })),
    lowStockItems: lowStockItems.map((s) => ({
      item: s.name,
      category: s.category || 'uncategorized',
      quantity: Number(s.quantity || 0),
      reorderLevel: Number(s.reorderLevel || 0),
    })),
    coverage: {
      guestPaymentsInvoices: {
        invoiceCount: invoices.length,
        invoiceTotal: Number(invoiceTotal.toFixed(2)),
      },
      debtorsSuppliers: {
        debtorsBalance: Number(debtorBalance.toFixed(2)),
        suppliersCount: supplierCount,
      },
      workerPayments: {
        salaryRecords: salaries.length,
        salaryPaid: Number(salaryPaid.toFixed(2)),
      },
      inventory: {
        itemCount: inventoryCount,
        lowStockCount: lowStockItems.length,
      },
    },
  };
}

const runDetailedAggregation = async (start, end) => {
  const rows = await fetchRecognizedTransactions(start, end);
  const incomeMap = new Map();
  const expenseMap = new Map();
  for (const tx of rows) {
    const type = String(tx.type || '').toLowerCase();
    const category = String(tx.category || 'uncategorized').toLowerCase();
    const amount = recognizedTransactionAmount(tx, start, end);
    if (!amount) continue;
    if (type === 'income') {
      if (category === 'booking_payment') continue;
      const prev = incomeMap.get(category) || { category, total: 0, count: 0 };
      prev.total += amount;
      prev.count += 1;
      incomeMap.set(category, prev);
    } else if (type === 'expense') {
      const prev = expenseMap.get(category) || { category, total: 0, count: 0 };
      prev.total += amount;
      prev.count += 1;
      expenseMap.set(category, prev);
    }
  }
  const incomeByCategory = Array.from(incomeMap.values()).sort((a, b) => b.total - a.total);
  const expenseByCategory = Array.from(expenseMap.values()).sort((a, b) => b.total - a.total);

  const totals = {
    income: incomeByCategory.reduce((s, r) => s + r.total, 0),
    expense: expenseByCategory.reduce((s, r) => s + r.total, 0),
  };
  totals.profit = totals.income - totals.expense;

  return {
    totals,
    incomeByCategory,
    expenseByCategory,
    topIncomeCategory: incomeByCategory[0] || null,
    topExpenseCategory: expenseByCategory[0] || null,
  };
};

function periodRange(period = 'monthly') {
  const now = new Date();
  let end = new Date(now);
  let start;
  if (period === 'weekly') {
    const endUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
    const startUtc = new Date(endUtc);
    startUtc.setUTCDate(startUtc.getUTCDate() - 6);
    startUtc.setUTCHours(0, 0, 0, 0);
    start = startUtc;
    end = endUtc;
  } else if (period === 'quarterly') {
    const q = Math.floor(now.getUTCMonth() / 3) + 1;
    start = new Date(Date.UTC(now.getUTCFullYear(), (q - 1) * 3, 1, 0, 0, 0, 0));
    end = new Date(Date.UTC(now.getUTCFullYear(), q * 3, 0, 23, 59, 59, 999));
  } else if (period === 'annual') {
    start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1, 0, 0, 0, 0));
    end = new Date(Date.UTC(now.getUTCFullYear(), 11, 31, 23, 59, 59, 999));
  } else {
    // Monthly reports should represent full calendar month, not month-to-date.
    start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
    end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999));
  }
  return { start, end };
}

function priorRange(start, end) {
  const spanMs = Math.max(1, end.getTime() - start.getTime());
  const priorEnd = new Date(start.getTime() - 1);
  const priorStart = new Date(priorEnd.getTime() - spanMs);
  return { start: priorStart, end: priorEnd };
}

function pctChange(current, prior) {
  if (!prior) return current > 0 ? 100 : 0;
  return Number((((current - prior) / Math.abs(prior)) * 100).toFixed(2));
}

function clampPct(v, min = -100, max = 200) {
  return Math.min(max, Math.max(min, Number(v) || 0));
}

function buildForecast(payload) {
  const { period, current, prior, dateRange } = payload;
  const curRev = Number(current.totals.income || 0);
  const curExp = Number(current.totals.expense || 0);
  const priorRev = Number(prior.totals.income || 0);
  const priorExp = Number(prior.totals.expense || 0);
  const revGrowthPctRaw = pctChange(curRev, priorRev);
  const expGrowthPctRaw = pctChange(curExp, priorExp);
  const revGrowthPct = clampPct(revGrowthPctRaw);
  const expGrowthPct = clampPct(expGrowthPctRaw);

  const projectedRevenueNext = Number((curRev * (1 + revGrowthPct / 100)).toFixed(2));
  const projectedExpenseNext = Number((curExp * (1 + expGrowthPct / 100)).toFixed(2));
  const projectedProfitNext = Number((projectedRevenueNext - projectedExpenseNext).toFixed(2));
  const projectedMarginPct = projectedRevenueNext
    ? Number(((projectedProfitNext / projectedRevenueNext) * 100).toFixed(2))
    : 0;

  const start = new Date(dateRange.start);
  const end = new Date(dateRange.end);
  const elapsedDays = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86400000));
  const dailyRevenueRunRate = Number((curRev / elapsedDays).toFixed(2));
  const dailyExpenseRunRate = Number((curExp / elapsedDays).toFixed(2));

  return {
    periodType: period,
    assumptions: [
      'Baseline uses current-period actuals versus prior comparable period.',
      'Growth rates are capped to reduce extreme outlier effects.',
      'No major pricing, capacity, or one-off shock changes assumed.',
    ],
    drivers: {
      revenueGrowthPct: revGrowthPct,
      expenseGrowthPct: expGrowthPct,
      dailyRevenueRunRate,
      dailyExpenseRunRate,
    },
    projection: {
      nextPeriodRevenue: projectedRevenueNext,
      nextPeriodExpense: projectedExpenseNext,
      nextPeriodProfit: projectedProfitNext,
      nextPeriodProfitMarginPct: projectedMarginPct,
    },
  };
}

function buildDetailedNarrative(payload, insight, forecast) {
  const period = payload.period;
  const cur = payload.current.totals;
  const prior = payload.prior.totals;
  const incDelta = pctChange(cur.income, prior.income);
  const expDelta = pctChange(cur.expense, prior.expense);
  const profDelta = pctChange(cur.profit, prior.profit);
  const topInc = payload.currentDetails.topIncomeCategory;
  const topExp = payload.currentDetails.topExpenseCategory;
  const tone = cur.profit >= 0 ? 'positive' : 'under pressure';
  const margin = cur.income ? ((cur.profit / cur.income) * 100).toFixed(2) : '0.00';
  const priorMargin = prior.income ? ((prior.profit / prior.income) * 100).toFixed(2) : '0.00';
  const topIncomeLines = (payload.currentDetails.incomeByCategory || [])
    .slice(0, 3)
    .map((x, i) => `${i + 1}) ${x.category}: ${x.total.toFixed(2)} across ${x.count} transactions`)
    .join(' | ');
  const topExpenseLines = (payload.currentDetails.expenseByCategory || [])
    .slice(0, 3)
    .map((x, i) => `${i + 1}) ${x.category}: ${x.total.toFixed(2)} across ${x.count} transactions`)
    .join(' | ');

  const sections = {
    executiveOverview: `Performance for the ${period} period is ${tone}. Revenue closed at ${cur.income.toFixed(
      2
    )}, expenses at ${cur.expense.toFixed(2)}, resulting in profit of ${cur.profit.toFixed(2)} (${profDelta}% versus prior comparable period). Compared with prior (${prior.income.toFixed(
      2
    )} revenue, ${prior.expense.toFixed(2)} expenses), the business shows ${
      cur.profit >= prior.profit ? 'improved' : 'weaker'
    } earnings quality and operational control.`,
    revenuePerformance: `Revenue changed by ${incDelta}% period-on-period. ${
      topInc
        ? `Primary driver is ${topInc.category} at ${topInc.total.toFixed(2)} across ${topInc.count} transactions.`
        : 'No single category concentration dominated this period.'
    } Top revenue contributors: ${topIncomeLines || 'No categorized income rows captured.'}`,
    costPerformance: `Operating costs changed by ${expDelta}% period-on-period. ${
      topExp ? `Largest cost concentration is ${topExp.category} at ${topExp.total.toFixed(2)}.` : 'No major cost concentration detected.'
    } Top expense contributors: ${topExpenseLines || 'No categorized expense rows captured.'}`,
    profitabilityAndEfficiency: `Current profit margin is ${margin}% versus ${priorMargin}% in the prior comparable period. This indicates ${
      cur.profit >= 0
        ? 'healthy conversion of recognized revenue into earnings, with room to improve cost discipline further'
        : 'earnings compression that requires immediate intervention on cost and pricing mix'
    }.`,
    riskAssessment:
      insight.risks?.length
        ? `Key risks identified: ${insight.risks.join(' ')} In addition, monitor concentration risk in top categories and aging debtor balances to protect cash conversion.`
        : 'No immediate critical financial risk flags from current aggregates; continue monitoring cost growth, receivable aging, and booking mix concentration.',
    forecastAndOutlook: `Forecast for next ${period} period projects revenue of ${forecast.projection.nextPeriodRevenue.toFixed(
      2
    )}, expenses of ${forecast.projection.nextPeriodExpense.toFixed(2)}, and profit of ${forecast.projection.nextPeriodProfit.toFixed(
      2
    )} (margin ${forecast.projection.nextPeriodProfitMarginPct}%). Driver assumptions are revenue growth ${forecast.drivers.revenueGrowthPct}% and expense growth ${forecast.drivers.expenseGrowthPct}% with run-rates of ${forecast.drivers.dailyRevenueRunRate.toFixed(
      2
    )} revenue/day and ${forecast.drivers.dailyExpenseRunRate.toFixed(2)} expense/day.`,
    recommendations:
      insight.actions?.length
        ? `Recommended management actions: ${insight.actions.join(' ')} Also assign an owner to each action, target completion inside the next 7 days, and measure impact in the next report cycle.`
        : 'Recommended management actions: maintain revenue momentum, tighten variable expense approvals, and run weekly debtor follow-ups with documented collection outcomes.',
    operationsAndCapacity: `Operational snapshot for the period shows ${
      payload.metrics?.bookingsAll ?? 0
    } bookings (BnB ${payload.metrics?.bnbBookings ?? 0}, Events ${payload.metrics?.eventBookings ?? 0}), occupancy at ${
      payload.metrics?.occupancyPct ?? 0
    }%, and ${payload.metrics?.stockAlerts ?? 0} stock alert(s). This links demand activity with delivery capacity and inventory readiness.`,
  };

  return {
    title: `Detailed ${period} financial report`,
    generatedAt: new Date().toISOString(),
    ...sections,
  };
}

function localSummary(payload) {
  const { period, current, prior, currentDetails } = payload;
  const incDelta = pctChange(current.totals.income, prior.totals.income);
  const expDelta = pctChange(current.totals.expense, prior.totals.expense);
  const profitDelta = pctChange(current.totals.profit, prior.totals.profit);
  const topInc = currentDetails.topIncomeCategory;
  const topExp = currentDetails.topExpenseCategory;
  const highlights = [];
  if (current.totals.profit >= 0) highlights.push(`Profit is positive at ${current.totals.profit.toFixed(2)} for the ${period} period.`);
  else highlights.push(`Profit is negative at ${current.totals.profit.toFixed(2)} for the ${period} period.`);
  highlights.push(`Income changed by ${incDelta}% versus previous comparable period.`);
  highlights.push(`Expense changed by ${expDelta}% versus previous comparable period.`);
  if (topInc) highlights.push(`Top revenue category is ${topInc.category} (${topInc.total.toFixed(2)}).`);
  if (topExp) highlights.push(`Top expense category is ${topExp.category} (${topExp.total.toFixed(2)}).`);
  const risks = [];
  if (current.totals.expense > current.totals.income) risks.push('Expenses exceed income in the selected period.');
  if (expDelta > 20) risks.push('Expenses are rising quickly compared to the previous period.');
  const actions = [];
  actions.push('Review top expense categories and freeze non-essential spend this week.');
  actions.push('Follow up outstanding debtors to improve near-term cash collections.');
  if (current.totals.profit < 0) actions.push('Prioritize high-margin bookings/events to recover profitability.');
  const sections = {
    revenue: {
      detail: `Revenue is ${current.totals.income.toFixed(2)} (${incDelta}% vs prior).`,
      topCategories: currentDetails.incomeByCategory.slice(0, 5),
    },
    expenses: {
      detail: `Expenses are ${current.totals.expense.toFixed(2)} (${expDelta}% vs prior).`,
      topCategories: currentDetails.expenseByCategory.slice(0, 5),
    },
    profitability: {
      detail: `Profit is ${current.totals.profit.toFixed(2)} (${profitDelta}% vs prior).`,
      marginPct: current.totals.income ? Number(((current.totals.profit / current.totals.income) * 100).toFixed(2)) : 0,
    },
    risks: { detail: risks.join(' ') || 'No critical risks detected from current period aggregates.' },
    actions: { detail: actions.join(' ') },
  };
  return {
    mode: 'local_fallback',
    summary: `For the ${period} period, income is ${current.totals.income.toFixed(2)}, expense is ${current.totals.expense.toFixed(
      2
    )}, and profit is ${current.totals.profit.toFixed(2)} (${profitDelta}% vs prior).`,
    executiveSummary: `Performance is ${current.totals.profit >= 0 ? 'profitable' : 'loss-making'} with ${
      current.totals.income.toFixed(2)
    } revenue and ${current.totals.expense.toFixed(2)} expenses.`,
    sections,
    highlights,
    risks,
    actions,
    detailedReport: buildDetailedNarrative(payload, { highlights, risks, actions }, buildForecast(payload)),
    forecast: buildForecast(payload),
  };
}

function aiProviderSequence(providerRaw) {
  const provider = String(providerRaw || 'auto').trim().toLowerCase();
  if (provider === 'openai') return ['openai'];
  if (provider === 'openrouter') return ['openrouter'];
  if (provider === 'gemini') return ['gemini'];
  return ['openai', 'openrouter', 'gemini'];
}

const REPORT_SYSTEM_PROMPT = `
You are a senior agro-tourism business analyst writing professional management reports for ValleyCroft.

Rules:
- Use formal, concise executive English.
- Anchor every claim to provided data.
- Never invent metrics, people, or events not present in input.
- Highlight trend direction, operational implications, and measurable actions.

Report structure requirements:
1) Executive Summary
2) Financial Performance
3) Booking & Operations
4) Expense and Cost Control
5) Risk Assessment
6) Recommendations and Outlook

JSON output rules:
- Return VALID JSON only.
- No markdown fences.
- Keys must match the requested schema exactly.
- Each detailed narrative section should be substantive (roughly 5-8 sentences).
`;

function buildAiReportPrompt(payload) {
  return `
Generate a detailed monthly management report using only the structured input below.

Input data:
${JSON.stringify(payload, null, 2)}

Return JSON with this exact shape:
{
  "summary": "string",
  "executiveSummary": "string",
  "highlights": ["string"],
  "risks": ["string"],
  "actions": ["string"],
  "sections": {
    "revenue": { "detail": "string", "topCategories": [] },
    "expenses": { "detail": "string", "topCategories": [] },
    "profitability": { "detail": "string", "marginPct": 0 },
    "risks": { "detail": "string" },
    "actions": { "detail": "string" }
  },
  "forecast": {
    "assumptions": ["string"],
    "drivers": {},
    "projection": {}
  },
  "detailedReport": {
    "title": "string",
    "generatedAt": "ISO date string",
    "executiveOverview": "string",
    "revenuePerformance": "string",
    "costPerformance": "string",
    "profitabilityAndEfficiency": "string",
    "riskAssessment": "string",
    "forecastAndOutlook": "string",
    "recommendations": "string"
  }
}
`;
}

async function openAiSummary(payload, options = {}) {
  const openAiKey = String(process.env.OPENAI_API_KEY || '').trim();
  const openRouterKey = String(process.env.OPENROUTER_API_KEY || '').trim();
  const geminiKey = String(process.env.GEMINI_API_KEY || '').trim();
  const providers = aiProviderSequence(options.provider);
  const prompt = buildAiReportPrompt(payload);
  const parseJson = (raw) => {
    const text = String(raw || '').trim();
    if (!text) return {};
    const cleaned = text.replace(/```json|```/gi, '').trim();
    return JSON.parse(cleaned);
  };

  const tryOpenAi = async () => {
    if (!openAiKey) throw new Error('OpenAI key not configured');
    const model = process.env.OPENAI_REPORT_MODEL || 'gpt-4o-mini';
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openAiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_output_tokens: 2200,
        input: prompt,
        instructions: REPORT_SYSTEM_PROMPT,
        text: { format: { type: 'json_object' } },
      }),
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI error: ${response.status} ${errText}`);
    }
    const data = await response.json();
    const raw = data.output_text || '{}';
    return { mode: 'openai', _providerTried: 'openai', ...parseJson(raw) };
  };

  const tryOpenRouter = async () => {
    if (!openRouterKey) throw new Error('OpenRouter key not configured');
    const model = process.env.OPENROUTER_REPORT_MODEL || 'openai/gpt-4o-mini';
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openRouterKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 3500,
        messages: [
          {
            role: 'system',
            content: REPORT_SYSTEM_PROMPT,
          },
          { role: 'user', content: prompt },
        ],
      }),
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenRouter error: ${response.status} ${errText}`);
    }
    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content || '{}';
    return { mode: 'openrouter', _providerTried: 'openrouter', ...parseJson(raw) };
  };

  const tryGemini = async () => {
    if (!geminiKey) throw new Error('Gemini key not configured');
    const configured = String(process.env.GEMINI_REPORT_MODEL || '').trim();
    const models = [
      ...(configured ? [configured] : []),
      'gemini-1.5-flash',
      'gemini-2.0-flash',
      'gemini-1.5-pro-latest',
    ].filter((v, i, arr) => v && arr.indexOf(v) === i);

    const modelErrors = [];
    for (const model of models) {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(geminiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `${prompt}\n\nRespond with JSON only.` }] }],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.3,
              maxOutputTokens: 3200,
            },
          }),
        }
      );
      if (!response.ok) {
        const errText = await response.text();
        modelErrors.push(`${model}: ${response.status} ${errText}`);
        continue;
      }
      const data = await response.json();
      const raw = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('\n') || '{}';
      return { mode: 'gemini', _providerTried: 'gemini', aiModel: model, ...parseJson(raw) };
    }
    throw new Error(`Gemini error: ${modelErrors.join(' | ')}`);
  };

  const errors = [];
  for (const p of providers) {
    try {
      if (p === 'openai') return await tryOpenAi();
      if (p === 'openrouter') return await tryOpenRouter();
      if (p === 'gemini') return await tryGemini();
    } catch (err) {
      errors.push(`${p}: ${err.message}`);
    }
  }
  if (errors.length) {
    const err = new Error(errors.join(' | '));
    err.providersTried = providers;
    throw err;
  }
  return null;
}

async function buildAiSummaryData(periodInput, options = {}) {
  const period = ['weekly', 'monthly', 'quarterly', 'annual'].includes(String(periodInput || '').toLowerCase())
    ? String(periodInput).toLowerCase()
    : 'monthly';
  const { start, end } = periodRange(period);
  const prior = priorRange(start, end);
  const [currentData, priorData, currentDetails, priorDetails, metricsRaw, cashCurrent, txBreakdown, dbDetailRaw] = await Promise.all([
    runAggregation(start, end),
    runAggregation(prior.start, prior.end),
    runDetailedAggregation(start, end),
    runDetailedAggregation(prior.start, prior.end),
    fetchReportMetrics(start, end),
    runTransactionCashSplit(start, end),
    runTransactionCategoryBreakdown(start, end),
    fetchDbReportDetail(start, end),
  ]);
  const dbDetail = { ...(dbDetailRaw || {}) };
  const metrics = { ...(metricsRaw || {}) };
  const bookingIncomeCount = (currentDetails?.incomeByCategory || [])
    .filter((r) => String(r.category || '').toLowerCase() === 'booking')
    .reduce((s, r) => s + Number(r.count || 0), 0);
  if (!Number(metrics.bookingsAll || 0) && bookingIncomeCount > 0) metrics.bookingsAll = bookingIncomeCount;
  if (!Number(metrics.bnbBookings || 0) && bookingIncomeCount > 0) metrics.bnbBookings = bookingIncomeCount;
  if (!Number(metrics.stockAlerts || 0) && Array.isArray(dbDetail.lowStockItems) && dbDetail.lowStockItems.length) {
    metrics.stockAlerts = dbDetail.lowStockItems.length;
  }
  if (
    (!dbDetail.coverage || !dbDetail.coverage.guestPaymentsInvoices) &&
    Array.isArray(dbDetail.invoiceFocus)
  ) {
    dbDetail.coverage = dbDetail.coverage || {};
    dbDetail.coverage.guestPaymentsInvoices = {
      invoiceCount: dbDetail.invoiceFocus.length,
      invoiceTotal: dbDetail.invoiceFocus.reduce((s, r) => s + Number(r.amount || 0), 0),
    };
  }
  if (
    dbDetail.coverage?.guestPaymentsInvoices &&
    Number(dbDetail.coverage.guestPaymentsInvoices.invoiceCount || 0) === 0 &&
    Array.isArray(dbDetail.invoiceFocus) &&
    dbDetail.invoiceFocus.length
  ) {
    dbDetail.coverage.guestPaymentsInvoices.invoiceCount = dbDetail.invoiceFocus.length;
    dbDetail.coverage.guestPaymentsInvoices.invoiceTotal = dbDetail.invoiceFocus.reduce(
      (s, r) => s + Number(r.amount || 0),
      0
    );
  }
  const payload = {
    period,
    current: { totals: currentData },
    prior: { totals: priorData },
    currentDetails,
    priorDetails,
    metrics,
    dateRange: {
      start: start.toISOString(),
      end: end.toISOString(),
    },
  };

  // Base summary remains DB-derived; AI may enrich narrative text only.
  const baseInsight = localSummary(payload);
  const aiPromptPayload = {
    ...payload,
    financeTruth: {
      recognizedRevenue: Number(currentData.income || 0),
      recognizedExpenses: Number(currentData.expense || 0),
      recognizedProfit: Number(currentData.profit || 0),
      paymentsCollected: Number(cashCurrent.paymentsCollected || 0),
      incomeTransactionsTotal: Number(cashCurrent.incomeTransactionsTotal || 0),
    },
    dbDetail: {
      transactionCategoryBreakdown: txBreakdown,
      ...dbDetail,
    },
    instruction:
      'Write management-grade narrative and recommendations. Do not change numeric facts from financeTruth/current totals.',
  };

  let insight = { ...baseInsight, mode: 'database_summary' };
  const aiMeta = {
    requestedProvider: String(options.provider || 'auto').toLowerCase(),
    providersTried: aiProviderSequence(options.provider),
    providerUsed: null,
    error: null,
  };
  try {
    const ai = await openAiSummary(aiPromptPayload, options);
    if (ai) {
      insight = {
        ...baseInsight,
        ...ai,
        // Keep deterministic DB facts as source of truth.
        summary: baseInsight.summary,
        executiveSummary: baseInsight.executiveSummary,
        mode: 'ai_db_grounded',
        aiProvider: String(ai.mode || 'ai').toLowerCase(),
      };
      insight.modeLabel = modeLabel(insight.mode, insight.aiProvider);
      aiMeta.providerUsed = String(ai.mode || '').toLowerCase() || null;
    }
  } catch (err) {
    insight = { ...baseInsight, mode: 'database_summary', warning: err.message };
    insight.modeLabel = modeLabel(insight.mode);
    aiMeta.error = err.message;
    if (Array.isArray(err.providersTried)) aiMeta.providersTried = err.providersTried;
  }
  if (!insight.forecast) insight.forecast = buildForecast(payload);
  if (!insight.detailedReport) insight.detailedReport = buildDetailedNarrative(payload, insight, insight.forecast);
  if (!insight.modeLabel) insight.modeLabel = modeLabel(insight.mode, insight.aiProvider);
  return {
    period,
    aggregates: payload,
    insight,
    metrics,
    operationalKpis: {
      bookingsAll: Number(metrics.bookingsAll || 0),
      bnbBookings: Number(metrics.bnbBookings || 0),
      eventBookings: Number(metrics.eventBookings || 0),
      occupancyPct: Number(metrics.occupancyPct || 0),
      stockAlerts: Number(metrics.stockAlerts || 0),
      soldNights: Number(metrics.soldNights || 0),
      capacityNights: Number(metrics.capacityNights || 0),
    },
    financeTruth: {
      recognizedRevenue: Number(currentData.income || 0),
      paymentsCollected: Number(cashCurrent.paymentsCollected || 0),
      incomeTransactionsTotal: Number(cashCurrent.incomeTransactionsTotal || 0),
      expenses: Number(currentData.expense || 0),
      netRecognized: Number(currentData.profit || 0),
    },
    dbDetail: {
      transactionCategoryBreakdown: txBreakdown,
      ...dbDetail,
    },
    aiMeta,
  };
}

function money(v) {
  return `ZAR ${Number(v || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatRandInt(v) {
  return `R ${Math.round(Number(v || 0)).toLocaleString('en-ZA')}`;
}

function pdfModeLabel(mode) {
  if (mode === 'ai_db_grounded') return 'AI-authored narrative (DB-grounded)';
  if (mode === 'openai' || mode === 'openai_db_grounded') return 'OpenAI';
  if (mode === 'openrouter_db_grounded') return 'OpenRouter';
  if (mode === 'gemini_db_grounded') return 'Gemini';
  if (mode === 'openrouter') return 'OpenRouter';
  if (mode === 'gemini') return 'Gemini';
  if (mode === 'local_fallback') return 'Fallback summary';
  if (mode === 'database_summary') return 'DB summary';
  return 'Fallback summary';
}

function modeLabel(mode, aiProvider) {
  if (mode === 'ai_db_grounded') {
    const p = String(aiProvider || 'ai').toLowerCase();
    if (p === 'gemini') return 'AI-authored narrative (DB-grounded, Gemini)';
    if (p === 'openrouter') return 'AI-authored narrative (DB-grounded, OpenRouter)';
    if (p === 'openai') return 'AI-authored narrative (DB-grounded, OpenAI)';
    return 'AI-authored narrative (DB-grounded)';
  }
  if (mode === 'database_summary') return 'Fallback (DB summary — no AI key or AI error)';
  return pdfModeLabel(mode);
}

function buildAiSummaryPdfBuffer(result, user) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const right = left + width;
    const bottomLimit = doc.page.height - doc.page.margins.bottom;
    const dark = '#111827';
    const body = '#374151';
    const green = '#1f5f1f';
    const softFill = '#f3f6f4';
    const headFill = '#e6ece7';
    const border = '#cfd8d3';
    const agg = result.aggregates;
    const insight = result.insight || {};
    const metrics = result.metrics || {};
    const financeTruth = result.financeTruth || {};
    const dbDetail = result.dbDetail || {};
    const compiled =
      (user && (user.name || user.email)) || (user && String(user.role || '').toUpperCase()) || 'ADMIN';

    const periodStart = new Date(agg.dateRange.start);
    const periodEnd = new Date(agg.dateRange.end);
    const periodWord =
      result.period === 'weekly'
        ? 'Weekly'
        : result.period === 'quarterly'
          ? 'Quarterly'
          : result.period === 'annual'
            ? 'Annual'
            : 'Monthly';

    function periodLabel() {
      if (result.period === 'monthly') {
        return new Intl.DateTimeFormat('en-ZA', { month: 'long', year: 'numeric' }).format(periodStart);
      }
      if (result.period === 'weekly') {
        return `${periodStart.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' })} – ${periodEnd.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' })}`;
      }
      if (result.period === 'quarterly') {
        const q = Math.floor(periodStart.getMonth() / 3) + 1;
        return `Q${q} ${periodStart.getFullYear()}`;
      }
      if (result.period === 'annual') {
        return String(periodStart.getFullYear());
      }
      return new Intl.DateTimeFormat('en-ZA', { month: 'long', year: 'numeric' }).format(periodStart);
    }

    const generatedStr = new Date().toLocaleString('en-ZA', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    const generatedDateOnly = new Date().toLocaleDateString('en-ZA', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });

    function ensureSpace(needed) {
      if (doc.y + needed > bottomLimit) {
        doc.addPage();
        doc.y = doc.page.margins.top;
      }
    }

    function sectionHeader(title) {
      ensureSpace(34);
      doc.font('Times-Bold').fontSize(13).fillColor(dark).text(title, left, doc.y, { width });
      doc.moveDown(0.28);
      doc.strokeColor(green).lineWidth(1).moveTo(left, doc.y).lineTo(right, doc.y).stroke();
      doc.moveDown(0.45);
    }

    function introBox(text) {
      ensureSpace(55);
      const y = doc.y;
      const h = Math.max(36, doc.heightOfString(text, { width: width - 26 }) + 14);
      doc.rect(left, y, width, h).fillAndStroke(softFill, border);
      doc.rect(left, y, 4, h).fill(green);
      doc.font('Helvetica').fontSize(9.5).fillColor(body).text(text, left + 12, y + 7, { width: width - 20 });
      doc.y = y + h + 12;
    }

    function drawTable(headers, rows, colWidths) {
      const headH = 24;
      const rowH = 28;
      ensureSpace(headH + Math.max(1, rows.length) * rowH + 12);
      const top = doc.y;
      doc.rect(left, top, width, headH).fillAndStroke(headFill, border);
      let x = left;
      headers.forEach((h, idx) => {
        const w = colWidths[idx];
        if (idx > 0) doc.moveTo(x, top).lineTo(x, top + headH + rowH * Math.max(1, rows.length)).strokeColor(border).lineWidth(0.5).stroke();
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#4b5563').text(h.toUpperCase(), x + 8, top + 8, { width: w - 12 });
        x += w;
      });
      const usableRows = rows.length ? rows : [['No data in this period', '', '']];
      usableRows.forEach((r, rIdx) => {
        const y = top + headH + rIdx * rowH;
        doc.rect(left, y, width, rowH).strokeColor(border).lineWidth(0.5).stroke();
        let cx = left;
        r.forEach((cell, i) => {
          doc.font('Helvetica').fontSize(9.5).fillColor(dark).text(String(cell ?? ''), cx + 8, y + 8, { width: colWidths[i] - 12 });
          cx += colWidths[i];
        });
      });
      doc.y = top + headH + usableRows.length * rowH + 12;
    }

    function fmtDate(v) {
      if (!v) return '—';
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return '—';
      return d.toISOString().slice(0, 10);
    }

    doc.y = doc.page.margins.top;
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#6b7280').text('VALLEYCROFT · BUSINESS PERFORMANCE', left, doc.y, {
      width,
      characterSpacing: 1.3,
    });
    doc.moveDown(0.35);
    doc.font('Times-Bold').fontSize(21).fillColor(green).text(`${periodWord} Management Report for ${periodLabel()}`, left, doc.y, { width });
    doc.moveDown(0.55);
    doc.strokeColor(border).lineWidth(0.7).moveTo(left, doc.y).lineTo(right, doc.y).stroke();
    doc.moveDown(0.55);

    const metaColW = width / 3;
    const metaY = doc.y;
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#6b7280').text('REPORTING PERIOD', left, metaY, { width: metaColW });
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#6b7280').text('GENERATED', left + metaColW, metaY, { width: metaColW });
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#6b7280').text('PREPARED FOR', left + metaColW * 2, metaY, { width: metaColW });
    doc.font('Helvetica-Bold').fontSize(13).fillColor(dark).text(periodLabel(), left, metaY + 12, { width: metaColW });
    doc.font('Helvetica-Bold').fontSize(13).fillColor(dark).text(generatedStr, left + metaColW, metaY + 12, { width: metaColW });
    doc.font('Helvetica-Bold').fontSize(13).fillColor(dark).text(String(compiled).toUpperCase(), left + metaColW * 2, metaY + 12, { width: metaColW });
    doc.y = metaY + 42;
    doc.moveDown(0.4);
    doc.strokeColor(green).lineWidth(1.2).moveTo(left, doc.y).lineTo(right, doc.y).stroke();
    doc.moveDown(0.8);

    sectionHeader('Executive summary');
    introBox('High-level view of performance and position for the period under review.');
    doc.font('Helvetica').fontSize(11).fillColor(body).text(insight.summary || insight.executiveSummary || 'No summary generated.', left, doc.y, { width });
    doc.moveDown(1);

    sectionHeader('Management commentary');
    introBox('Structured interpretation of the period. Numeric totals in the sections that follow remain the authoritative record.');
    doc.font('Helvetica-Bold').fontSize(10).fillColor(dark).text(`Analysis mode: ${insight.modeLabel || pdfModeLabel(insight.mode)} (${insight.mode || '—'})`, left, doc.y, { width });
    doc.moveDown(0.5);
    const detailed = insight.detailedReport || {};
    const commentary = [
      detailed.executiveOverview,
      detailed.revenuePerformance,
      detailed.costPerformance,
      detailed.profitabilityAndEfficiency,
      detailed.riskAssessment,
      detailed.forecastAndOutlook,
      detailed.recommendations,
    ].filter(Boolean);
    (commentary.length ? commentary : [insight.executiveSummary || insight.summary || '—']).forEach((p) => {
      ensureSpace(52);
      doc.font('Helvetica').fontSize(10.5).fillColor(body).text(p, left, doc.y, { width, align: 'left', lineGap: 2 });
      doc.moveDown(0.65);
    });
    doc.moveDown(0.4);

    const rev = financeTruth.recognizedRevenue != null ? financeTruth.recognizedRevenue : agg.current.totals.income;
    const exp = agg.current.totals.expense;
    const net = agg.current.totals.profit;
    const payments = financeTruth.paymentsCollected != null ? financeTruth.paymentsCollected : 0;
    sectionHeader('Financial snapshot');
    introBox('Core income, expense, and activity indicators straight from Valleycroft — suitable for comparing to budget, prior periods, or covenant thresholds.');
    drawTable(
      ['Indicator', 'Amount / Value'],
      [
        ['Recognised revenue', formatRandInt(rev)],
        ['Payments collected', formatRandInt(payments)],
        ['Expenses', formatRandInt(exp)],
        ['Net result (recognized basis)', formatRandInt(net)],
        ['Income transactions (cash-style total)', formatRandInt(financeTruth.incomeTransactionsTotal ?? rev)],
        ['Bookings (all)', `${metrics.bookingsAll ?? 0} (BnB ${metrics.bnbBookings ?? 0}, Events ${metrics.eventBookings ?? 0})`],
        ['Occupancy', `${metrics.occupancyPct ?? 0}% (${metrics.soldNights ?? 0}/${metrics.capacityNights ?? 0} nights)`],
        ['Stock alerts', `${metrics.stockAlerts ?? 0} item(s)`],
      ],
      [width * 0.62, width * 0.38]
    );

    sectionHeader('Scope of data & assurance');
    introBox('Shows where each block of numbers originates so reviewers can judge coverage, lineage, and where to drill deeper in the live system.');
    drawTable(
      ['Domain', 'Evidence in this period', 'Coverage'],
      [
        ['Bookings & reservations', `${metrics.bookingsAll ?? 0} stays | BnB ${formatRandInt(metrics.bnbRevenueTxn)} | Events ${formatRandInt(metrics.eventRevenueTxn)}`, 'Included'],
        [
          'Guest payments & invoicing',
          `${dbDetail.coverage?.guestPaymentsInvoices?.invoiceCount ?? 0} invoices | Invoiced ${formatRandInt(dbDetail.coverage?.guestPaymentsInvoices?.invoiceTotal ?? 0)}`,
          'Included',
        ],
        ['Recognised vs. cash-style income', `${formatRandInt(rev)} recognised | ${formatRandInt(financeTruth.incomeTransactionsTotal ?? rev)} transaction total`, 'Included'],
        ['Debtors & suppliers', `Debtors balance ${formatRandInt(dbDetail.coverage?.debtorsSuppliers?.debtorsBalance ?? 0)} | ${(dbDetail.coverage?.debtorsSuppliers?.suppliersCount ?? 0)} supplier records`, 'Included'],
        ['Worker remuneration', `${dbDetail.coverage?.workerPayments?.salaryRecords ?? 0} payroll line(s) | ${formatRandInt(dbDetail.coverage?.workerPayments?.salaryPaid ?? 0)} paid`, 'Included'],
        ['Inventory & stock', `${dbDetail.coverage?.inventory?.itemCount ?? 0} SKU(s) | ${dbDetail.coverage?.inventory?.lowStockCount ?? 0} below reorder`, 'Included'],
      ],
      [width * 0.40, width * 0.48, width * 0.12]
    );

    sectionHeader('Income & expense by category');
    drawTable(
      ['Type', 'Category', 'Count', 'Total'],
      (dbDetail.transactionCategoryBreakdown || []).map((r) => [r.type, r.category, r.count, formatRandInt(r.total)]),
      [width * 0.18, width * 0.34, width * 0.16, width * 0.32]
    );

    sectionHeader('Top bookings in period');
    drawTable(
      ['Guest', 'Type', 'Stay / room', 'Date', 'Amount'],
      (dbDetail.topBookings || []).map((r) => [r.guest, r.type, r.room || '—', fmtDate(r.date), formatRandInt(r.amount)]),
      [width * 0.25, width * 0.11, width * 0.30, width * 0.14, width * 0.20]
    );

    sectionHeader('Invoice focus');
    drawTable(
      ['Reference', 'Party', 'Status', 'Due date', 'Amount'],
      (dbDetail.invoiceFocus || []).map((r) => [r.reference, r.party, r.status, fmtDate(r.dueDate), formatRandInt(r.amount)]),
      [width * 0.24, width * 0.16, width * 0.18, width * 0.20, width * 0.22]
    );

    sectionHeader('Low stock items');
    drawTable(
      ['Item', 'Category', 'Quantity', 'Reorder level'],
      (dbDetail.lowStockItems || []).map((r) => [r.item, r.category, r.quantity, r.reorderLevel]),
      [width * 0.40, width * 0.26, width * 0.17, width * 0.17]
    );

    if (insight.warning) {
      ensureSpace(40);
      doc.font('Helvetica').fontSize(8).fillColor('#b45309').text(`AI note: ${insight.warning}`, left, doc.y, { width });
      doc.moveDown(0.8);
    }
    ensureSpace(35);
    doc.moveDown(0.35);
    doc.font('Helvetica').fontSize(8.5).fillColor('#6b7280').text(
      'Compiled from Valleycroft dashboard and transactional data. Finance and CEO views are read-only; underlying figures remain system-of-record from the database.',
      left,
      doc.y,
      { width, align: 'left' }
    );

    doc.end();
  });
}

async function persistReportRecord(req, payload) {
  const {
    reportType,
    period = null,
    format = 'json',
    dateRange = null,
    data = null,
    meta = null,
  } = payload || {};

  try {
    await Report.create({
      reportType,
      period,
      format,
      generatedBy: req?.user?._id || null,
      role: req?.user?.role || null,
      sourcePath: req?.originalUrl || null,
      dateRange: dateRange
        ? {
            start: dateRange.start ? new Date(dateRange.start) : null,
            end: dateRange.end ? new Date(dateRange.end) : null,
          }
        : undefined,
      data,
      meta,
    });
  } catch (err) {
    // Report persistence should not block report delivery.
    console.error('Failed to persist report record:', err?.message || err);
  }
}

const getWeekly = asyncHandler(async (req, res) => {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 7);
  const data = await runAggregation(start, end);
  await persistReportRecord(req, {
    reportType: 'weekly',
    period: 'weekly',
    format: 'json',
    dateRange: { start, end },
    data,
  });
  res.json({ success: true, data });
});

const getMonthly = asyncHandler(async (req, res) => {
  const end = new Date();
  const start = new Date(end.getFullYear(), end.getMonth(), 1);
  const data = await runAggregation(start, end);
  await persistReportRecord(req, {
    reportType: 'monthly',
    period: 'monthly',
    format: 'json',
    dateRange: { start, end },
    data,
  });
  res.json({ success: true, data });
});

const getQuarterly = asyncHandler(async (req, res) => {
  const end = new Date();
  const quarter = Math.floor(end.getMonth() / 3) + 1;
  const start = new Date(end.getFullYear(), (quarter - 1) * 3, 1);
  const data = await runAggregation(start, end);
  await persistReportRecord(req, {
    reportType: 'quarterly',
    period: 'quarterly',
    format: 'json',
    dateRange: { start, end },
    data,
  });
  res.json({ success: true, data });
});

const getAnnual = asyncHandler(async (req, res) => {
  const end = new Date();
  const start = new Date(end.getFullYear(), 0, 1);
  const data = await runAggregation(start, end);
  await persistReportRecord(req, {
    reportType: 'annual',
    period: 'annual',
    format: 'json',
    dateRange: { start, end },
    data,
  });
  res.json({ success: true, data });
});

const exportReport = asyncHandler(async (req, res) => {
  const { type } = req.params;
  const end = new Date();
  let start;
  if (type === 'weekly') {
    start = new Date(end);
    start.setDate(start.getDate() - 7);
  } else if (type === 'monthly') {
    start = new Date(end.getFullYear(), end.getMonth(), 1);
  } else if (type === 'quarterly') {
    const q = Math.floor(end.getMonth() / 3) + 1;
    start = new Date(end.getFullYear(), (q - 1) * 3, 1);
  } else {
    start = new Date(end.getFullYear(), 0, 1);
  }
  const data = await runAggregation(start, end);
  await persistReportRecord(req, {
    reportType: 'export',
    period: type,
    format: 'json',
    dateRange: { start, end },
    data,
    meta: { exportType: type },
  });
  res.setHeader('Content-Type', 'application/json');
  res.json({ success: true, data });
});

const getAiSummary = asyncHandler(async (req, res) => {
  const provider = req.body?.provider || req.body?.aiProvider || req.query?.provider || req.query?.aiProvider;
  const result = await buildAiSummaryData(req.body.period, { provider });
  const reportDoc = await Report.create({
    reportType: 'ai-summary',
    period: result.period,
    format: 'json',
    generatedBy: req?.user?._id || null,
    role: req?.user?.role || null,
    sourcePath: req?.originalUrl || null,
    dateRange: result.aggregates?.dateRange || null,
    data: result,
    meta: { mode: result.insight?.mode || null },
  });

  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'create',
    entity: 'AiReportSummary',
    after: { period: result.period, mode: result.insight?.mode },
    req,
  });

  res.json({
    success: true,
    data: {
      ...result,
      reportId: reportDoc?._id || null,
    },
    reportId: reportDoc?._id || null,
    meta: { reportId: reportDoc?._id || null },
  });
});

const listSavedAiReports = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const skip = (page - 1) * limit;
  const period = String(req.query.period || '').trim().toLowerCase();

  const match = { reportType: 'ai-summary', format: 'json' };
  if (period && ['weekly', 'monthly', 'quarterly', 'annual'].includes(period)) {
    match.period = period;
  }

  const [rows, total] = await Promise.all([
    Report.find(match)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('_id period role generatedBy createdAt updatedAt data meta')
      .lean(),
    Report.countDocuments(match),
  ]);

  const data = rows.map((r) => ({
    ...r,
    generatedByRole: r.role || 'admin',
  }));

  return res.json({
    success: true,
    data,
    meta: {
      page,
      limit,
      total,
      period: period || null,
    },
  });
});

const getAiSummaryPdf = asyncHandler(async (req, res) => {
  let result = null;
  let sourceReportId = null;
  const reportId = String(req.query.reportId || '').trim();
  if (reportId && /^[0-9a-fA-F]{24}$/.test(reportId)) {
    const saved = await Report.findOne({ _id: reportId, reportType: 'ai-summary', format: 'json' }).lean();
    if (saved?.data) {
      result = saved.data;
      sourceReportId = String(saved._id);
    }
  }
  if (!result) {
    const provider = req.query?.provider || req.query?.aiProvider || req.body?.provider || req.body?.aiProvider;
    result = await buildAiSummaryData(req.query.period, { provider });
  }
  const pdf = await buildAiSummaryPdfBuffer(result, req.user);
  await persistReportRecord(req, {
    reportType: 'ai-summary-pdf',
    period: result.period,
    format: 'pdf',
    dateRange: result.aggregates?.dateRange || null,
    data: {
      byteLength: pdf.length,
      fileName: `ai-report-${result.period}-${new Date().toISOString().slice(0, 10)}.pdf`,
    },
    meta: { mode: result.insight?.mode || null, sourceReportId },
  });
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'create',
    entity: 'AiReportSummaryPdf',
    after: { period: result.period, mode: result.insight?.mode },
    req,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="ai-report-${result.period}-${new Date().toISOString().slice(0, 10)}.pdf"`);
  res.send(pdf);
});

const deleteSavedReport = asyncHandler(async (req, res) => {
  const id =
    req.params.id ||
    req.query.id ||
    req.query.reportId ||
    req.body?.id ||
    req.body?.reportId ||
    null;
  if (!id || !/^[0-9a-fA-F]{24}$/.test(String(id))) {
    return res.status(400).json({ success: false, message: 'Valid report id is required' });
  }
  const deleted = await Report.findByIdAndDelete(id);
  if (!deleted) {
    return res.status(404).json({ success: false, message: 'Report not found' });
  }
  let cascadeDeletedCount = 0;
  if (deleted.reportType === 'ai-summary') {
    const cascade = await Report.deleteMany({ 'meta.sourceReportId': String(deleted._id) });
    cascadeDeletedCount = Number(cascade.deletedCount || 0);
  }

  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'delete',
    entity: 'Report',
    before: {
      reportId: deleted._id,
      reportType: deleted.reportType,
      period: deleted.period,
      format: deleted.format,
      cascadeDeletedCount,
    },
    req,
  });

  return res.json({ success: true, message: 'Report deleted', cascadeDeletedCount });
});

module.exports = {
  getWeekly,
  getMonthly,
  getQuarterly,
  getAnnual,
  exportReport,
  getAiSummary,
  listSavedAiReports,
  getAiSummaryPdf,
  deleteSavedReport,
};
