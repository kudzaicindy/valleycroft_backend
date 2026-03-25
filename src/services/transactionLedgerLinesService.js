const JournalEntry = require('../models/JournalEntry');
const Account = require('../models/Account');

function ledgerEntryFromEmbeddedLines(tx) {
  const lines = (tx.lines || []).map((l) => ({
    lineId: l._id ? String(l._id) : undefined,
    accountId: String(l.accountId),
    accountCode: l.accountCode || '—',
    accountName: l.accountName || '—',
    accountType: null,
    normalBalance: null,
    debit: Number(l.debit) || 0,
    credit: Number(l.credit) || 0,
    description: l.description || '',
  }));
  return {
    id: String(tx.journalEntryId),
    reference: `TX:${tx._id}`,
    description: `[AUTO] Transaction ${tx._id}`,
    entryDate: tx.date,
    status: 'POSTED',
    entryType: 'AUTO',
    lines,
  };
}

function mapJournalLines(je, accById) {
  return (je.lines || []).map((l) => {
    const acc = accById[String(l.accountId)];
    return {
      lineId: String(l._id),
      accountId: String(l.accountId),
      accountCode: acc?.code || '—',
      accountName: acc?.name || '—',
      accountType: acc?.type ?? null,
      normalBalance: acc?.normalBalance ?? null,
      debit: Number(l.debit) || 0,
      credit: Number(l.credit) || 0,
      description: l.description || '',
    };
  });
}

/**
 * Adds `ledgerEntry` to each lean transaction (or replaces on plain objects).
 * `ledgerEntry` is null when unposted or journal missing.
 * Uses embedded `tx.lines` when present to avoid an extra journal read.
 *
 * @param {Array<Record<string, unknown>>} rows
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function attachLedgerEntriesToTransactions(rows) {
  if (!rows?.length) return rows;

  const needJournalFetch = rows.filter(
    (t) => t.journalEntryId && (!Array.isArray(t.lines) || t.lines.length === 0)
  );
  const entryIds = [
    ...new Set(needJournalFetch.map((t) => String(t.journalEntryId))),
  ];

  let entryById = {};
  let accById = {};
  if (entryIds.length) {
    const entries = await JournalEntry.find({ _id: { $in: entryIds } }).lean();
    const accountIds = [
      ...new Set(
        entries.flatMap((e) => (e.lines || []).map((l) => String(l.accountId)))
      ),
    ];
    const accounts = await Account.find({ _id: { $in: accountIds } })
      .select('code name type normalBalance')
      .lean();
    accById = Object.fromEntries(accounts.map((a) => [String(a._id), a]));
    entryById = Object.fromEntries(entries.map((e) => [String(e._id), e]));
  }

  return rows.map((tx) => {
    if (!tx.journalEntryId) {
      return { ...tx, ledgerEntry: null };
    }
    if (Array.isArray(tx.lines) && tx.lines.length > 0) {
      return { ...tx, ledgerEntry: ledgerEntryFromEmbeddedLines(tx) };
    }
    const je = entryById[String(tx.journalEntryId)];
    if (!je) {
      return { ...tx, ledgerEntry: null };
    }
    return {
      ...tx,
      ledgerEntry: {
        id: String(je._id),
        reference: je.reference || null,
        description: je.description,
        entryDate: je.entryDate,
        status: je.status,
        entryType: je.entryType,
        lines: mapJournalLines(je, accById),
      },
    };
  });
}

module.exports = { attachLedgerEntriesToTransactions };
