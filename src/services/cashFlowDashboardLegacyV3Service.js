/**
 * Dashboard-style cash flow JSON (legacy shape) backed by posted v3 journals on 1001.
 * Keeps field names / nesting aligned with the historical Valley Croft cash-flow API for UI parity.
 */

const FinancialJournalEntry = require('../models/FinancialJournalEntry');
const { CHART_OF_ACCOUNTS_V3 } = require('../constants/chartOfAccountsV3');
const { round2 } = require('../utils/math');
const { getBalanceSheetV3 } = require('./financialStatementsV3Service');

const JOURNAL_HAS_ENTRIES = { 'entries.0': { $exists: true } };

const MONTH_KEYS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

const INCOME_BUCKET_KEYS = [
  'rental_income',
  'admin_fees',
  'deposits',
  'utilities',
  'advance_payments',
  'other_income',
];

const EXPENSE_TEMPLATE_ZERO_KEYS = [
  'electricity',
  'water',
  'gas',
  'internet',
  'maintenance',
  'cleaning',
  'security',
  'management',
  'insurance',
  'council_rates',
  'plumbing',
  'sanitary',
  'solar',
  'other_expenses',
  'utilities',
];

const BNB_CASH_TYPES = new Set([
  'booking_payment',
  'booking_deposit_received',
  'booking_balance_received',
]);

const INVESTING_TYPES = new Set(['equipment_purchase']);
const FINANCING_TYPES = new Set(['owner_investment', 'owner_drawing']);

const CASH_ACCOUNT_CODES = ['1001', '1002'];

function accountFromChart(code) {
  const n = Number(String(code).trim());
  if (!Number.isFinite(n)) return null;
  const row = CHART_OF_ACCOUNTS_V3[n];
  if (!row) return null;
  return { code: String(n), name: row.name };
}

function parseDateEndOfDay(d) {
  const end = new Date(d);
  end.setUTCHours(23, 59, 59, 999);
  return end;
}

function ymFromDate(d) {
  const x = new Date(d);
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthKeyFromYm(ym) {
  const m = Number(ym.slice(5, 7));
  return MONTH_KEYS[m - 1];
}

function eachMonthInRange(start, end) {
  const out = [];
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cur <= last) {
    const ym = `${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, '0')}`;
    out.push({ ym, key: MONTH_KEYS[cur.getUTCMonth()] });
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return out;
}

function endOfUtcMonth(ym) {
  const [y, m] = ym.split('-').map((x) => parseInt(x, 10));
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1, lastDay, 23, 59, 59, 999));
}

function dayBeforeUtc(d) {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() - 1);
  x.setUTCHours(23, 59, 59, 999);
  return x;
}

function periodLabel(start, end) {
  if (
    start.getUTCFullYear() === end.getUTCFullYear() &&
    start.getUTCMonth() === 0 &&
    start.getUTCDate() === 1 &&
    end.getUTCMonth() === 11 &&
    end.getUTCDate() >= 28
  ) {
    return String(start.getUTCFullYear());
  }
  return `${start.toISOString().slice(0, 10)}..${end.toISOString().slice(0, 10)}`;
}

function pickCashLine1001(entries) {
  return (entries || []).find((e) => String(e.accountCode) === '1001') || null;
}

function pickCounterpartEntry(entries, cashInflow) {
  const others = (entries || []).filter((e) => String(e.accountCode) !== '1001');
  if (!others.length) return null;
  if (cashInflow) {
    const pool = others.filter((e) => (Number(e.credit) || 0) > 0);
    const use = pool.length ? pool : others;
    return use.reduce((best, e) => {
      const amt = Number(e.credit) || 0;
      const bestAmt = best ? Number(best.credit) || 0 : 0;
      return amt > bestAmt ? e : best;
    }, null);
  }
  const pool = others.filter((e) => (Number(e.debit) || 0) > 0);
  const use = pool.length ? pool : others;
  return use.reduce((best, e) => {
    const amt = Number(e.debit) || 0;
    const bestAmt = best ? Number(best.debit) || 0 : 0;
    return amt > bestAmt ? e : best;
  }, null);
}

function activityBucket(transactionType) {
  const tt = String(transactionType || '');
  if (INVESTING_TYPES.has(tt)) return 'investing';
  if (FINANCING_TYPES.has(tt)) return 'financing';
  return 'operating';
}

function classifyOperatingCashIn(tt) {
  if (tt === 'booking_deposit_received') return 'deposits';
  if (tt === 'booking_balance_received') return 'advance_payments';
  if (BNB_CASH_TYPES.has(tt)) return 'rental_income';
  if (tt === 'event_payment' || tt === 'event_deposit_received') return 'other_income';
  return 'other_income';
}

function humanSource(tt) {
  const s = String(tt || '').replace(/_/g, ' ');
  return s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}` : 'Journal';
}

function emptyIncomeBuckets() {
  /** @type {Record<string, number>} */
  const o = {};
  for (const k of INCOME_BUCKET_KEYS) o[k] = 0;
  return o;
}

function cashBalancesFromBs(bs) {
  const breakdown = {};
  let total = 0;
  for (const code of CASH_ACCOUNT_CODES) {
    const row = bs.assets?.find((a) => String(a.accountCode) === code);
    const bal = round2(row?.balance ?? 0);
    breakdown[code] = {
      accountCode: code,
      accountName: row?.accountName || accountFromChart(code)?.name || code,
      balance: bal,
    };
    total += bal;
  }
  return { total: round2(total), breakdown };
}

function buildCashAndBank(breakdownObj) {
  const b = breakdownObj || {};
  const get = (code) => b[code]?.balance ?? 0;
  const name = (code) => b[code]?.accountName || accountFromChart(code)?.name || '';
  const total = round2(CASH_ACCOUNT_CODES.reduce((s, c) => s + get(c), 0));
  return {
    cash: { amount: 0, accountCode: '1000', accountName: 'Cash' },
    bank: { amount: get('1001'), accountCode: '1001', accountName: name('1001') || 'Cash / Bank' },
    ecocash: { amount: 0, accountCode: '1002', accountName: 'Ecocash' },
    innbucks: { amount: 0, accountCode: '1003', accountName: 'Innbucks' },
    pettyCash: { amount: 0, accountCode: '1004', accountName: 'Petty Cash' },
    cashOnHand: { amount: 0, accountCode: '1005', accountName: 'Cash on Hand' },
    generalPettyCash: { amount: 0, accountCode: '1010', accountName: 'General Petty Cash' },
    adminPettyCash: { amount: get('1002'), accountCode: '1002', accountName: name('1002') || 'Petty Cash' },
    financePettyCash: { amount: 0, accountCode: '1012', accountName: 'Finance Petty Cash' },
    propertyManagerPettyCash: { amount: 0, accountCode: '1013', accountName: 'Property Manager Petty Cash' },
    maintenancePettyCash: { amount: 0, accountCode: '1014', accountName: 'Maintenance Petty Cash' },
    cbzVault: { amount: 0, accountCode: '10003', accountName: 'Cbz Vault' },
    total,
  };
}

function buildExpenseBreakdownFromLines(lines) {
  /** @type {Record<string, { count: number, total_amount: number, expenses: any[] }>} */
  const map = {};
  for (const L of lines) {
    const label = L.accountName || String(L.accountCode);
    if (!map[label]) map[label] = { count: 0, total_amount: 0, expenses: [] };
    map[label].count += 1;
    map[label].total_amount += L.amount;
    map[label].expenses.push(L.row);
  }
  for (const k of Object.keys(map)) {
    map[k].total_amount = round2(map[k].total_amount);
  }
  return map;
}

function buildIncomeBreakdownFromBuckets(buckets, incomeTxByBucket) {
  const out = {};
  for (const k of INCOME_BUCKET_KEYS) {
    out[k] = {
      total: round2(buckets[k] || 0),
      transactions: incomeTxByBucket[k] || [],
    };
  }
  return out;
}

/**
 * @param {Date} start
 * @param {Date} end
 */
async function buildLegacyCashFlowDashboardResponse(start, end) {
  const startUtc = new Date(start);
  startUtc.setUTCHours(0, 0, 0, 0);
  const endUtc = parseDateEndOfDay(end);

  const journals = await FinancialJournalEntry.find({
    date: { $gte: startUtc, $lte: endUtc },
    isVoided: false,
    ...JOURNAL_HAS_ENTRIES,
    'entries.accountCode': '1001',
  })
    .sort({ date: 1 })
    .lean();

  const months = eachMonthInRange(startUtc, endUtc);
  const monthSet = new Set(months.map((m) => m.key));

  /** @type {Record<string, any>} */
  const monthly_breakdown = {};
  /** @type {Record<string, any>} */
  const tabular_monthly_breakdown = {};

  for (const mk of MONTH_KEYS) {
    if (!monthSet.has(mk)) continue;
    monthly_breakdown[mk] = {
      operating_activities: {
        inflows: 0,
        outflows: 0,
        net: 0,
        breakdown: {},
      },
      income: {
        total: 0,
        rental_income: 0,
        admin_fees: 0,
        deposits: 0,
        utilities: 0,
        advance_payments: 0,
        other_income: 0,
      },
      expenses: {
        total: 0,
        transactions: [],
        ...Object.fromEntries(EXPENSE_TEMPLATE_ZERO_KEYS.map((k) => [k, 0])),
      },
      investing_activities: { inflows: 0, outflows: 0, net: 0, breakdown: {} },
      financing_activities: { inflows: 0, outflows: 0, net: 0, breakdown: {} },
      net_cash_flow: 0,
      opening_balance: 0,
      closing_balance: 0,
      transaction_details: { transaction_count: 0 },
      cash_accounts: { total: 0, breakdown: {} },
      cashAndBank: buildCashAndBank({}),
    };
    tabular_monthly_breakdown[mk] = {
      net_change_in_cash: 0,
      cash_at_end_of_period: 0,
      cash_and_cash_equivalents: {},
    };
  }

  /** @type {Record<string, Record<string, number>>} */
  const expenseCodesByMonth = {};
  /** @type {Record<string, any[]>} */
  const incomeTxByMonthBucket = {};
  /** @type {Record<string, any[]>} */
  const expenseLinesForBreakdown = {};

  const allIncomeTx = [];
  const allPaymentRows = [];
  const allExpenseRows = [];
  const allExpenseDetailRows = [];

  for (const je of journals) {
    const cashLine = pickCashLine1001(je.entries);
    if (!cashLine) continue;
    const debit = Number(cashLine.debit) || 0;
    const credit = Number(cashLine.credit) || 0;
    if (debit <= 0 && credit <= 0) continue;
    const cashIn = debit > 0;
    const amount = round2(debit > 0 ? debit : credit);
    const counterpart = pickCounterpartEntry(je.entries, cashIn);
    const tt = String(je.transactionType || 'unknown');
    const bucket = activityBucket(tt);
    const ym = ymFromDate(je.date);
    const mKey = monthKeyFromYm(ym);
    if (!monthly_breakdown[mKey]) continue;

    const pubId = je.publicTransactionId ? String(je.publicTransactionId) : `JE_${String(je._id)}`;
    const cpCode = counterpart ? String(counterpart.accountCode) : '';
    const cpName = counterpart
      ? counterpart.accountName || accountFromChart(cpCode)?.name || ''
      : '';

    monthly_breakdown[mKey].transaction_details.transaction_count += 1;

    if (bucket === 'operating') {
      if (cashIn) {
        const incKey = classifyOperatingCashIn(tt);
        const inc = monthly_breakdown[mKey].income;
        inc[incKey] += amount;
        inc.total += amount;
        monthly_breakdown[mKey].operating_activities.inflows += amount;

        const txRow = {
          transactionId: pubId,
          date: je.date,
          amount,
          accountCode: '1001',
          accountName: accountFromChart('1001')?.name || 'Cash / Bank',
          residence: 'Unknown',
          description: je.description || humanSource(tt),
          source: humanSource(tt),
          isAdvancePayment: tt === 'booking_balance_received',
        };
        if (!incomeTxByMonthBucket[mKey]) incomeTxByMonthBucket[mKey] = {};
        if (!incomeTxByMonthBucket[mKey][incKey]) incomeTxByMonthBucket[mKey][incKey] = [];
        incomeTxByMonthBucket[mKey][incKey].push(txRow);
        allIncomeTx.push({ ...txRow, _bucket: incKey });
        allPaymentRows.push(txRow);
      } else {
        monthly_breakdown[mKey].operating_activities.outflows += amount;
        monthly_breakdown[mKey].expenses.total += amount;
        if (counterpart && counterpart.accountType === 'expense') {
          const code = cpCode;
          if (!expenseCodesByMonth[mKey]) expenseCodesByMonth[mKey] = {};
          expenseCodesByMonth[mKey][code] = round2((expenseCodesByMonth[mKey][code] || 0) + amount);
          monthly_breakdown[mKey].expenses[code] = round2(
            (Number(monthly_breakdown[mKey].expenses[code]) || 0) + amount,
          );
        }
        const expRow = {
          transactionId: pubId,
          date: je.date,
          amount,
          description: je.description || humanSource(tt),
          accountCode: cpCode || '',
          accountName: cpName,
          category: 'expense',
        };
        monthly_breakdown[mKey].expenses.transactions.push(expRow);
        const detailRow = {
          id: `${pubId}-1`,
          expense_id: null,
          date: je.date,
          amount,
          description: expRow.description,
          type: cpName || cpCode || 'Expense',
          residence: 'Unknown',
          account_code: cpCode,
          account_name: cpName,
          transaction_details: { transaction_id: pubId, entry_index: 1 },
        };
        const line = { amount, accountCode: cpCode, accountName: cpName, row: detailRow };
        if (!expenseLinesForBreakdown[mKey]) expenseLinesForBreakdown[mKey] = [];
        expenseLinesForBreakdown[mKey].push(line);
        allExpenseRows.push(expRow);
        allExpenseDetailRows.push(detailRow);
      }
    } else if (bucket === 'investing') {
      if (cashIn) monthly_breakdown[mKey].investing_activities.inflows += amount;
      else monthly_breakdown[mKey].investing_activities.outflows += amount;
    } else if (bucket === 'financing') {
      if (cashIn) monthly_breakdown[mKey].financing_activities.inflows += amount;
      else monthly_breakdown[mKey].financing_activities.outflows += amount;
    }
  }

  for (const mKey of Object.keys(monthly_breakdown)) {
    const mb = monthly_breakdown[mKey];
    mb.operating_activities.net = round2(mb.operating_activities.inflows - mb.operating_activities.outflows);
    mb.investing_activities.net = round2(
      mb.investing_activities.inflows - mb.investing_activities.outflows,
    );
    mb.financing_activities.net = round2(mb.financing_activities.inflows - mb.financing_activities.outflows);
    mb.net_cash_flow = round2(mb.operating_activities.net + mb.investing_activities.net + mb.financing_activities.net);

    for (const k of INCOME_BUCKET_KEYS) {
      mb.income[k] = round2(mb.income[k] || 0);
    }
    mb.income.total = round2(mb.income.total);

    mb.operating_activities.inflows = round2(mb.operating_activities.inflows);
    mb.operating_activities.outflows = round2(mb.operating_activities.outflows);
    mb.operating_activities.net = round2(mb.operating_activities.net);
    mb.investing_activities.inflows = round2(mb.investing_activities.inflows);
    mb.investing_activities.outflows = round2(mb.investing_activities.outflows);
    mb.financing_activities.inflows = round2(mb.financing_activities.inflows);
    mb.financing_activities.outflows = round2(mb.financing_activities.outflows);

    const bd = { ...emptyIncomeBuckets() };
    for (const k of INCOME_BUCKET_KEYS) bd[k] = mb.income[k];
    for (const [code, amt] of Object.entries(expenseCodesByMonth[mKey] || {})) {
      bd[String(code)] = amt;
    }
    for (const z of EXPENSE_TEMPLATE_ZERO_KEYS) {
      if (bd[z] === undefined) bd[z] = 0;
    }
    mb.operating_activities.breakdown = bd;

    mb.expenses.total = round2(mb.expenses.total);
  }

  const bsByMonthEnd = {};
  for (const { ym, key } of months) {
    bsByMonthEnd[key] = await getBalanceSheetV3(endOfUtcMonth(ym));
  }

  const openingBs = await getBalanceSheetV3(dayBeforeUtc(startUtc));
  const closingBs = await getBalanceSheetV3(endUtc);

  for (let i = 0; i < months.length; i += 1) {
    const { key } = months[i];
    const bs = bsByMonthEnd[key];
    const ca = cashBalancesFromBs(bs);
    monthly_breakdown[key].cash_accounts = ca;
    monthly_breakdown[key].cashAndBank = buildCashAndBank(ca.breakdown);
    monthly_breakdown[key].closing_balance = ca.total;
    if (i > 0) {
      monthly_breakdown[key].opening_balance = monthly_breakdown[months[i - 1].key].closing_balance;
    } else {
      monthly_breakdown[key].opening_balance = cashBalancesFromBs(openingBs).total;
    }
    tabular_monthly_breakdown[key].net_change_in_cash = monthly_breakdown[key].net_cash_flow;
    tabular_monthly_breakdown[key].cash_at_end_of_period = monthly_breakdown[key].closing_balance;
    const equiv = {};
    for (const [code, row] of Object.entries(ca.breakdown)) {
      equiv[row.accountName || code] = {
        account_code: code,
        balance: row.balance,
        description: `${row.accountName || 'Cash'} account`,
      };
    }
    tabular_monthly_breakdown[key].cash_and_cash_equivalents = equiv;
  }

  let yOpIn = 0;
  let yOpOut = 0;
  let yInvIn = 0;
  let yInvOut = 0;
  let yFinIn = 0;
  let yFinOut = 0;
  const yIncome = emptyIncomeBuckets();
  for (const { key } of months) {
    const mb = monthly_breakdown[key];
    yOpIn += mb.operating_activities.inflows;
    yOpOut += mb.operating_activities.outflows;
    yInvIn += mb.investing_activities.inflows;
    yInvOut += mb.investing_activities.outflows;
    yFinIn += mb.financing_activities.inflows;
    yFinOut += mb.financing_activities.outflows;
    for (const k of INCOME_BUCKET_KEYS) yIncome[k] += mb.income[k];
  }
  const yearlyTotalsIncome = {};
  for (const k of INCOME_BUCKET_KEYS) yearlyTotalsIncome[k] = round2(yIncome[k]);
  yearlyTotalsIncome.total = round2(INCOME_BUCKET_KEYS.reduce((s, k) => s + yIncome[k], 0));

  const netYearly = months.reduce((s, { key }) => s + monthly_breakdown[key].net_cash_flow, 0);

  const openingCash = cashBalancesFromBs(openingBs).total;
  const endingCash = cashBalancesFromBs(closingBs).total;

  const cash_balance_by_account = {};
  for (const code of CASH_ACCOUNT_CODES) {
    const row = closingBs.assets?.find((a) => String(a.accountCode) === code);
    if (row) {
      cash_balance_by_account[code] = {
        accountCode: code,
        accountName: row.accountName,
        balance: round2(row.balance),
      };
    }
  }

  const monthlyNets = months.map(({ key }) => ({ key, net: monthly_breakdown[key].net_cash_flow }));
  const best = monthlyNets.reduce((a, b) => (b.net > a.net ? b : a), monthlyNets[0] || { key: 'january', net: 0 });
  const worst = monthlyNets.reduce((a, b) => (b.net < a.net ? b : a), monthlyNets[0] || { key: 'january', net: 0 });

  const totalCashInAll = journals.reduce((s, je) => {
    const cl = pickCashLine1001(je.entries);
    if (!cl) return s;
    const debit = Number(cl.debit) || 0;
    return debit > 0 ? s + round2(debit) : s;
  }, 0);
  const totalCashOutAll = journals.reduce((s, je) => {
    const cl = pickCashLine1001(je.entries);
    if (!cl) return s;
    const credit = Number(cl.credit) || 0;
    return credit > 0 ? s + round2(credit) : s;
  }, 0);

  const expenseBreakdownYear = buildExpenseBreakdownFromLines(
    months.flatMap(({ key }) => expenseLinesForBreakdown[key] || []),
  );

  const incomeBreakdownYear = buildIncomeBreakdownFromBuckets(
    yearlyTotalsIncome,
    INCOME_BUCKET_KEYS.reduce((acc, k) => {
      acc[k] = allIncomeTx.filter((t) => t._bucket === k).map((t) => {
      const { _bucket, ...rest } = t;
      return rest;
    });
      return acc;
    }, {}),
  );

  const individual_expenses = allExpenseDetailRows;

  let equipmentCashOut = 0;
  let ownerContributionIn = 0;
  for (const je of journals) {
    const tt = String(je.transactionType || '');
    const cl = pickCashLine1001(je.entries);
    if (!cl) continue;
    const credit = Number(cl.credit) || 0;
    const debit = Number(cl.debit) || 0;
    if (tt === 'equipment_purchase' && credit > 0) equipmentCashOut += round2(credit);
    if (tt === 'owner_investment' && debit > 0) ownerContributionIn += round2(debit);
  }

  const investingYear = {
    purchase_of_equipment: round2(equipmentCashOut),
    purchase_of_buildings: 0,
    loans_given: 0,
  };

  const financingYear = {
    owners_contribution: round2(ownerContributionIn),
    loan_proceeds: 0,
  };

  const cfsMonthsNet = {};
  const cfsMonthsEnd = {};
  const cfsMonthsEquiv = {};
  for (const { key } of months) {
    cfsMonthsNet[key] = monthly_breakdown[key].net_cash_flow;
    cfsMonthsEnd[key] = monthly_breakdown[key].closing_balance;
    cfsMonthsEquiv[key] = tabular_monthly_breakdown[key].cash_and_cash_equivalents;
  }

  const data = {
    period: periodLabel(startUtc, endUtc),
    basis: 'cash',
    monthly_breakdown,
    tabular_monthly_breakdown,
    yearly_totals: {
      operating_activities: {
        inflows: round2(yOpIn),
        outflows: round2(yOpOut),
        net: round2(yOpIn - yOpOut),
        breakdown: {},
      },
      investing_activities: {
        inflows: round2(yInvIn),
        outflows: round2(yInvOut),
        net: round2(yInvIn - yInvOut),
        breakdown: {},
      },
      financing_activities: {
        inflows: round2(yFinIn),
        outflows: round2(yFinOut),
        net: round2(yFinIn - yFinOut),
        breakdown: {},
      },
      net_cash_flow: round2(netYearly),
      income: yearlyTotalsIncome,
    },
    cash_breakdown: {
      beginning_cash: round2(openingCash),
      ending_cash: round2(endingCash),
      net_change_in_cash: round2(endingCash - openingCash),
    },
    summary: {
      best_cash_flow_month: best.key,
      worst_cash_flow_month: worst.key,
      average_monthly_cash_flow: months.length ? round2(netYearly / months.length) : 0,
      total_months_with_data: months.length,
      monthly_consistency_score: 0,
      total_transactions: journals.length,
      net_change_in_cash: round2(endingCash - openingCash),
      total_income: round2(totalCashInAll),
      total_expenses: round2(totalCashOutAll),
      transaction_count: journals.length,
      payment_count: allPaymentRows.length,
      expense_count: allExpenseDetailRows.length,
    },
    formatted_cash_flow_statement: {
      period: periodLabel(startUtc, endUtc),
      cash_flow_statement: {
        cash_and_cash_equivalents_beginning: round2(openingCash),
        operating_activities: {
          cash_inflows: {
            rental_income: yearlyTotalsIncome.rental_income,
            advance_payments: yearlyTotalsIncome.advance_payments,
            other_income: round2(
              yearlyTotalsIncome.other_income +
                yearlyTotalsIncome.deposits +
                yearlyTotalsIncome.admin_fees +
                yearlyTotalsIncome.utilities,
            ),
            total_cash_inflows: yearlyTotalsIncome.total,
          },
          cash_outflows: {
            supplier_payments: 0,
            operating_expenses: round2(yOpOut),
            other_payments: 0,
            total_cash_outflows: round2(yOpOut),
          },
          net_cash_from_operating_activities: round2(yOpIn - yOpOut),
        },
        investing_activities: {
          equipment_and_assets: investingYear.purchase_of_equipment,
          net_cash_from_investing_activities: round2(yInvIn - yInvOut),
        },
        financing_activities: {
          owner_contributions: financingYear.owners_contribution,
          net_cash_from_financing_activities: round2(yFinIn - yFinOut),
        },
        net_change_in_cash: round2(netYearly),
        cash_and_cash_equivalents_ending: round2(endingCash),
        internal_cash_transfers: { total: 0, transfers: [] },
      },
      detailed_cash_breakdown: {
        cash_inflows: {
          from_customers: yearlyTotalsIncome.rental_income,
          from_advance_payments: yearlyTotalsIncome.advance_payments,
          from_other_sources: round2(yearlyTotalsIncome.total - yearlyTotalsIncome.rental_income - yearlyTotalsIncome.advance_payments),
          total_cash_inflows: yearlyTotalsIncome.total,
        },
        cash_outflows: {
          to_suppliers: 0,
          for_expenses: round2(yOpOut),
          for_other_purposes: round2(yInvOut + yFinOut),
          total_cash_outflows: round2(yOpOut + yInvOut + yFinOut),
        },
        internal_cash_transfers: { total: 0, transfers: [] },
        advance_payments_impact: { total: yearlyTotalsIncome.advance_payments, impact: [] },
      },
    },
    tabular_cash_flow_statement: {
      period: periodLabel(startUtc, endUtc),
      cash_flow_statement_monthly: {
        net_change_in_cash: { label: 'Net change in cash', months: cfsMonthsNet },
        cash_at_end_of_period: { label: 'Cash at end of period', months: cfsMonthsEnd },
        cash_and_cash_equivalents: { label: 'Cash and cash equivalents (detail)', months: cfsMonthsEquiv },
      },
    },
    detailed_breakdown: {
      income: {
        total: yearlyTotalsIncome.total,
        by_source: {
          rental_income: yearlyTotalsIncome.rental_income,
          admin_fees: yearlyTotalsIncome.admin_fees,
          deposits: yearlyTotalsIncome.deposits,
          utilities: yearlyTotalsIncome.utilities,
          advance_payments: yearlyTotalsIncome.advance_payments,
          other_income: yearlyTotalsIncome.other_income,
        },
        by_residence: {},
        by_month: Object.fromEntries(months.map(({ key }) => [key, monthly_breakdown[key].income.total])),
        payment_details: allPaymentRows,
        advance_payments: allIncomeTx.filter((t) => t._bucket === 'advance_payments').map(({ _bucket, ...r }) => r),
      },
      expenses: {
        total_count: allExpenseDetailRows.length,
        total_amount: round2(yOpOut),
        expenses: allExpenseDetailRows,
        by_month: Object.fromEntries(months.map(({ key }) => [key, monthly_breakdown[key].expenses.total])),
        by_residence: {},
        by_type: expenseBreakdownYear,
      },
      transactions: journals.map((je) => ({
        transactionId: je.publicTransactionId ? String(je.publicTransactionId) : `JE_${String(je._id)}`,
        date: je.date,
        transactionType: je.transactionType,
        description: je.description || '',
      })),
      payments: allPaymentRows,
      expenses_detail: allExpenseDetailRows,
      monthly_breakdown: Object.fromEntries(
        months.map(({ key }) => [
          key,
          {
            income: monthly_breakdown[key].income,
            expenses: { total: monthly_breakdown[key].expenses.total },
            transaction_details: monthly_breakdown[key].transaction_details,
          },
        ]),
      ),
    },
    operating_activities: {
      cash_received_from_customers: round2(yOpIn),
      cash_paid_to_suppliers: 0,
      cash_paid_for_expenses: round2(yOpOut),
      income_breakdown: incomeBreakdownYear,
      expense_breakdown: expenseBreakdownYear,
      individual_expenses: individual_expenses,
    },
    investing_activities: investingYear,
    financing_activities: financingYear,
    cash_balance_by_account,
    metadata: {
      generated_at: new Date().toISOString(),
      residence_filter: 'all',
      data_sources: ['financial_journal_entries', 'account_1001_cash_bank'],
      basis_type: 'double_entry_v3',
      structure_type: 'legacy_dashboard',
    },
  };

  return data;
}

module.exports = { buildLegacyCashFlowDashboardResponse };
