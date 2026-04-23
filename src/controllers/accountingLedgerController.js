const FinancialJournalEntry = require('../models/FinancialJournalEntry');

function toTitleCase(value) {
  const s = String(value || '').toLowerCase();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

function parseDateStart(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function parseDateEnd(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

function baseMatchFromQuery(query) {
  const match = {};
  const start = parseDateStart(query.startDate);
  const end = parseDateEnd(query.endDate);
  if (start || end) {
    match.date = {};
    if (start) match.date.$gte = start;
    if (end) match.date.$lte = end;
  }
  const status = String(query.status || '').toLowerCase();
  if (status === 'posted') match.isVoided = false;
  else if (status === 'voided') match.isVoided = true;
  if (query.transactionType) match.transactionType = String(query.transactionType).trim();
  return match;
}

function mapJournalToLegacyShape(j) {
  const entries = (j.entries || []).map((l) => ({
    _id: l._id,
    accountCode: l.accountCode || null,
    accountName: l.accountName || null,
    accountType: toTitleCase(l.accountType),
    debit: Number(l.debit) || 0,
    credit: Number(l.credit) || 0,
    description: l.description || '',
  }));
  return {
    _id: j._id,
    transactionId: j.publicTransactionId || j.reference || `JE-${j._id}`,
    date: j.date,
    description: j.description,
    reference: j.reference || null,
    entries,
    totalDebit: Number((j.totalDebit || 0).toFixed(2)),
    totalCredit: Number((j.totalCredit || 0).toFixed(2)),
    source: j.source || String(j.transactionType || '').toLowerCase(),
    sourceId: j.sourceId || null,
    sourceModel: j.sourceModel || 'FinancialJournalEntry',
    createdBy: j.createdBy || null,
    status: j.isVoided ? 'voided' : 'posted',
    metadata: {
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
    },
  };
}

/**
 * GET /api/accounting/ledger and GET /api/statements/ledger
 * Query: startDate, endDate (YYYY-MM-DD), status (POSTED|VOIDED|all|comma list), entryType, page, limit
 */
exports.listGeneralLedger = async function listGeneralLedger(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;
    const match = baseMatchFromQuery(req.query);
    const [rows, total] = await Promise.all([
      FinancialJournalEntry.find(match)
        .sort({ date: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      FinancialJournalEntry.countDocuments(match),
    ]);
    const data = rows.map(mapJournalToLegacyShape);
    res.json({ success: true, data, meta: { page, limit, total } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * GET /api/finance/transactions-ledger-format
 * Compatibility shape for UIs expecting line-based transactions.
 */
exports.listLedgerAsTransactions = async function listLedgerAsTransactions(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;
    const match = baseMatchFromQuery(req.query);
    const [rows, total] = await Promise.all([
      FinancialJournalEntry.find(match)
        .sort({ date: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      FinancialJournalEntry.countDocuments(match),
    ]);
    const data = rows.map(mapJournalToLegacyShape);
    return res.json({ success: true, data, meta: { page, limit, total } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * GET /api/statements/accounts/:accountCode/transactions
 * Query: startDate,endDate,page,limit,isVoided=true|false
 */
exports.listAccountTransactions = async function listAccountTransactions(req, res) {
  try {
    const code = String(req.params.accountCode || '').trim();
    if (!code) return res.status(400).json({ success: false, error: 'accountCode is required' });
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const skip = (page - 1) * limit;
    const match = baseMatchFromQuery(req.query);
    if (req.query.isVoided !== undefined) {
      match.isVoided = String(req.query.isVoided).toLowerCase() === 'true';
    }
    match['entries.accountCode'] = code;

    const pipeline = [
      { $match: match },
      { $unwind: '$entries' },
      { $match: { 'entries.accountCode': code } },
      { $sort: { date: -1, createdAt: -1 } },
      {
        $project: {
          _id: 1,
          date: 1,
          journalId: 1,
          publicTransactionId: 1,
          transactionType: 1,
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
      { $match: { 'entries.accountCode': code } },
      { $count: 'n' },
    ];
    const [data, countRows] = await Promise.all([
      FinancialJournalEntry.aggregate(pipeline),
      FinancialJournalEntry.aggregate(countPipeline),
    ]);
    const total = countRows[0]?.n || 0;
    return res.json({ success: true, data, meta: { page, limit, total, accountCode: code } });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};
