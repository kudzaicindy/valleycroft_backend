const FinancialJournalEntry = require('../models/FinancialJournalEntry');
const { createFinancialJournalEntry } = require('../utils/financialJournal');
const {
  getIncomeStatementV3,
  getCashFlowV3,
  getBalanceSheetV3,
  shapeBalanceSheetPresentationV3,
  shapeIncomeStatementPresentationV7,
  accountingDisclosureIncomeStatement,
  accountingDisclosureBalanceSheet,
} = require('../services/financialStatementsV3Service');
const logAudit = require('../utils/audit');

function journalLinesFromBody(body) {
  const { lines, entries } = body || {};
  if (Array.isArray(lines) && lines.length) return lines;
  if (!Array.isArray(entries) || !entries.length) return null;
  return entries.map((e) => {
    const at = String(e.accountType || '').toLowerCase();
    const d = Number(e.debit) || 0;
    const c = Number(e.credit) || 0;
    if (d > 0 && c > 0) throw new Error('Each journal line must have only debit or credit, not both');
    if (d > 0) {
      return {
        accountCode: e.accountCode,
        accountName: e.accountName,
        accountType: at,
        side: 'DR',
        amount: d,
        description: e.description,
      };
    }
    if (c > 0) {
      return {
        accountCode: e.accountCode,
        accountName: e.accountName,
        accountType: at,
        side: 'CR',
        amount: c,
        description: e.description,
      };
    }
    throw new Error('Each journal entry line must have a debit or a credit');
  });
}

exports.postJournalV3 = async (req, res) => {
  try {
    const { entry } = req.body || {};
    const lines = journalLinesFromBody(req.body || {});
    if (!entry || !lines) {
      return res.status(400).json({
        success: false,
        error: 'Body must include { entry } and either { lines } (side+amount) or { entries } (debit/credit)',
      });
    }
    const { entries: _drop, ...entryRest } = entry;
    const je = await createFinancialJournalEntry(
      {
        ...entryRest,
        createdBy: req.user._id,
      },
      lines
    );
    await logAudit({
      userId: req.user._id,
      role: req.user.role,
      action: 'create',
      entity: 'FinancialJournalEntry',
      entityId: je._id,
      req,
    });
    res.status(201).json({ success: true, data: je });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
};

exports.voidJournalV3 = async (req, res) => {
  try {
    const { voidReason } = req.body || {};
    const doc = await FinancialJournalEntry.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, error: 'Journal entry not found' });
    if (doc.isVoided) return res.status(400).json({ success: false, error: 'Already voided' });

    doc.isVoided = true;
    doc.voidedBy = req.user._id;
    doc.voidedAt = new Date();
    doc.voidReason = voidReason || 'Voided';
    await doc.save();

    await logAudit({
      userId: req.user._id,
      role: req.user.role,
      action: 'update',
      entity: 'FinancialJournalEntry',
      entityId: doc._id,
      req,
    });
    res.json({ success: true, data: doc });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
};

exports.getIncomeStatementV3 = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, error: 'startDate and endDate are required' });
    }
    const core = await getIncomeStatementV3(startDate, endDate);
    const data = {
      accounting: accountingDisclosureIncomeStatement(core.period),
      presentation: shapeIncomeStatementPresentationV7(core),
      ...core,
    };
    res.json({ success: true, basis: 'double_entry_v3', data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.getCashFlowV3 = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, error: 'startDate and endDate are required' });
    }
    const data = await getCashFlowV3(startDate, endDate);
    res.json({ success: true, basis: 'double_entry_v3', data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.getBalanceSheetV3 = async (req, res) => {
  try {
    const asAt = req.query.asAt || req.query.asOf || new Date().toISOString();
    const core = await getBalanceSheetV3(asAt);
    const data = {
      accounting: accountingDisclosureBalanceSheet(core.asAt),
      presentation: shapeBalanceSheetPresentationV3(core),
      ...core,
    };
    res.json({ success: true, basis: 'double_entry_v3', data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.listJournalEntriesV3 = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const skip = (page - 1) * limit;
    const q = {};
    if (req.query.isVoided !== undefined) {
      q.isVoided = String(req.query.isVoided).toLowerCase() === 'true';
    }
    if (req.query.transactionType) q.transactionType = req.query.transactionType;

    const [data, total] = await Promise.all([
      FinancialJournalEntry.find(q).sort({ date: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      FinancialJournalEntry.countDocuments(q),
    ]);
    res.json({ success: true, data, meta: { page, limit, total } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

exports.getJournalWithLinesV3 = async (req, res) => {
  try {
    const je = await FinancialJournalEntry.findById(req.params.id).lean();
    if (!je) return res.status(404).json({ success: false, error: 'Not found' });
    const entries = (je.entries || []).slice().sort((a, b) => String(a.accountCode).localeCompare(String(b.accountCode)));
    res.json({ success: true, data: { journal: je, entries, lines: entries } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
