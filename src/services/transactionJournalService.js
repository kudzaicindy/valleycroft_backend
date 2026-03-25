/**
 * Maps legacy Transaction (income/expense + category) to double-entry journal lines.
 * Cash side defaults to Bank (1002). Run `npm run seed:accounting` first.
 */
const Account = require('../models/Account');
const ledgerService = require('./ledgerService');

const BANK = '1002';
/** Accounts Receivable — used when revenue is recognised on booking confirmation (accrual) */
const ACCOUNTS_RECEIVABLE = '1010';

function mapIncomeAccount(category) {
  const c = (category || '').toLowerCase();
  if (c === 'booking') return '4001'; // Sales Revenue
  if (c === 'event') return '4002'; // Service Revenue
  if (c === 'interest' || c === 'other_income') return '4010';
  return '4020'; // Other Income
}

function mapExpenseAccount(category) {
  const c = (category || '').toLowerCase();
  if (c === 'salary') return '6001';
  if (c === 'utilities') return '6003';
  if (c === 'marketing') return '6004';
  if (c === 'supplies') return '6005';
  if (c === 'supplier') return '6005';
  if (c === 'refund') return '4001'; // reduce revenue (cash refund to customer)
  if (c === 'booking') return '5001'; // treat as direct cost / COGS
  return '6005'; // Office Supplies default
}

function buildLines(tx) {
  const amt = Math.abs(Number(tx.amount));
  if (!amt || Number.isNaN(amt)) throw new Error('Transaction amount must be a positive number');

  const desc = (tx.description || tx.category || 'Transaction').slice(0, 200);

  if (tx.type === 'income') {
    const rev = mapIncomeAccount(tx.category);
    const useAr = tx.revenueRecognition === 'accrual_ar';
    const childAr = useAr && String(tx.receivableAccountCode || '').trim();
    const debitAccount = useAr ? childAr || ACCOUNTS_RECEIVABLE : BANK;
    const debitLabel = useAr
      ? childAr
        ? `Accounts receivable — ${childAr}`
        : 'Accounts receivable — booking'
      : 'Bank — receipt';
    return [
      { accountCode: debitAccount, debit: amt, description: debitLabel },
      { accountCode: rev, credit: amt, description: desc },
    ];
  }

  if (tx.type === 'expense') {
    const exp = mapExpenseAccount(tx.category);
    return [
      { accountCode: exp, debit: amt, description: desc },
      { accountCode: BANK, credit: amt, description: 'Bank — payment' },
    ];
  }

  throw new Error('Invalid transaction type');
}

/**
 * Resolve account codes to ids + names for embedding on Transaction.lines.
 * @param {Array<{ accountCode: string, debit?: number, credit?: number, description?: string }>} lineSpecs
 */
async function resolveLinesFromSpecs(lineSpecs) {
  const out = [];
  for (const l of lineSpecs) {
    const acc = await Account.findOne({ code: String(l.accountCode).trim() })
      .select('code name')
      .lean();
    if (!acc) throw new Error(`Unknown account code: ${l.accountCode}`);
    out.push({
      accountId: acc._id,
      accountCode: acc.code,
      accountName: acc.name,
      debit: Number(l.debit) || 0,
      credit: Number(l.credit) || 0,
      description: l.description || '',
    });
  }
  return out;
}

/**
 * Post AUTO journal for a saved transaction document.
 * @returns {Promise<{ entryId: import('mongoose').Types.ObjectId, lines: object[] }>}
 */
async function postJournalForTransaction(tx, userId) {
  const lineSpecs = buildLines(tx);
  const entryDate = tx.date ? new Date(tx.date) : new Date();
  const resolvedLines = await resolveLinesFromSpecs(lineSpecs);
  const { entryId } = await ledgerService.postEntry({
    entryDate,
    reference: `TX:${tx._id}`,
    description: `[AUTO] Transaction ${tx._id} — ${tx.type} / ${tx.category || 'general'}`,
    entryType: 'AUTO',
    lines: lineSpecs,
    createdBy: userId,
  });
  return { entryId, lines: resolvedLines };
}

async function voidJournalLinkedToTransaction(tx, userId, reason) {
  if (!tx.journalEntryId) return;
  await ledgerService.voidEntry(tx.journalEntryId.toString(), reason, userId);
}

module.exports = {
  buildLines,
  resolveLinesFromSpecs,
  postJournalForTransaction,
  voidJournalLinkedToTransaction,
  BANK,
  ACCOUNTS_RECEIVABLE,
};
