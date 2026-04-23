const FinancialJournalEntry = require('../models/FinancialJournalEntry');
const Account = require('../models/Account');
const { CHART_OF_ACCOUNTS_V3 } = require('../constants/chartOfAccountsV3');
const { round2 } = require('../utils/math');

/** Posted v3 journals with embedded `entries` (Dr/Cr lines). Statements unwind this array. */
const JOURNAL_HAS_ENTRIES = { 'entries.0': { $exists: true } };

/** IAS 1 / IAS 7–style names for API consumers (not legal filing text). */
const STATEMENT_TITLES = {
  profitOrLoss: 'Statement of profit or loss',
  financialPosition: 'Statement of financial position',
  cashFlows: 'Statement of cash flows',
};

function accountsReceivable1010FromBalanceSheet(bs) {
  const row = bs.assets?.find((a) => String(a.accountCode) === '1010');
  return round2(row?.balance ?? 0);
}

function accountingDisclosureIncomeStatement(period) {
  return {
    statementName: STATEMENT_TITLES.profitOrLoss,
    alternativeNames: ['Income statement', 'Statement of comprehensive income (P&L section)'],
    recognitionBasis: 'Accrual',
    description:
      'Revenue and expenses for the period from posted v3 journals (`financial_journal_entries.entries`, non-voided). Amounts are recognised when earned or incurred, not necessarily when cash moves.',
    period,
  };
}

function accountingDisclosureBalanceSheet(asAt) {
  return {
    statementName: STATEMENT_TITLES.financialPosition,
    alternativeNames: ['Balance sheet'],
    recognitionBasis: 'As at date; historical balances from the ledger',
    asAt,
    description:
      'Assets, liabilities and equity from cumulative balances on embedded journal lines (`financial_journal_entries.entries`). Total assets equals total liabilities plus equity when balanced. Retained earnings (3003) may include cumulative unclosed profit or loss until formal closing entries are posted.',
  };
}

/**
 * @param {{ netCashMovement: number }} cfSummary
 * @param {number} accrualNetProfitBeforeTax
 * @param {number} deltaAccountsReceivable1010 — closing AR minus opening AR for the cash-flow period
 */
function accountingDisclosureCashFlow(cfSummary, accrualNetProfitBeforeTax, deltaAccountsReceivable1010) {
  const pl = round2(accrualNetProfitBeforeTax);
  const nc = round2(cfSummary.netCashMovement);
  const accrualVersusCashNote =
    Math.abs(nc) < 0.02 && Math.abs(pl) >= 0.01
      ? 'Accrual profit for the period is non-zero while net cash flow on account 1001 is nil. This is usual when revenue is recognised on credit (e.g. Dr receivables / Cr revenue) before settlement posts to cash.'
      : undefined;
  return {
    statementName: STATEMENT_TITLES.cashFlows,
    method: 'Direct',
    description:
      'Cash receipts and payments classified by activity using journal lines on account 1001 (cash/bank) only. Non-cash transactions (including accrual revenue before collection) do not appear until cash is posted.',
    cashAndCashEquivalentsAccountCode: '1001',
    accrualNetProfitBeforeTaxForSamePeriod: pl,
    changeInAccountsReceivable1010: round2(deltaAccountsReceivable1010),
    accrualVersusCashNote,
  };
}

function parseDateEndOfDay(d) {
  const end = new Date(d);
  end.setUTCHours(23, 59, 59, 999);
  return end;
}

async function getIncomeStatementV3(startDate, endDate) {
  const start = new Date(startDate);
  const end = parseDateEndOfDay(endDate);

  const rows = await FinancialJournalEntry.aggregate([
    {
      $match: {
        date: { $gte: start, $lte: end },
        isVoided: false,
        ...JOURNAL_HAS_ENTRIES,
      },
    },
    { $unwind: '$entries' },
    { $match: { 'entries.accountType': { $in: ['revenue', 'expense'] } } },
    {
      $addFields: {
        accountCode: { $toString: '$entries.accountCode' },
        accountName: '$entries.accountName',
        accountType: '$entries.accountType',
        side: { $cond: [{ $gt: ['$entries.debit', 0] }, 'DR', 'CR'] },
        amount: {
          $cond: [{ $gt: ['$entries.debit', 0] }, '$entries.debit', '$entries.credit'],
        },
      },
    },
    {
      $group: {
        _id: {
          accountCode: '$accountCode',
          accountName: '$accountName',
          accountType: '$accountType',
        },
        dr: { $sum: { $cond: [{ $eq: ['$side', 'DR'] }, '$amount', 0] } },
        cr: { $sum: { $cond: [{ $eq: ['$side', 'CR'] }, '$amount', 0] } },
      },
    },
    { $sort: { '_id.accountCode': 1 } },
  ]);

  let bnbRevenue = 0;
  let eventRevenue = 0;
  let otherIncome = 0;
  let refunds = 0;
  let cosTotal = 0;
  const opex = {};
  /** @type {Record<string, number>} */
  const cosByCode = {};
  /** @type {Record<string, number>} */
  const opexByCode = {};

  for (const r of rows) {
    const { accountCode, accountName, accountType } = r._id;
    const dr = r.dr;
    const cr = r.cr;

    if (accountType === 'revenue') {
      const net = cr - dr;
      if (accountCode === '4001') bnbRevenue += net;
      else if (accountCode === '4002') eventRevenue += net;
      else if (accountCode === '4003') otherIncome += net;
      else if (accountCode === '4010') refunds += Math.abs(dr - cr);
      else if (accountCode.startsWith('4')) {
        /* other revenue codes */
      }
    } else if (accountType === 'expense') {
      const net = dr - cr;
      if (accountCode.startsWith('5')) {
        cosTotal += net;
        cosByCode[accountCode] = (cosByCode[accountCode] || 0) + net;
      } else if (accountCode.startsWith('6')) {
        opexByCode[accountCode] = (opexByCode[accountCode] || 0) + net;
        const key = accountName || accountCode;
        opex[key] = (opex[key] || 0) + net;
      }
    }
  }

  bnbRevenue = round2(bnbRevenue);
  eventRevenue = round2(eventRevenue);
  otherIncome = round2(otherIncome);
  refunds = round2(refunds);
  cosTotal = round2(cosTotal);

  const grossRevenue = round2(bnbRevenue + eventRevenue + otherIncome);
  const netRevenue = round2(grossRevenue - refunds);
  const grossProfit = round2(netRevenue - cosTotal);
  const totalOpex = round2(Object.values(opex).reduce((s, v) => s + v, 0));
  const netProfit = round2(grossProfit - totalOpex);

  for (const k of Object.keys(opex)) opex[k] = round2(opex[k]);
  for (const k of Object.keys(cosByCode)) cosByCode[k] = round2(cosByCode[k]);
  for (const k of Object.keys(opexByCode)) opexByCode[k] = round2(opexByCode[k]);

  return {
    revenue: {
      bnbRevenue,
      eventRevenue,
      otherIncome,
      grossRevenue,
      refunds,
      netRevenue,
    },
    costOfSales: cosTotal,
    costOfSalesByCode: cosByCode,
    grossProfit,
    operatingExpenses: opex,
    operatingExpensesByCode: opexByCode,
    totalOperatingExpenses: totalOpex,
    netProfitBeforeTax: netProfit,
    period: { startDate: start, endDate: end },
  };
}

/**
 * §7 Income Statement — presentation structure (amounts positive where expenses are shown as deductions in UI).
 */
function shapeIncomeStatementPresentationV7(d) {
  const oc = d.operatingExpensesByCode || {};
  const cos = d.costOfSalesByCode || {};
  const supplier601x = round2(
    (oc['6010'] || 0) + (oc['6011'] || 0) + (oc['6012'] || 0) + (oc['6013'] || 0)
  );
  const operatingProfit = round2(d.grossProfit - d.totalOperatingExpenses);
  return {
    statementTitle: STATEMENT_TITLES.profitOrLoss,
    period: d.period,
    revenue: {
      bnbRevenue: d.revenue.bnbRevenue,
      eventRevenue: d.revenue.eventRevenue,
      otherIncome: d.revenue.otherIncome,
      grossRevenue: d.revenue.grossRevenue,
      refundsAndAllowances: d.revenue.refunds,
      netRevenue: d.revenue.netRevenue,
    },
    costOfSales: {
      consumablesAndToiletries5001: cos['5001'] ?? 0,
      cleaningSupplies5002: cos['5002'] ?? 0,
      total: d.costOfSales,
    },
    grossProfit: d.grossProfit,
    operatingExpenses: {
      salaries6001: oc['6001'] ?? 0,
      staffTaskPayments6002: oc['6002'] ?? 0,
      supplier601x,
      utilities6020: oc['6020'] ?? 0,
      maintenance6021: oc['6021'] ?? 0,
      marketing6022: oc['6022'] ?? 0,
      bankCharges6023: oc['6023'] ?? 0,
      pettyCash6024: oc['6024'] ?? 0,
      depreciation6030: oc['6030'] ?? 0,
      managementFee6031: oc['6031'] ?? 0,
    },
    operatingProfitEBIT: operatingProfit,
    netProfitBeforeTax: d.netProfitBeforeTax,
  };
}

/**
 * IAS 7–style headings; line detail from direct analysis of account 1001.
 */
function shapeCashFlowPresentationV3(cf) {
  const flowLine = (l) => ({
    date: l.date,
    amount: round2(l.amount),
    side: l.side,
    description: l.description || '',
    transactionType: l.transactionType,
  });

  return {
    statementTitle: STATEMENT_TITLES.cashFlows,
    period: cf.period,
    sections: [
      {
        id: 'operating',
        standardHeading: 'Cash flows from operating activities',
        cashReceipts: cf.detail.operatingInflows.map(flowLine),
        cashPayments: cf.detail.operatingOutflows.map(flowLine),
        cashReceiptsByAccount: cf.operatingBreakdown?.inflowsByAccount || [],
        cashPaymentsByAccount: cf.operatingBreakdown?.outflowsByAccount || [],
        subtotal: cf.operating,
      },
      {
        id: 'investing',
        standardHeading: 'Cash flows from investing activities',
        cashReceipts: cf.detail.investingInflows.map(flowLine),
        cashPayments: cf.detail.investingOutflows.map(flowLine),
        subtotal: cf.investing,
      },
      {
        id: 'financing',
        standardHeading: 'Cash flows from financing activities',
        cashReceipts: cf.detail.financingInflows.map(flowLine),
        cashPayments: cf.detail.financingOutflows.map(flowLine),
        subtotal: cf.financing,
      },
      {
        id: 'net_change_in_cash',
        standardHeading: 'Net increase (decrease) in cash and cash equivalents',
        amount: cf.netCashMovement,
      },
      {
        id: 'cash_reconciliation',
        standardHeading: 'Cash and cash equivalents — reconciliation',
        atBeginningOfPeriod: cf.cash1001.beginningBalance,
        netIncreaseDecreaseInPeriod: cf.netCashMovement,
        atEndOfPeriod: cf.cash1001.endingBalance,
      },
    ],
  };
}

/** `CHART_OF_ACCOUNTS_V3` is keyed by numeric code → `{ name, accountType, note? }`. */
function accountFromChartV3(code) {
  const n = Number(String(code).trim());
  if (!Number.isFinite(n)) return null;
  const row = CHART_OF_ACCOUNTS_V3[n];
  if (!row) return null;
  return { code: String(n), name: row.name, accountType: row.accountType };
}

function pickCashLine1001(entries) {
  return (entries || []).find((e) => String(e.accountCode) === '1001') || null;
}

/** For cash inflow (Dr cash), counterpart is usually a Cr line; for outflow, a Dr line. */
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

const BNB_CASH_TYPES = new Set([
  'booking_payment',
  'booking_deposit_received',
  'booking_balance_received',
]);

/**
 * UI-facing grouping for cash movements (underpins `plainLanguage.composition`).
 * @param {string} transactionType
 * @param {'in'|'out'} direction
 */
function plainLanguageBucket(transactionType, direction) {
  const tt = String(transactionType || 'unknown');
  if (BNB_CASH_TYPES.has(tt)) {
    return {
      key: 'bnb_guest_collections',
      label:
        'B&B guest stay cash (typically clears 1010; stay revenue is recognised on 4001 when the booking is confirmed)',
    };
  }
  if (tt === 'owner_investment') {
    return { key: 'owner_investment', label: 'Owner investment (cash to equity)' };
  }
  if (tt === 'owner_drawing') {
    return { key: 'owner_drawings', label: 'Owner drawings (cash out)' };
  }
  if (tt === 'equipment_purchase') {
    return { key: 'investing_equipment', label: 'Equipment / asset purchases' };
  }
  const verb = direction === 'in' ? 'Cash in' : 'Cash out';
  return {
    key: `journal_${tt}`,
    label: `${verb}: ${tt.replace(/_/g, ' ')}`,
  };
}

function aggregatePlainComposition(movements) {
  /** @param {'in'|'out'} dir */
  const fold = (dir) => {
    const map = new Map();
    for (const m of movements) {
      if (m.direction !== dir) continue;
      const k = m.bucket.key;
      const row = map.get(k) || { key: k, label: m.bucket.label, total: 0, movementCount: 0 };
      row.total += m.amount;
      row.movementCount += 1;
      map.set(k, row);
    }
    return [...map.values()]
      .map((r) => ({ ...r, total: round2(r.total) }))
      .sort((a, b) => b.total - a.total);
  };
  return { cashIn: fold('in'), cashOut: fold('out') };
}

function monthlyPlainCashTotals(movements) {
  const map = new Map();
  for (const m of movements) {
    const d = new Date(m.date);
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const row = map.get(ym) || { month: ym, totalCashIn: 0, totalCashOut: 0 };
    if (m.direction === 'in') row.totalCashIn += m.amount;
    else row.totalCashOut += m.amount;
    map.set(ym, row);
  }
  return [...map.values()]
    .map((r) => ({
      month: r.month,
      totalCashIn: round2(r.totalCashIn),
      totalCashOut: round2(r.totalCashOut),
      net: round2(r.totalCashIn - r.totalCashOut),
    }))
    .sort((a, b) => b.month.localeCompare(a.month));
}

function buildPlainLanguageCashMovements(journalRows) {
  const revenue4001 = accountFromChartV3('4001');
  const movements = [];
  for (const je of journalRows) {
    const cashLine = pickCashLine1001(je.entries);
    if (!cashLine) continue;
    const debit = Number(cashLine.debit) || 0;
    const credit = Number(cashLine.credit) || 0;
    if (debit <= 0 && credit <= 0) continue;
    const direction = debit > 0 ? 'in' : 'out';
    const amount = round2(debit > 0 ? debit : credit);
    const counterpart = pickCounterpartEntry(je.entries, direction === 'in');
    const tt = String(je.transactionType || 'unknown');
    const glCounterpart = counterpart
      ? {
          accountCode: String(counterpart.accountCode),
          accountName:
            counterpart.accountName ||
            accountFromChartV3(String(counterpart.accountCode))?.name ||
            '',
          accountType: counterpart.accountType,
        }
      : null;

    let headline = '';
    let detail = '';
    let glNote = '';
    let story = null;

    if (BNB_CASH_TYPES.has(tt)) {
      headline =
        tt === 'booking_payment'
          ? 'Cash received for a guest stay'
          : tt === 'booking_deposit_received'
            ? 'Cash: booking deposit received'
            : 'Cash: final balance received';
      detail =
        'Cash went up. This is usually paired with reducing what the guest owed you (receivable), not with recognising new room revenue in this same journal.';
      if (glCounterpart?.accountCode === '1010') {
        glNote =
          'You see Accounts receivable (1010) here because the payment clears the guest balance. The stay revenue is BnB Revenue (4001) when the booking is recognised.';
      }
      story = {
        kind: 'bnb_stay_payment',
        revenueYouEarnFromStays: {
          accountCode: '4001',
          accountName: revenue4001?.name || 'BnB Revenue',
        },
        whatThisJournalShows: 'Cash in the bank from the guest; receivable goes down.',
      };
    } else if (tt === 'owner_investment') {
      headline = 'Cash in from owner investment';
      detail = 'Owner contributed capital; cash increases with the matching equity line.';
    } else if (tt === 'owner_drawing') {
      headline = 'Cash out — owner drawing';
      detail = 'Owner took funds out of the business.';
    } else {
      headline = `${direction === 'in' ? 'Cash received' : 'Cash paid'} (${tt.replace(/_/g, ' ')})`;
      detail = je.description || '';
    }

    const bucket = plainLanguageBucket(tt, direction);

    movements.push({
      journalEntryId: String(je._id),
      date: je.date,
      direction,
      amount,
      transactionType: tt,
      bucket,
      headline,
      detail,
      glNote,
      cashAccount: {
        accountCode: '1001',
        accountName: accountFromChartV3('1001')?.name || 'Cash / Bank',
      },
      glCounterpart,
      /** When present, the P&L line this stay cash relates to (revenue is recognised there, not on the cash receipt). */
      relatedRevenueAccount:
        BNB_CASH_TYPES.has(tt) && revenue4001
          ? { accountCode: revenue4001.code, accountName: revenue4001.name }
          : BNB_CASH_TYPES.has(tt)
            ? { accountCode: '4001', accountName: 'BnB Revenue' }
            : null,
      story,
      description: je.description || '',
    });
  }
  movements.sort((a, b) => new Date(b.date) - new Date(a.date));
  return movements;
}

function summarizePlainCashMovements(movements) {
  let inSum = 0;
  let outSum = 0;
  for (const m of movements) {
    if (m.direction === 'in') inSum += m.amount;
    else outSum += m.amount;
  }
  return {
    totalCashIn: round2(inSum),
    totalCashOut: round2(outSum),
    net: round2(inSum - outSum),
  };
}

async function getCashFlowV3(startDate, endDate) {
  const start = new Date(startDate);
  const end = parseDateEndOfDay(endDate);

  const lines = await FinancialJournalEntry.aggregate([
    {
      $match: {
        date: { $gte: start, $lte: end },
        isVoided: false,
        ...JOURNAL_HAS_ENTRIES,
      },
    },
    { $unwind: '$entries' },
    { $match: { 'entries.accountCode': '1001' } },
    {
      $project: {
        journalEntryId: '$_id',
        side: { $cond: [{ $gt: ['$entries.debit', 0] }, 'DR', 'CR'] },
        amount: {
          $cond: [{ $gt: ['$entries.debit', 0] }, '$entries.debit', '$entries.credit'],
        },
        date: '$date',
        transactionType: '$transactionType',
        description: { $ifNull: ['$entries.description', '$description'] },
      },
    },
  ]);

  const operating = { inflows: [], outflows: [] };
  const investing = { inflows: [], outflows: [] };
  const financing = { inflows: [], outflows: [] };

  const INVESTING = ['equipment_purchase'];
  const FINANCING = ['owner_investment', 'owner_drawing'];

  for (const l of lines) {
    const cat = INVESTING.includes(l.transactionType)
      ? investing
      : FINANCING.includes(l.transactionType)
        ? financing
        : operating;
    if (l.side === 'DR') cat.inflows.push(l);
    else cat.outflows.push(l);
  }

  const net = (cat) => {
    const inflows = cat.inflows.reduce((s, x) => s + x.amount, 0);
    const outflows = cat.outflows.reduce((s, x) => s + x.amount, 0);
    return {
      inflows: round2(inflows),
      outflows: round2(outflows),
      net: round2(inflows - outflows),
    };
  };

  const op = net(operating);
  const inv = net(investing);
  const fin = net(financing);
  const netCashMovement = round2(op.net + inv.net + fin.net);

  const counterpartAccountBreakdown = await FinancialJournalEntry.aggregate([
    {
      $match: {
        date: { $gte: start, $lte: end },
        isVoided: false,
        ...JOURNAL_HAS_ENTRIES,
      },
    },
    {
      $project: {
        date: 1,
        transactionType: 1,
        entries: 1,
      },
    },
    {
      $addFields: {
        cashDebit: {
          $sum: {
            $map: {
              input: {
                $filter: {
                  input: '$entries',
                  as: 'e',
                  cond: { $eq: ['$$e.accountCode', '1001'] },
                },
              },
              as: 'c',
              in: { $ifNull: ['$$c.debit', 0] },
            },
          },
        },
        cashCredit: {
          $sum: {
            $map: {
              input: {
                $filter: {
                  input: '$entries',
                  as: 'e',
                  cond: { $eq: ['$$e.accountCode', '1001'] },
                },
              },
              as: 'c',
              in: { $ifNull: ['$$c.credit', 0] },
            },
          },
        },
      },
    },
    { $match: { $or: [{ cashDebit: { $gt: 0 } }, { cashCredit: { $gt: 0 } }] } },
    { $unwind: '$entries' },
    { $match: { 'entries.accountCode': { $ne: '1001' } } },
    {
      $addFields: {
        flowDirection: {
          $cond: [{ $gt: ['$cashDebit', 0] }, 'inflow', 'outflow'],
        },
        counterpartAmount: {
          $cond: [
            { $gt: ['$cashDebit', 0] },
            { $ifNull: ['$entries.credit', 0] },
            { $ifNull: ['$entries.debit', 0] },
          ],
        },
      },
    },
    { $match: { counterpartAmount: { $gt: 0 } } },
    {
      $group: {
        _id: {
          flowDirection: '$flowDirection',
          accountCode: '$entries.accountCode',
          accountName: '$entries.accountName',
          accountType: '$entries.accountType',
        },
        amount: { $sum: '$counterpartAmount' },
      },
    },
    { $sort: { '_id.flowDirection': 1, '_id.accountCode': 1 } },
  ]);

  const inflowsByAccount = [];
  const outflowsByAccount = [];
  for (const row of counterpartAccountBreakdown) {
    const entry = {
      accountCode: row._id.accountCode,
      accountName: row._id.accountName,
      accountType: row._id.accountType,
      amount: round2(row.amount),
    };
    if (row._id.flowDirection === 'inflow') inflowsByAccount.push(entry);
    else outflowsByAccount.push(entry);
  }

  const inflowByType = operating.inflows.reduce((acc, l) => {
    const k = String(l.transactionType || 'unknown');
    acc[k] = round2((acc[k] || 0) + (Number(l.amount) || 0));
    return acc;
  }, {});
  const bnbCashReceived = round2(
    (inflowByType.booking_payment || 0) +
      (inflowByType.booking_deposit_received || 0) +
      (inflowByType.booking_balance_received || 0)
  );

  const dayBeforeStart = new Date(start);
  dayBeforeStart.setUTCDate(dayBeforeStart.getUTCDate() - 1);
  const openingBs = await getBalanceSheetV3(dayBeforeStart);
  const closingBs = await getBalanceSheetV3(end);
  const cashRow = (rows) => rows.find((a) => a.accountCode === '1001');
  const beginningCash1001 = round2(cashRow(openingBs.assets)?.balance ?? 0);
  const endingCash1001 = round2(cashRow(closingBs.assets)?.balance ?? 0);

  const core = {
    operating: op,
    investing: inv,
    financing: fin,
    netCashMovement,
    cash1001: {
      beginningBalance: beginningCash1001,
      endingBalance: endingCash1001,
      impliedChangeFromBalanceSheet: round2(endingCash1001 - beginningCash1001),
      matchesNetCashMovement: Math.abs(netCashMovement - (endingCash1001 - beginningCash1001)) < 0.05,
    },
    detail: {
      operatingInflows: operating.inflows,
      operatingOutflows: operating.outflows,
      investingInflows: investing.inflows,
      investingOutflows: investing.outflows,
      financingInflows: financing.inflows,
      financingOutflows: financing.outflows,
    },
    period: { startDate: start, endDate: end },
    operatingBreakdown: {
      inflowsByTransactionType: inflowByType,
      bnbCashReceived,
      inflowsByAccount,
      outflowsByAccount,
    },
  };

  const plSamePeriod = await getIncomeStatementV3(start, end);
  const arOpen = accountsReceivable1010FromBalanceSheet(openingBs);
  const arClose = accountsReceivable1010FromBalanceSheet(closingBs);
  const deltaAr = round2(arClose - arOpen);

  const accounting = accountingDisclosureCashFlow(core, plSamePeriod.netProfitBeforeTax, deltaAr);
  const presentation = shapeCashFlowPresentationV3(core);

  const journalDocsForPlain = await FinancialJournalEntry.find({
    date: { $gte: start, $lte: end },
    isVoided: false,
    ...JOURNAL_HAS_ENTRIES,
    'entries.accountCode': '1001',
  })
    .sort({ date: -1 })
    .lean();

  const movementsPlain = buildPlainLanguageCashMovements(journalDocsForPlain);
  const composition = aggregatePlainComposition(movementsPlain);
  const plainLanguage = {
    basis:
      'Posted v3 journals on cash/bank 1001. Composition groups are plain-language labels; GL counterpart lines stay in each movement for audit.',
    summary: summarizePlainCashMovements(movementsPlain),
    composition: {
      /** What total cash in is made of (same totals as summary.totalCashIn when all journals hit 1001). */
      cashIn: composition.cashIn,
      /** What total cash out is made of. */
      cashOut: composition.cashOut,
    },
    byMonth: monthlyPlainCashTotals(movementsPlain),
    movements: movementsPlain,
    buckets: {
      cashIn: movementsPlain.filter((m) => m.direction === 'in'),
      cashOut: movementsPlain.filter((m) => m.direction === 'out'),
    },
  };

  return {
    accounting,
    presentation: { ...presentation, plainLanguage },
    plainLanguage,
    ...core,
  };
}

async function getBalanceSheetV3(asAtInput) {
  const asAt = asAtInput ? parseDateEndOfDay(asAtInput) : parseDateEndOfDay(new Date());

  const lines = await FinancialJournalEntry.aggregate([
    {
      $match: {
        date: { $lte: asAt },
        isVoided: false,
        ...JOURNAL_HAS_ENTRIES,
      },
    },
    { $unwind: '$entries' },
    { $match: { 'entries.accountType': { $in: ['asset', 'liability', 'equity'] } } },
    {
      $addFields: {
        accountCode: { $toString: '$entries.accountCode' },
        accountName: '$entries.accountName',
        accountType: '$entries.accountType',
        side: { $cond: [{ $gt: ['$entries.debit', 0] }, 'DR', 'CR'] },
        amount: {
          $cond: [{ $gt: ['$entries.debit', 0] }, '$entries.debit', '$entries.credit'],
        },
      },
    },
    {
      $group: {
        _id: {
          accountCode: '$accountCode',
          accountName: '$accountName',
          accountType: '$accountType',
        },
        drTotal: { $sum: { $cond: [{ $eq: ['$side', 'DR'] }, '$amount', 0] } },
        crTotal: { $sum: { $cond: [{ $eq: ['$side', 'CR'] }, '$amount', 0] } },
      },
    },
    {
      $project: {
        accountCode: '$_id.accountCode',
        accountName: '$_id.accountName',
        accountType: '$_id.accountType',
        balance: {
          $cond: [
            { $eq: ['$_id.accountType', 'asset'] },
            { $subtract: ['$drTotal', '$crTotal'] },
            { $subtract: ['$crTotal', '$drTotal'] },
          ],
        },
      },
    },
    { $sort: { accountCode: 1 } },
  ]);

  const codes = Array.from(new Set(lines.map((l) => String(l.accountCode))));
  const accountDocs = await Account.find({ code: { $in: codes } })
    .select('code subType')
    .lean();
  const subTypeByCode = new Map(accountDocs.map((a) => [String(a.code), a.subType || null]));

  const assets = [];
  const liabilities = [];
  const equity = [];

  for (const l of lines) {
    const row = {
      accountCode: l.accountCode,
      accountName: l.accountName,
      accountType: l.accountType,
      subType: subTypeByCode.get(String(l.accountCode)) || null,
      balance: round2(l.balance),
    };
    if (l.accountType === 'asset') assets.push(row);
    else if (l.accountType === 'liability') liabilities.push(row);
    else equity.push(row);
  }

  /** Cumulative P&L through as-at (revenue/expense lines). Fold into 3003 so AR from JE-01 balances RE. */
  const plCumulative = await getIncomeStatementV3(new Date('1970-01-01T00:00:00.000Z'), asAt);
  const cumulativeNI = round2(plCumulative.netProfitBeforeTax);
  let appliedCumulativePL = false;
  if (Math.abs(cumulativeNI) >= 0.01) {
    appliedCumulativePL = true;
    const reName = CHART_OF_ACCOUNTS_V3[3003]?.name || 'Retained Earnings';
    const idx = equity.findIndex((e) => e.accountCode === '3003');
    if (idx >= 0) {
      equity[idx] = {
        ...equity[idx],
        balance: round2(equity[idx].balance + cumulativeNI),
        includesUnclosedProfitAndLoss: true,
      };
    } else {
      equity.push({
        accountCode: '3003',
        accountName: reName,
        accountType: 'equity',
        subType: 'RETAINED_EARNINGS',
        balance: cumulativeNI,
        includesUnclosedProfitAndLoss: true,
      });
    }
    equity.sort((a, b) => String(a.accountCode).localeCompare(String(b.accountCode)));
  }

  const sum = (arr) => round2(arr.reduce((s, x) => s + x.balance, 0));
  const totalAssets = sum(assets);
  const totalLiab = sum(liabilities);
  const totalEquity = sum(equity);
  const totalLiabEquity = round2(totalLiab + totalEquity);
  const diff = round2(totalAssets - totalLiabEquity);

  return {
    asAt,
    assets,
    liabilities,
    equity,
    totalAssets,
    totalLiabilities: totalLiab,
    totalEquity,
    totalLiabilitiesAndEquity: totalLiabEquity,
    balances: Math.abs(diff) < 0.02,
    equation: {
      difference: diff,
      balanced: Math.abs(diff) < 0.02,
    },
    meta: appliedCumulativePL
      ? {
          cumulativeNetProfitBeforeTax: cumulativeNI,
          retainedEarningsIncludesCumulativePL: true,
        }
      : undefined,
  };
}

/**
 * Balance sheet — stable sections for UI (amounts are signed normal balances).
 */
function shapeBalanceSheetPresentationV3(d) {
  const line = (r) => ({
    accountCode: r.accountCode,
    accountName: r.accountName,
    subType: r.subType || null,
    balance: r.balance,
    ...(r.includesUnclosedProfitAndLoss ? { includesUnclosedProfitAndLoss: true } : {}),
  });
  return {
    statementTitle: STATEMENT_TITLES.financialPosition,
    asAt: d.asAt,
    sections: [
      { key: 'assets', label: 'Assets', lines: (d.assets || []).map(line), total: d.totalAssets },
      {
        key: 'liabilities',
        label: 'Liabilities',
        lines: (d.liabilities || []).map(line),
        total: d.totalLiabilities ?? 0,
      },
      {
        key: 'equity',
        label: "Owner's equity",
        lines: (d.equity || []).map(line),
        total: d.totalEquity ?? 0,
      },
    ],
    equation: d.equation,
    meta: d.meta,
  };
}

module.exports = {
  getIncomeStatementV3,
  getCashFlowV3,
  getBalanceSheetV3,
  shapeIncomeStatementPresentationV7,
  shapeBalanceSheetPresentationV3,
  shapeCashFlowPresentationV3,
  accountingDisclosureIncomeStatement,
  accountingDisclosureBalanceSheet,
  accountingDisclosureCashFlow,
  STATEMENT_TITLES,
};
