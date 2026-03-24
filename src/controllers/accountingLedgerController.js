const ledgerService = require('../services/ledgerService');

function toTitleCase(value) {
  const s = String(value || '').toLowerCase();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

/**
 * GET /api/accounting/ledger and GET /api/statements/ledger
 * Query: startDate, endDate (YYYY-MM-DD), status (POSTED|VOIDED|all|comma list), entryType, page, limit
 */
exports.listGeneralLedger = async function listGeneralLedger(req, res) {
  try {
    const { startDate, endDate, status, entryType, page, limit } = req.query;
    const result = await ledgerService.listJournalEntries({
      startDate,
      endDate,
      status: status || 'POSTED',
      entryType,
      page,
      limit,
    });
    res.json({ success: true, data: result.data, meta: result.meta });
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
    const { startDate, endDate, status, entryType, page, limit } = req.query;
    const result = await ledgerService.listJournalEntries({
      startDate,
      endDate,
      status: status || 'POSTED',
      entryType,
      page,
      limit,
    });

    const data = result.data.map((j) => {
      const totalDebit = (j.lines || []).reduce((s, l) => s + (Number(l.debit) || 0), 0);
      const totalCredit = (j.lines || []).reduce((s, l) => s + (Number(l.credit) || 0), 0);
      return {
        _id: j._id,
        transactionId: j.reference || `JE-${j._id}`,
        date: j.entryDate,
        description: j.description,
        reference: j.reference || null,
        entries: (j.lines || []).map((l) => ({
          _id: l._id,
          accountCode: l.account?.code || null,
          accountName: l.account?.name || null,
          accountType: toTitleCase(l.account?.type),
          debit: Number(l.debit) || 0,
          credit: Number(l.credit) || 0,
          description: l.description || '',
        })),
        totalDebit: Number(totalDebit.toFixed(2)),
        totalCredit: Number(totalCredit.toFixed(2)),
        source: (j.entryType || '').toLowerCase(),
        sourceId: null,
        sourceModel: 'JournalEntry',
        residence: null,
        createdBy: j.createdBy || null,
        approvedBy: null,
        approvedAt: null,
        status: (j.status || '').toLowerCase(),
        metadata: {
          createdAt: j.createdAt,
          updatedAt: j.updatedAt,
        },
      };
    });

    return res.json({ success: true, data, meta: result.meta });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};
