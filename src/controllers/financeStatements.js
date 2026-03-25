// Financial Statement aggregation pipelines
// Mount via financeRoutes.js:
//   router.get('/income-statement', ... getIncomeStatement);
//   router.get('/balance-sheet',    ... getBalanceSheet);
//   router.get('/cashflow',         ... getCashFlow);
//   router.get('/pl',               ... getPL);

const Transaction = require('../models/Transaction');
const Debtor = require('../models/Debtor');
const Booking = require('../models/Booking');
const Invoice = require('../models/Invoice');
const logAudit = require('../utils/audit');

/** GL codes aligned with `scripts/seedAccounting.js` chart */
const BS_ACCOUNT = {
  bank: { code: '1002', name: 'Bank Account' },
  ar: { code: '1010', name: 'Accounts Receivable' },
  depositsHeld: { code: '1020', name: 'Inventory' },
  prepaid: { code: '1030', name: 'Prepaid Expenses' },
  ppe: { code: '1100', name: 'Property, Plant & Equipment' },
  accDep: { code: '1110', name: 'Accumulated Depreciation' },
  ap: { code: '2001', name: 'Accounts Payable' },
  deferredRevenue: { code: '2030', name: 'Deferred Revenue' },
  accrued: { code: '2010', name: 'Accrued Expenses' },
  longTermDebt: { code: '2100', name: 'Long-term Debt' },
  shareCapital: { code: '3001', name: 'Share Capital' },
  retainedEarnings: { code: '3010', name: 'Retained Earnings' },
};

function bsLine(amount, { code, name }) {
  return { amount, accountCode: code, accountName: name };
}

function bsTotal(amount, accountName) {
  return { amount, accountCode: null, accountName };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** YYYY-MM-DD → UTC day bounds so DB dates (often UTC midnight) match the user's calendar range */
function parseDateParamToUtcStart(isoDate) {
  const s = String(isoDate).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T00:00:00.000Z`);
  const d = new Date(s);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function parseDateParamToUtcEnd(isoDate) {
  const s = String(isoDate).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T23:59:59.999Z`);
  const d = new Date(s);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

const parseDates = (query) => {
  const now = new Date();
  const y = now.getUTCFullYear();
  if (query.year) {
    const yr = String(query.year).trim();
    return {
      start: new Date(`${yr}-01-01T00:00:00.000Z`),
      end: new Date(`${yr}-12-31T23:59:59.999Z`),
    };
  }
  if (query.month) {
    const [yy, mm] = String(query.month).trim().split('-');
    if (yy && mm) {
      const last = new Date(parseInt(yy, 10), parseInt(mm, 10), 0).getDate();
      return {
        start: new Date(`${yy}-${mm.padStart(2, '0')}-01T00:00:00.000Z`),
        end: new Date(`${yy}-${mm.padStart(2, '0')}-${String(last).padStart(2, '0')}T23:59:59.999Z`),
      };
    }
  }
  if (query.startDate || query.start) {
    const start = parseDateParamToUtcStart(query.startDate || query.start);
    const end =
      query.endDate || query.end
        ? parseDateParamToUtcEnd(query.endDate || query.end)
        : parseDateParamToUtcEnd(`${y}-12-31`);
    return { start, end };
  }
  if (query.endDate || query.end) {
    const end = parseDateParamToUtcEnd(query.endDate || query.end);
    const start = new Date(Date.UTC(y, 0, 1, 0, 0, 0, 0));
    return { start, end };
  }
  const start = new Date(Date.UTC(y, 0, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(y, 11, 31, 23, 59, 59, 999));
  return { start, end };
};

const sumByCategory = async (type, categories, start, end) => {
  const results = await Transaction.aggregate([
    {
      $match: {
        type,
        category: { $in: categories },
        date: { $gte: start, $lte: end },
      },
    },
    {
      $group: {
        _id: '$category',
        total: { $sum: '$amount' },
      },
    },
  ]);

  return results.reduce((acc, r) => {
    acc[r._id] = r.total;
    return acc;
  }, {});
};

const sumType = async (type, start, end) => {
  const r = await Transaction.aggregate([
    { $match: { type, date: { $gte: start, $lte: end } } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  return r[0]?.total || 0;
};

// ─── INCOME STATEMENT ──────────────────────────────────────────────────────
exports.getIncomeStatement = async (req, res) => {
  try {
    const { start, end } = parseDates(req.query);

    const periodLength = end - start;
    const priorEnd = new Date(start - 1);
    const priorStart = new Date(priorEnd - periodLength);

    const buildStatement = async (s, e) => {
      const revCats = await sumByCategory('income', ['booking', 'event', 'other'], s, e);
      const revGross = Object.values(revCats).reduce((a, b) => a + b, 0);
      // Cash refunds to customers (Transaction type expense, category refund) — contra-revenue, same as GL Dr 4001
      const refundCats = await sumByCategory('expense', ['refund'], s, e);
      const refunds = refundCats.refund || 0;
      const revTotal = revGross - refunds;

      const cogsCats = await sumByCategory('expense', ['salary', 'supplies', 'utilities', 'maintenance'], s, e);
      const cogsTotal = Object.values(cogsCats).reduce((a, b) => a + b, 0);

      const grossProfit = revTotal - cogsTotal;

      const opexCats = await sumByCategory('expense', ['marketing', 'software', 'insurance', 'admin'], s, e);
      const opexTotal = Object.values(opexCats).reduce((a, b) => a + b, 0);

      const ebit = grossProfit - opexTotal;

      const interest = (await sumByCategory('expense', ['interest'], s, e)).interest || 0;
      const taxEstimate = Math.max(ebit * 0.18, 0);

      return {
        revenue: {
          booking: revCats.booking || 0,
          eventHire: revCats.event || 0,
          other: revCats.other || 0,
          gross: revGross,
          refunds,
          total: revTotal,
        },
        cogs: {
          staffWages: cogsCats.salary || 0,
          supplies: cogsCats.supplies || 0,
          utilities: cogsCats.utilities || 0,
          maintenance: cogsCats.maintenance || 0,
          total: cogsTotal,
        },
        grossProfit,
        opex: {
          marketing: opexCats.marketing || 0,
          adminSoftware: (opexCats.software || 0) + (opexCats.admin || 0),
          insurance: opexCats.insurance || 0,
          other: opexCats.other || 0,
          total: opexTotal,
        },
        ebit,
        interest,
        taxEstimate,
        netIncome: ebit - interest - taxEstimate,
      };
    };

    const [current, prior] = await Promise.all([
      buildStatement(start, end),
      buildStatement(priorStart, priorEnd),
    ]);

    await logAudit({ userId: req.user._id, role: req.user.role, action: 'export', entity: 'IncomeStatement', req });

    res.json({ success: true, data: { ...current, prior } });
  } catch (err) {
    console.error('Income statement error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate income statement' });
  }
};

// ─── BALANCE SHEET ─────────────────────────────────────────────────────────
exports.getBalanceSheet = async (req, res) => {
  try {
    let asAt;
    if (req.query.asAt && /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.asAt).trim())) {
      asAt = new Date(`${String(req.query.asAt).trim()}T23:59:59.999Z`);
    } else {
      asAt = req.query.asAt ? new Date(req.query.asAt) : new Date();
      asAt.setUTCHours(23, 59, 59, 999);
    }

    const totalIncome = await Transaction.aggregate([
      { $match: { type: 'income', date: { $lte: asAt } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    const totalExpense = await Transaction.aggregate([
      { $match: { type: 'expense', date: { $lte: asAt } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);

    const cashBalance = (totalIncome[0]?.total || 0) - (totalExpense[0]?.total || 0);

    const debtorAgg = await Debtor.aggregate([
      { $match: { status: { $in: ['outstanding', 'partial'] } } },
      { $group: { _id: null, total: { $sum: { $subtract: ['$amountOwed', '$amountPaid'] } } } },
    ]);
    const accountsReceivable = debtorAgg[0]?.total || 0;

    const depositAgg = await Booking.aggregate([
      { $match: { status: { $in: ['pending', 'confirmed', 'checked-in'] } } },
      { $group: { _id: null, total: { $sum: '$deposit' } } },
    ]);
    const guestDeposits = depositAgg[0]?.total || 0;

    const apAgg = await Invoice.aggregate([
      { $match: { type: 'supplier', status: { $in: ['sent', 'draft'] } } },
      { $group: { _id: null, total: { $sum: '$total' } } },
    ]);
    const accountsPayable = apAgg[0]?.total || 0;

    const staticProperty = 820000;
    const staticEquipment = 68000;
    const staticVehicles = 42000;
    const staticAccDep = -48000;
    const staticMortgage = 480000;
    const staticLongTermLoans = 35000;
    const paidInCapitalAmount = 300000;
    const staticDepositsAsset = 5000;
    const staticPrepaid = 2800;
    const staticTaxPayable = 6200;

    const currentAssets = {
      cash: bsLine(cashBalance, BS_ACCOUNT.bank),
      accountsReceivable: bsLine(accountsReceivable, BS_ACCOUNT.ar),
      deposits: bsLine(staticDepositsAsset, BS_ACCOUNT.depositsHeld),
      prepaid: bsLine(staticPrepaid, BS_ACCOUNT.prepaid),
    };
    const currentAssetsTotalAmt =
      currentAssets.cash.amount +
      currentAssets.accountsReceivable.amount +
      currentAssets.deposits.amount +
      currentAssets.prepaid.amount;
    currentAssets.total = bsTotal(currentAssetsTotalAmt, 'Total current assets');

    const nonCurrentAssets = {
      property: bsLine(staticProperty, BS_ACCOUNT.ppe),
      equipment: bsLine(staticEquipment, BS_ACCOUNT.ppe),
      vehicles: bsLine(staticVehicles, BS_ACCOUNT.ppe),
      accDepreciation: bsLine(staticAccDep, BS_ACCOUNT.accDep),
    };
    const nonCurrentTotalAmt =
      nonCurrentAssets.property.amount +
      nonCurrentAssets.equipment.amount +
      nonCurrentAssets.vehicles.amount +
      nonCurrentAssets.accDepreciation.amount;
    nonCurrentAssets.total = bsTotal(nonCurrentTotalAmt, 'Total non-current assets');

    const totalAssets = currentAssetsTotalAmt + nonCurrentTotalAmt;

    const currentLiabilities = {
      accountsPayable: bsLine(accountsPayable, BS_ACCOUNT.ap),
      guestDeposits: bsLine(guestDeposits, BS_ACCOUNT.deferredRevenue),
      taxPayable: bsLine(staticTaxPayable, BS_ACCOUNT.accrued),
    };
    const currentLiabTotalAmt =
      currentLiabilities.accountsPayable.amount +
      currentLiabilities.guestDeposits.amount +
      currentLiabilities.taxPayable.amount;
    currentLiabilities.total = bsTotal(currentLiabTotalAmt, 'Total current liabilities');

    const nonCurrentLiabilities = {
      mortgage: bsLine(staticMortgage, BS_ACCOUNT.longTermDebt),
      longTermLoans: bsLine(staticLongTermLoans, BS_ACCOUNT.longTermDebt),
    };
    const nonCurrentLiabTotalAmt =
      nonCurrentLiabilities.mortgage.amount + nonCurrentLiabilities.longTermLoans.amount;
    nonCurrentLiabilities.total = bsTotal(nonCurrentLiabTotalAmt, 'Total non-current liabilities');

    const totalLiabilities = currentLiabTotalAmt + nonCurrentLiabTotalAmt;

    const retainedEarningsRaw = totalAssets - totalLiabilities - paidInCapitalAmount;
    const equity = {
      paidInCapital: bsLine(paidInCapitalAmount, BS_ACCOUNT.shareCapital),
      retainedEarnings: bsLine(Math.max(retainedEarningsRaw - cashBalance * 0.4, 0), BS_ACCOUNT.retainedEarnings),
      currentYearProfit: bsLine(cashBalance * 0.4, BS_ACCOUNT.retainedEarnings),
    };
    equity.total = bsTotal(totalAssets - totalLiabilities, 'Total equity');

    await logAudit({ userId: req.user._id, role: req.user.role, action: 'export', entity: 'BalanceSheet', req });

    res.json({
      success: true,
      data: {
        asAt: asAt.toISOString().slice(0, 10),
        assets: {
          current: currentAssets,
          nonCurrent: nonCurrentAssets,
          total: bsTotal(totalAssets, 'Total assets'),
        },
        liabilities: {
          current: currentLiabilities,
          nonCurrent: nonCurrentLiabilities,
          total: bsTotal(totalLiabilities, 'Total liabilities'),
        },
        equity,
      },
    });
  } catch (err) {
    console.error('Balance sheet error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate balance sheet' });
  }
};

// ─── CASH FLOW STATEMENT ───────────────────────────────────────────────────
exports.getCashFlow = async (req, res) => {
  try {
    const { start, end } = parseDates(req.query);

    const beforeIncome = await Transaction.aggregate([
      { $match: { type: 'income', date: { $lt: start } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    const beforeExpense = await Transaction.aggregate([
      { $match: { type: 'expense', date: { $lt: start } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    const openingCash = (beforeIncome[0]?.total || 0) - (beforeExpense[0]?.total || 0);

    const [periodIncome, periodExpense, incomeCats, expenseCats, monthlyRows, txRows, txCount] = await Promise.all([
      sumType('income', start, end),
      sumType('expense', start, end),
      Transaction.aggregate([
        { $match: { type: 'income', date: { $gte: start, $lte: end } } },
        { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
      ]),
      Transaction.aggregate([
        { $match: { type: 'expense', date: { $gte: start, $lte: end } } },
        { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
      ]),
      Transaction.aggregate([
        { $match: { date: { $gte: start, $lte: end } } },
        {
          $group: {
            _id: {
              month: { $month: '$date' },
              type: '$type',
            },
            total: { $sum: '$amount' },
            count: { $sum: 1 },
          },
        },
      ]),
      Transaction.find({ date: { $gte: start, $lte: end } })
        .sort({ date: 1, createdAt: 1 })
        .lean()
        .select('_id date amount type category description reference createdAt'),
      Transaction.countDocuments({ date: { $gte: start, $lte: end } }),
    ]);

    const cashIn = periodIncome;
    const cashOut = periodExpense;
    const netChange = cashIn - cashOut;
    const closingCash = openingCash + netChange;
    const periodLabel = req.query.year || req.query.month || `${start.toISOString().slice(0, 10)}..${end.toISOString().slice(0, 10)}`;

    const refundOutflow = expenseCats
      .filter((r) => r._id === 'refund')
      .reduce((s, r) => s + (Number(r.total) || 0), 0);
    const otherExpenseOutflow = Number((cashOut - refundOutflow).toFixed(2));

    const monthNames = [
      'january', 'february', 'march', 'april', 'may', 'june',
      'july', 'august', 'september', 'october', 'november', 'december',
    ];
    const monthlyBreakdown = {};
    monthNames.forEach((m) => {
      monthlyBreakdown[m] = {
        operating_activities: { inflows: 0, outflows: 0, net: 0 },
      };
    });
    monthlyRows.forEach((r) => {
      const idx = (r._id?.month || 1) - 1;
      const k = monthNames[idx] || 'january';
      if (r._id?.type === 'income') monthlyBreakdown[k].operating_activities.inflows += r.total || 0;
      if (r._id?.type === 'expense') monthlyBreakdown[k].operating_activities.outflows += r.total || 0;
    });
    Object.keys(monthlyBreakdown).forEach((k) => {
      const row = monthlyBreakdown[k].operating_activities;
      row.net = Number((row.inflows - row.outflows).toFixed(2));
      row.inflows = Number((row.inflows || 0).toFixed(2));
      row.outflows = Number((row.outflows || 0).toFixed(2));
    });

    const txList = txRows.map((t) => ({
      transactionId: String(t._id),
      date: t.date,
      amount: Number(t.amount) || 0,
      type: t.type,
      category: t.category || 'uncategorized',
      description: t.description || '',
      reference: t.reference || null,
    }));
    const monthNets = Object.entries(monthlyBreakdown).map(([month, v]) => ({ month, net: v.operating_activities.net }));
    const bestCashFlowMonth = monthNets.sort((a, b) => b.net - a.net)[0]?.month || null;
    const worstCashFlowMonth = monthNets.sort((a, b) => a.net - b.net)[0]?.month || null;

    const cashBalanceByAccount = {
      '1002': {
        accountCode: '1002',
        accountName: 'Bank Account',
        balance: Number(closingCash.toFixed(2)),
      },
    };

    const mapIncomeRow = (r) => ({
      category: r._id || 'uncategorized',
      total: Number(Number(r.total).toFixed(2)),
      transaction_count: r.count || 0,
    });
    const mapExpenseRow = (r) => ({
      category: r._id || 'uncategorized',
      total: Number(Number(r.total).toFixed(2)),
      transaction_count: r.count || 0,
    });

    const cashInflowBlock = {
      total: Number(cashIn.toFixed(2)),
      basis: 'Sum of all Transaction documents with type=income in the period.',
      categories: incomeCats.map(mapIncomeRow),
    };

    const cashOutflowBlock = {
      total: Number(cashOut.toFixed(2)),
      basis: 'Sum of all Transaction documents with type=expense in the period.',
      categories: expenseCats.map(mapExpenseRow),
      subtotals: {
        refunds_to_customers: Number(refundOutflow.toFixed(2)),
        other_operating_cash_payments: otherExpenseOutflow,
        paid_to_suppliers: 0,
      },
    };

    await logAudit({ userId: req.user._id, role: req.user.role, action: 'export', entity: 'CashFlow', req });

    res.json({
      success: true,
      data: {
        period: String(periodLabel),
        basis: 'cash',
        method: 'direct',
        cash_breakdown: {
          beginning_cash: Number(openingCash.toFixed(2)),
          ending_cash: Number(closingCash.toFixed(2)),
          net_change_in_cash: Number(netChange.toFixed(2)),
        },
        cash_inflow: cashInflowBlock,
        cash_outflow: cashOutflowBlock,
        cash_balance_by_account: cashBalanceByAccount,
        operating_activities: {
          description:
            'Net operating cash = data.cash_inflow.total − data.cash_outflow.total (all Transaction rows, cash basis).',
          net_cash_from_operating_activities: Number(netChange.toFixed(2)),
        },
        investing_activities: {
          purchase_of_equipment: 0,
          purchase_of_buildings: 0,
          loans_given: 0,
        },
        financing_activities: {
          owners_contribution: 0,
          loan_proceeds: 0,
        },
        detailed_breakdown: {
          transactions: txList,
        },
        monthly_breakdown: monthlyBreakdown,
        yearly_totals: {
          operating_activities: {
            cash_inflow_total: Number(cashIn.toFixed(2)),
            cash_outflow_total: Number(cashOut.toFixed(2)),
            net: Number(netChange.toFixed(2)),
          },
        },
        summary: {
          best_cash_flow_month: bestCashFlowMonth,
          worst_cash_flow_month: worstCashFlowMonth,
        },
        formatted_cash_flow_statement: {
          period: String(periodLabel),
          cash_flow_statement: {
            cash_and_cash_equivalents_beginning: { total_cash: Number(openingCash.toFixed(2)) },
            net_change_in_cash: Number(netChange.toFixed(2)),
            cash_and_cash_equivalents_ending: { total_cash: Number(closingCash.toFixed(2)) },
          },
        },
        tabular_cash_flow_statement: {
          period: String(periodLabel),
          cash_flow_statement_monthly: {
            net_change_in_cash: { label: 'NET CHANGE IN CASH', value: Number(netChange.toFixed(2)) },
          },
        },
        cash_accounts: {
          total: Number(closingCash.toFixed(2)),
          breakdown: cashBalanceByAccount,
          closing_balance: Number(closingCash.toFixed(2)),
        },
        metadata: {
          generated_at: new Date().toISOString(),
          residence_filter: null,
          transaction_count: txCount || 0,
          opening_cash: Number(openingCash.toFixed(2)),
          closing_cash: Number(closingCash.toFixed(2)),
          net_change_in_cash: Number(netChange.toFixed(2)),
        },
        transaction_details: { transaction_count: txCount || 0 },
      },
      cached: true,
      message: `Cached cash flow data for ${periodLabel} (cash basis) (all residences)`,
    });
  } catch (err) {
    console.error('Cash flow error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate cash flow statement' });
  }
};

// ─── PROFIT & LOSS ─────────────────────────────────────────────────────────
exports.getPL = async (req, res) => {
  try {
    const { start, end } = parseDates(req.query);

    const monthly = await Transaction.aggregate([
      { $match: { date: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: {
            year: { $year: '$date' },
            month: { $month: '$date' },
            type: '$type',
          },
          total: { $sum: '$amount' },
        },
      },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]);

    const monthMap = {};
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    monthly.forEach(({ _id, total }) => {
      const key = `${_id.year}-${String(_id.month).padStart(2, '0')}`;
      if (!monthMap[key]) monthMap[key] = { month: monthNames[_id.month - 1], revenue: 0, costs: 0, profit: 0 };
      if (_id.type === 'income') monthMap[key].revenue += total;
      if (_id.type === 'expense') monthMap[key].costs += total;
    });
    Object.values(monthMap).forEach((m) => { m.profit = m.revenue - m.costs; });

    const revenueByCategory = await Transaction.aggregate([
      { $match: { type: 'income', date: { $gte: start, $lte: end } } },
      { $group: { _id: '$category', revenue: { $sum: '$amount' } } },
    ]);

    const costsByCategory = await Transaction.aggregate([
      { $match: { type: 'expense', date: { $gte: start, $lte: end } } },
      { $group: { _id: '$category', costs: { $sum: '$amount' } } },
    ]);

    const costsMap = costsByCategory.reduce((a, r) => {
      if (r._id != null) a[r._id] = r.costs;
      return a;
    }, {});

    const refundContra = costsMap.refund || 0;
    const totalRevenueGross = revenueByCategory.reduce((a, r) => a + r.revenue, 0);
    const totalRevenue = totalRevenueGross - refundContra;
    const totalCosts = Object.entries(costsMap)
      .filter(([cat]) => cat !== 'refund')
      .reduce((a, [, v]) => a + v, 0);

    const incomeCatIds = new Set(revenueByCategory.map((r) => r._id).filter((id) => id != null));
    const byCategoryFromRevenue = revenueByCategory.map((r) => {
      const costs = costsMap[r._id] || 0;
      const profit = r.revenue - costs;
      return {
        category: r._id,
        revenue: r.revenue,
        costs,
        profit,
        margin: r.revenue ? +((profit / r.revenue) * 100).toFixed(1) : 0,
      };
    });
    const refundRow =
      refundContra > 0
        ? [
            {
              category: 'refund',
              revenue: -refundContra,
              costs: 0,
              profit: -refundContra,
              margin: totalRevenueGross ? +((-refundContra / totalRevenueGross) * 100).toFixed(1) : 0,
              note: 'contra-revenue (cash refunds to customers)',
            },
          ]
        : [];
    // Expense-only categories (e.g. supplies, utilities) — exclude refund (shown under revenue)
    const expenseOnlyRows = costsByCategory
      .filter((c) => c._id != null && c._id !== 'refund' && !incomeCatIds.has(c._id))
      .map((c) => ({
        category: c._id,
        revenue: 0,
        costs: c.costs,
        profit: -c.costs,
        margin: 0,
      }));
    const byCategory = [...byCategoryFromRevenue, ...refundRow, ...expenseOnlyRows];

    const grossProfit = totalRevenue - totalCosts;

    const opexCategories = ['marketing', 'software', 'insurance', 'admin'];
    const totalOpex = opexCategories.reduce((a, cat) => a + (costsMap[cat] || 0), 0);
    const netProfit = grossProfit - totalOpex;

    await logAudit({ userId: req.user._id, role: req.user.role, action: 'export', entity: 'PL', req });

    res.json({
      success: true,
      data: {
        summary: {
          grossRevenue: totalRevenueGross,
          refunds: refundContra,
          totalRevenue,
          totalCosts,
          grossProfit,
          grossMargin: totalRevenue ? +((grossProfit / totalRevenue) * 100).toFixed(1) : 0,
          totalOpex,
          netProfit,
          netMargin: totalRevenue ? +((netProfit / totalRevenue) * 100).toFixed(1) : 0,
        },
        byCategory,
        monthly: Object.values(monthMap),
      },
    });
  } catch (err) {
    console.error('P&L error:', err);
    res.status(500).json({ success: false, message: 'Failed to generate P&L statement' });
  }
};
