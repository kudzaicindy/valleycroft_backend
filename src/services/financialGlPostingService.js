/**
 * Valley Croft v3.0 GL postings (Chynae Digital Solutions architecture).
 * Uses control account 1010 for guest A/R per COA — not per-booking sub-accounts.
 */
const { CHART_OF_ACCOUNTS_V3 } = require('../constants/chartOfAccountsV3');
const { createFinancialJournalEntry } = require('../utils/financialJournal');
const FinancialJournalEntry = require('../models/FinancialJournalEntry');
const { round2 } = require('../utils/math');

function coaMeta(code) {
  const n = Number(code);
  const meta = CHART_OF_ACCOUNTS_V3[n];
  if (!meta || typeof meta !== 'object') throw new Error(`Unknown COA code: ${code}`);
  const name = meta.name;
  const accountType = meta.accountType;
  if (!name || !accountType) throw new Error(`Invalid COA meta for code: ${code}`);
  return { name, accountType };
}

function glLine(accountCode, side, amount) {
  const { name, accountType } = coaMeta(accountCode);
  return {
    accountCode: String(accountCode),
    accountName: name,
    accountType,
    side,
    amount: round2(amount),
  };
}

/**
 * JE-01 — Guest BnB booking confirmed (DR 1010 / CR 4001).
 * @param {{ journalDate?: Date|string }} [options] - optional GL date (defaults to now); use for backfills aligned to `Transaction.date`.
 */
async function postGuestBookingRevenueV3(guestBookingDoc, userId, options = {}) {
  const total = round2(Number(guestBookingDoc.totalAmount) || 0);
  if (total <= 0) throw new Error('Booking total must be positive for revenue recognition');

  const desc = `BnB Revenue — ${guestBookingDoc.guestName} (${guestBookingDoc.trackingCode || guestBookingDoc._id})`;
  const journalDate =
    options.journalDate != null && options.journalDate !== ''
      ? new Date(options.journalDate)
      : new Date();

  return createFinancialJournalEntry(
    {
      transactionType: 'booking_revenue',
      date: journalDate,
      description: desc,
      reference: guestBookingDoc.trackingCode || undefined,
      bookingRef: guestBookingDoc._id,
      createdBy: userId,
    },
    [glLine(1010, 'DR', total), glLine(4001, 'CR', total)]
  );
}

/**
 * JE-01 variant — internal booking confirmed (event → 4002, else 4001).
 * @param {{ journalDate?: Date|string }} [options] - optional GL date (defaults to now).
 */
async function postInternalBookingRevenueV3(bookingDoc, userId, options = {}) {
  const total = round2(Number(bookingDoc.amount) || 0);
  if (total <= 0) throw new Error('Booking amount must be positive for revenue recognition');

  const isEvent = String(bookingDoc.type || '').toLowerCase() === 'event';
  const revCode = isEvent ? 4002 : 4001;
  const txType = isEvent ? 'event_revenue' : 'booking_revenue';
  const desc = `${isEvent ? 'Event' : 'BnB'} Revenue — ${bookingDoc.guestName}`;
  const journalDate =
    options.journalDate != null && options.journalDate !== ''
      ? new Date(options.journalDate)
      : new Date();

  return createFinancialJournalEntry(
    {
      transactionType: txType,
      date: journalDate,
      description: desc,
      internalBookingRef: bookingDoc._id,
      createdBy: userId,
    },
    [glLine(1010, 'DR', total), glLine(revCode, 'CR', total)]
  );
}

async function voidFinancialJournalEntry(journalEntryId, userId, reason) {
  if (!journalEntryId) return { skipped: true };
  const doc = await FinancialJournalEntry.findById(journalEntryId);
  if (!doc) return { skipped: true };
  if (doc.isVoided) return { skipped: true, reason: 'already_voided' };
  doc.isVoided = true;
  doc.voidedBy = userId;
  doc.voidedAt = new Date();
  doc.voidReason = reason || 'Voided';
  await doc.save();
  return { voided: true };
}

/**
 * Build opposite Dr/Cr lines from an embedded-entries journal (works for any account codes on the original).
 */
function linesFromReversedEntries(origEntries, lineDescriptionPrefix) {
  const lines = [];
  for (const e of origEntries || []) {
    const d = round2(Number(e.debit) || 0);
    const c = round2(Number(e.credit) || 0);
    const baseDesc = (e.description && String(e.description).trim()) || '';
    const desc = lineDescriptionPrefix
      ? `${lineDescriptionPrefix}${baseDesc ? ` — ${baseDesc}` : ''}`
      : baseDesc;
    if (d > 0) {
      lines.push({
        accountCode: String(e.accountCode),
        accountName: e.accountName,
        accountType: e.accountType,
        side: 'CR',
        amount: d,
        description: desc,
      });
    }
    if (c > 0) {
      lines.push({
        accountCode: String(e.accountCode),
        accountName: e.accountName,
        accountType: e.accountType,
        side: 'DR',
        amount: c,
        description: desc,
      });
    }
  }
  return lines;
}

/**
 * After a confirmed booking is cancelled: post a reversing journal (swapped Dr/Cr), then void the original.
 * Statements exclude voided journals; the active reversal carries the period adjustment. If the original has
 * no embedded `entries` (legacy), only voids — run `npm run migrate:embed-journal-entries` for a full audit trail.
 *
 * @param {import('mongoose').Types.ObjectId|string} originalJournalEntryId
 * @param {import('mongoose').Types.ObjectId} userId
 * @param {{ voidReason?: string, reversalDate?: Date|string, description?: string }} [opts]
 */
async function postReversalThenVoidFinancialJournalV3(originalJournalEntryId, userId, opts = {}) {
  if (!originalJournalEntryId) return { skipped: true };
  const orig = await FinancialJournalEntry.findById(originalJournalEntryId).lean();
  if (!orig) return { skipped: true, reason: 'not_found' };
  if (orig.isVoided) return { skipped: true, reason: 'already_voided' };

  let reversalJournalEntryId;
  const entries = orig.entries || [];
  if (entries.length >= 2) {
    const revLines = linesFromReversedEntries(entries, 'Reversal');
    const reversalDate =
      opts.reversalDate != null && opts.reversalDate !== '' ? new Date(opts.reversalDate) : new Date();
    const reversal = await createFinancialJournalEntry(
      {
        transactionType: 'booking_revenue_reversal',
        date: reversalDate,
        description:
          opts.description ||
          `Booking cancelled — reversal of ${orig.journalId || orig.publicTransactionId || orig._id}`,
        reference: orig.reference,
        bookingRef: orig.bookingRef,
        internalBookingRef: orig.internalBookingRef,
        reversesFinancialJournalEntryId: orig._id,
        createdBy: userId,
      },
      revLines
    );
    reversalJournalEntryId = reversal._id;
  }

  await voidFinancialJournalEntry(originalJournalEntryId, userId, opts.voidReason || 'Booking cancelled');
  return { voided: true, reversalJournalEntryId };
}

module.exports = {
  glLine,
  postGuestBookingRevenueV3,
  postInternalBookingRevenueV3,
  voidFinancialJournalEntry,
  postReversalThenVoidFinancialJournalV3,
  linesFromReversedEntries,
};
