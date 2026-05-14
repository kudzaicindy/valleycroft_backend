/**
 * Maps Transaction (income/expense + category) to v3 double-entry journal lines.
 * Cash side defaults to Cash / Bank (1001) per Chynae v3.0. Run `npm run seed:chart-v3` first.
 * Source of truth is v3 `financial_journal_entries`.
 */
const Account = require('../models/Account');
const { CHART_OF_ACCOUNTS_V3 } = require('../constants/chartOfAccountsV3');
const { createFinancialJournalEntry } = require('../utils/financialJournal');
const financialGlPostingService = require('./financialGlPostingService');
const { round2 } = require('../utils/math');

const BANK = '1001';
/** Accounts Receivable — used when revenue is recognised on booking confirmation (accrual) */
const ACCOUNTS_RECEIVABLE = '1010';

function cleanAccountCode(value) {
  if (value == null) return '';
  return String(value).trim();
}

function mapIncomeAccount(category) {
  const c = (category || '').toLowerCase();
  if (c === 'booking') return '4001';
  if (c === 'event') return '4002';
  if (c === 'interest' || c === 'other_income') return '4003';
  return '4003';
}

/** Owner capital contribution — not P&L revenue; Dr cash, Cr equity (3001). */
function isOwnerCapitalIncomeCategory(category) {
  const c = (category || '').toLowerCase();
  return c === 'owner_investment' || c === 'capital_injection';
}

function mapExpenseAccount(category) {
  const c = (category || '').toLowerCase();
  if (c === 'salary') return '6001';
  if (c === 'utilities') return '6020';
  if (c === 'marketing') return '6022';
  if (c === 'supplies') return '5001';
  if (c === 'supplier') return '6013';
  if (c === 'refund') return '4010';
  if (c === 'booking') return '5001';
  if (c === 'fixed_asset' || c === 'capex' || c === 'equipment_purchase' || c === 'equipment') return '1100';
  return '6013';
}

function buildLines(tx, options = {}) {
  const amt = Math.abs(Number(tx.amount));
  if (!amt || Number.isNaN(amt)) throw new Error('Transaction amount must be a positive number');

  const desc = (tx.description || tx.category || 'Transaction').slice(0, 200);
  const explicitDebit = cleanAccountCode(options.debitAccount || tx.debitAccount);
  const explicitCredit = cleanAccountCode(options.creditAccount || tx.creditAccount);

  if (tx.type === 'income') {
    if (isOwnerCapitalIncomeCategory(tx.category)) {
      const debitAccount = explicitDebit || BANK;
      const creditAccount = explicitCredit || '3001';
      return [
        { accountCode: debitAccount, debit: amt, description: 'Bank — owner capital contribution' },
        { accountCode: creditAccount, credit: amt, description: desc },
      ];
    }
    const rev = mapIncomeAccount(tx.category);
    const useAr = tx.revenueRecognition === 'accrual_ar';
    const childAr = useAr && String(tx.receivableAccountCode || '').trim();
    const debitAccount = explicitDebit || (useAr ? childAr || ACCOUNTS_RECEIVABLE : BANK);
    const creditAccount = explicitCredit || rev;
    const debitLabel = useAr
      ? childAr
        ? `Accounts receivable — ${childAr}`
        : 'Accounts receivable — booking'
      : 'Bank — receipt';
    return [
      { accountCode: debitAccount, debit: amt, description: debitLabel },
      { accountCode: creditAccount, credit: amt, description: desc },
    ];
  }

  if (tx.type === 'expense') {
    const exp = mapExpenseAccount(tx.category);
    const debitAccount = explicitDebit || exp;
    const creditAccount = explicitCredit || BANK;
    return [
      { accountCode: debitAccount, debit: amt, description: desc },
      { accountCode: creditAccount, credit: amt, description: 'Bank — payment' },
    ];
  }

  throw new Error('Invalid transaction type');
}

function v3TransactionTypeForManual(tx) {
  if (tx.type === 'income') {
    if (isOwnerCapitalIncomeCategory(tx.category)) return 'owner_investment';
    if (tx.revenueRecognition === 'accrual_ar') return 'booking_revenue';
    return 'other_income';
  }
  const c = (tx.category || '').toLowerCase();
  if (c === 'salary') return 'salary_payment';
  if (c === 'utilities') return 'utility_payment';
  if (c === 'supplier') return 'supplier_payment';
  if (c === 'supplies') return 'consumables_purchase';
  if (c === 'refund') return 'refund_issued';
  if (c === 'marketing') return 'other_expense';
  if (c === 'booking') return 'consumables_purchase';
  if (c === 'fixed_asset' || c === 'capex' || c === 'equipment_purchase' || c === 'equipment') return 'equipment_purchase';
  return 'other_expense';
}

/**
 * Build v3 GL line payloads (balanced DR/CR) matching `buildLines` account codes.
 */
async function buildV3LinesFromSpecs(lineSpecs) {
  const out = [];
  for (const spec of lineSpecs) {
    const debit = Number(spec.debit) || 0;
    const credit = Number(spec.credit) || 0;
    const codeStr = String(spec.accountCode).trim();
    const n = Number(codeStr);
    if (debit > 0) {
      if (!Number.isNaN(n) && n > 0 && CHART_OF_ACCOUNTS_V3[n]) {
        out.push(financialGlPostingService.glLine(n, 'DR', debit));
      } else {
        const acc = await Account.findOne({ code: codeStr }).select('name type').lean();
        if (!acc) throw new Error(`Unknown account code for v3 GL: ${codeStr}`);
        out.push({
          accountCode: codeStr,
          accountName: acc.name,
          accountType: String(acc.type).toLowerCase(),
          side: 'DR',
          amount: round2(debit),
        });
      }
    }
    if (credit > 0) {
      if (!Number.isNaN(n) && n > 0 && CHART_OF_ACCOUNTS_V3[n]) {
        out.push(financialGlPostingService.glLine(n, 'CR', credit));
      } else {
        const acc = await Account.findOne({ code: codeStr }).select('name type').lean();
        if (!acc) throw new Error(`Unknown account code for v3 GL: ${codeStr}`);
        out.push({
          accountCode: codeStr,
          accountName: acc.name,
          accountType: String(acc.type).toLowerCase(),
          side: 'CR',
          amount: round2(credit),
        });
      }
    }
  }
  return out;
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
 * Post v3 AUTO journal for a saved transaction document.
 * @returns {Promise<{ lines: object[], financialJournalEntryId?: import('mongoose').Types.ObjectId }>}
 */
async function postJournalForTransaction(tx, userId, options = {}) {
  if (tx.financialJournalEntryId) {
    throw new Error(
      'This transaction already has a v3 journal (e.g. from booking confirmation). A second AUTO entry would double-count revenue.'
    );
  }
  const lineSpecs = buildLines(tx, options);
  const entryDate = tx.date ? new Date(tx.date) : new Date();
  const resolvedLines = await resolveLinesFromSpecs(lineSpecs);

  let financialJournalEntryId;
  const v3Lines = await buildV3LinesFromSpecs(lineSpecs);
  const je = await createFinancialJournalEntry(
    {
      transactionType: v3TransactionTypeForManual(tx),
      date: entryDate,
      description: `[AUTO] Transaction ${tx._id} — ${tx.type} / ${tx.category || 'general'}`,
      reference: `TX:${tx._id}`,
      createdBy: userId,
    },
    v3Lines
  );
  financialJournalEntryId = je._id;

  return { lines: resolvedLines, financialJournalEntryId };
}

async function voidJournalLinkedToTransaction(tx, userId, reason) {
  // Legacy journal collection is no longer used as source of truth.
  void tx;
  void userId;
  void reason;
}

async function voidFinancialJournalLinkedToTransaction(tx, userId, reason) {
  if (!tx.financialJournalEntryId) return;
  await financialGlPostingService.voidFinancialJournalEntry(tx.financialJournalEntryId, userId, reason);
}

/**
 * One-time backfill: v3 mirror only (no new legacy JournalEntry). For manual txs created before v3 mirroring.
 */
async function mirrorManualTransactionToV3Ledger(txDoc, userId) {
  if (String(txDoc.source || '') !== 'manual') return { skipped: true, reason: 'not_manual' };
  if (txDoc.financialJournalEntryId) return { skipped: true, reason: 'already_has_v3' };
  const lineSpecs = buildLines(txDoc);
  const entryDate = txDoc.date ? new Date(txDoc.date) : new Date();
  const v3Lines = await buildV3LinesFromSpecs(lineSpecs);
  const je = await createFinancialJournalEntry(
    {
      transactionType: v3TransactionTypeForManual(txDoc),
      date: entryDate,
      description: `[BACKFILL] Transaction ${txDoc._id} — ${txDoc.type} / ${txDoc.category || 'general'}`,
      reference: `TX:${txDoc._id}`,
      createdBy: userId,
    },
    v3Lines
  );
  return { financialJournalEntryId: je._id };
}

module.exports = {
  buildLines,
  resolveLinesFromSpecs,
  postJournalForTransaction,
  voidJournalLinkedToTransaction,
  voidFinancialJournalLinkedToTransaction,
  mirrorManualTransactionToV3Ledger,
  BANK,
  ACCOUNTS_RECEIVABLE,
};
