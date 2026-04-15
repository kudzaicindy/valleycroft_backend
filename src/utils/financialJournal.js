const mongoose = require('mongoose');
const FinancialJournalEntry = require('../models/FinancialJournalEntry');
const { round2 } = require('./math');

function validateFinancialJournalLines(lines) {
  if (!lines || lines.length < 2) {
    throw new Error('A journal entry requires at least two lines');
  }
  const dr = lines.filter((l) => l.side === 'DR').reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const cr = lines.filter((l) => l.side === 'CR').reduce((s, l) => s + (Number(l.amount) || 0), 0);
  if (Math.abs(dr - cr) > 0.001) {
    throw new Error(`Unbalanced journal entry: DR ${dr} ≠ CR ${cr}`);
  }
}

/**
 * @param {Object} entry - FinancialJournalEntry fields (transactionType, date, description, refs…)
 * @param {Array<{ accountCode, accountName, accountType, side, amount, description?: string }>} lines
 */
async function createFinancialJournalEntry(entry, lines) {
  validateFinancialJournalLines(lines);

  const entryDate = entry.date ? new Date(entry.date) : new Date();
  const { entries: _ignoreEmbedded, ...entrySafe } = entry || {};
  const embeddedEntries = lines.map((l) => {
    const amt = round2(Number(l.amount) || 0);
    const side = String(l.side || '').toUpperCase();
    return {
      accountCode: String(l.accountCode).trim(),
      accountName: l.accountName,
      accountType: l.accountType,
      debit: side === 'DR' ? amt : 0,
      credit: side === 'CR' ? amt : 0,
      description: (l.description != null && String(l.description).trim()) || '',
    };
  });

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const [je] = await FinancialJournalEntry.create(
      [
        {
          ...entrySafe,
          date: entryDate,
          entries: embeddedEntries,
        },
      ],
      { session }
    );
    await session.commitTransaction();
    return je;
  } catch (err) {
    await session.abortTransaction();
    throw err;
  } finally {
    session.endSession();
  }
}

module.exports = {
  createFinancialJournalEntry,
  validateFinancialJournalLines,
};
