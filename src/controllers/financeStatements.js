// Financial statements — Chynae Digital Solutions v3.0 (double_entry_v3 basis).
// Mount via financeRoutes.js and /api/statements/*.

const FinancialJournalEntry = require('../models/FinancialJournalEntry');
const {
  getIncomeStatementV3,
  getCashFlowV3,
  getBalanceSheetV3,
  shapeIncomeStatementPresentationV7,
  shapeBalanceSheetPresentationV3,
  accountingDisclosureIncomeStatement,
  accountingDisclosureBalanceSheet,
} = require('../services/financialStatementsV3Service');
const { buildLegacyCashFlowDashboardResponse } = require('../services/cashFlowDashboardLegacyV3Service');

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

function parsePagination(query) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(500, Math.max(1, parseInt(query.limit, 10) || 100));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

async function pagedEntryLines({ match, lineMatch = {}, page, limit, skip }) {
  const dataPipeline = [
    { $match: match },
    { $unwind: '$entries' },
    { $match: lineMatch },
    { $sort: { date: -1, createdAt: -1 } },
    {
      $project: {
        _id: 1,
        journalId: 1,
        publicTransactionId: 1,
        transactionType: 1,
        date: 1,
        description: 1,
        reference: 1,
        isVoided: 1,
        line: '$entries',
      },
    },
    { $skip: skip },
    { $limit: limit },
  ];
  const countPipeline = [
    { $match: match },
    { $unwind: '$entries' },
    { $match: lineMatch },
    { $count: 'n' },
  ];
  const [data, countRows] = await Promise.all([
    FinancialJournalEntry.aggregate(dataPipeline),
    FinancialJournalEntry.aggregate(countPipeline),
  ]);
  return { data, meta: { page, limit, total: countRows[0]?.n || 0 } };
}

// ─── INCOME STATEMENT (§6.1 / §7) ──────────────────────────────────────────
exports.getIncomeStatement = async (req, res) => {
  try {
    const { start, end } = parseDates(req.query);

    const periodLength = end.getTime() - start.getTime();
    const priorEnd = new Date(start.getTime() - 86400000);
    priorEnd.setUTCHours(23, 59, 59, 999);
    const priorStart = new Date(priorEnd.getTime() - periodLength);
    priorStart.setUTCHours(0, 0, 0, 0);

    const [current, prior] = await Promise.all([
      getIncomeStatementV3(start, end),
      getIncomeStatementV3(priorStart, priorEnd),
    ]);

    res.json({
      success: true,
      basis: 'double_entry_v3',
      data: {
        accounting: accountingDisclosureIncomeStatement(current.period),
        current: {
          presentation: shapeIncomeStatementPresentationV7(current),
          ...current,
        },
        prior: {
          presentation: shapeIncomeStatementPresentationV7(prior),
          ...prior,
        },
      },
    });
  } catch (err) {
    console.error('Income statement error:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to generate income statement' });
  }
};

// ─── BALANCE SHEET (§6.3) ──────────────────────────────────────────────────
exports.getBalanceSheet = async (req, res) => {
  try {
    const asAtRaw = req.query.asAt || req.query.asOfDate || req.query.asOf;
    let asAt;
    if (asAtRaw && /^\d{4}-\d{2}-\d{2}$/.test(String(asAtRaw).trim())) {
      asAt = new Date(`${String(asAtRaw).trim()}T23:59:59.999Z`);
    } else if (asAtRaw) {
      asAt = new Date(asAtRaw);
      asAt.setUTCHours(23, 59, 59, 999);
    } else {
      asAt = new Date();
      asAt.setUTCHours(23, 59, 59, 999);
    }

    const core = await getBalanceSheetV3(asAt);
    if (!core.balances) {
      console.error('[BalanceSheet v3] Equation not balanced as at', asAt.toISOString().slice(0, 10));
    }

    const data = {
      accounting: accountingDisclosureBalanceSheet(core.asAt),
      presentation: shapeBalanceSheetPresentationV3(core),
      ...core,
    };

    res.json({ success: true, basis: 'double_entry_v3', data });
  } catch (err) {
    console.error('Balance sheet error:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to generate balance sheet' });
  }
};

// ─── CASH FLOW (§6.2 — account 1001) ────────────────────────────────────────
exports.getCashFlow = async (req, res) => {
  try {
    const { start, end } = parseDates(req.query);
    const rawV3 =
      String(req.query.format || req.query.view || '').toLowerCase() === 'v3' ||
      String(req.query.rawV3 || '').toLowerCase() === 'true';

    const data = rawV3
      ? await getCashFlowV3(start, end)
      : await buildLegacyCashFlowDashboardResponse(start, end);

    if (rawV3) {
      res.json({ success: true, basis: 'double_entry_v3', data });
    } else {
      res.json({ success: true, data });
    }
  } catch (err) {
    console.error('Cash flow error:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to generate cash flow statement' });
  }
};

// ─── P&L (same ledger basis as income statement) ───────────────────────────
exports.getPL = async (req, res) => {
  try {
    const { start, end } = parseDates(req.query);
    const current = await getIncomeStatementV3(start, end);

    res.json({
      success: true,
      basis: 'double_entry_v3',
      data: {
        accounting: accountingDisclosureIncomeStatement(current.period),
        presentation: shapeIncomeStatementPresentationV7(current),
        ...current,
      },
    });
  } catch (err) {
    console.error('P&L error:', err);
    res.status(500).json({ success: false, message: err.message || 'Failed to generate P&L statement' });
  }
};

// ─── Statement Drilldowns (v3 lines) ────────────────────────────────────────
exports.getIncomeStatementTransactions = async (req, res) => {
  try {
    const { start, end } = parseDates(req.query);
    const { page, limit, skip } = parsePagination(req.query);
    const match = {
      date: { $gte: start, $lte: end },
      isVoided: false,
      'entries.0': { $exists: true },
    };
    const lineMatch = { 'entries.accountType': { $in: ['revenue', 'expense'] } };
    const result = await pagedEntryLines({ match, lineMatch, page, limit, skip });
    return res.json({ success: true, basis: 'double_entry_v3', ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || 'Failed to load income statement transactions' });
  }
};

exports.getCashFlowTransactions = async (req, res) => {
  try {
    const { start, end } = parseDates(req.query);
    const { page, limit, skip } = parsePagination(req.query);
    const txType = req.query.transactionType ? String(req.query.transactionType).trim() : null;
    const match = {
      date: { $gte: start, $lte: end },
      isVoided: false,
      'entries.0': { $exists: true },
      ...(txType ? { transactionType: txType } : {}),
    };
    const lineMatch = { 'entries.accountCode': '1001' };
    const result = await pagedEntryLines({ match, lineMatch, page, limit, skip });
    return res.json({ success: true, basis: 'double_entry_v3', ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || 'Failed to load cash flow transactions' });
  }
};

exports.getBalanceSheetTransactions = async (req, res) => {
  try {
    const asAtRaw = req.query.asAt || req.query.asOfDate || req.query.asOf;
    const asAt = asAtRaw ? parseDateParamToUtcEnd(asAtRaw) : parseDateParamToUtcEnd(new Date().toISOString());
    const { page, limit, skip } = parsePagination(req.query);
    const accountType = req.query.accountType ? String(req.query.accountType).trim().toLowerCase() : null;
    const match = {
      date: { $lte: asAt },
      isVoided: false,
      'entries.0': { $exists: true },
    };
    const lineMatch = accountType
      ? { 'entries.accountType': accountType }
      : { 'entries.accountType': { $in: ['asset', 'liability', 'equity'] } };
    const result = await pagedEntryLines({ match, lineMatch, page, limit, skip });
    return res.json({ success: true, basis: 'double_entry_v3', asAt, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || 'Failed to load balance sheet transactions' });
  }
};
