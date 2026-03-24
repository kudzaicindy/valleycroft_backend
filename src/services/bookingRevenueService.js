/**
 * When a booking is confirmed: create Debtor (amount owed), income Transaction, and AUTO journal
 * (Dr Accounts Receivable, Cr revenue). Reverses on cancel after confirmation.
 * Statements driven by Transaction + Debtor stay aligned.
 */
const Debtor = require('../models/Debtor');
const Transaction = require('../models/Transaction');
const transactionJournalService = require('./transactionJournalService');
const guestReceivableAccountService = require('./guestReceivableAccountService');

function debtorStatusFor(amountOwed, amountPaid) {
  const owed = Number(amountOwed) || 0;
  const paid = Number(amountPaid) || 0;
  if (paid <= 0) return 'outstanding';
  if (paid >= owed) return 'paid';
  return 'partial';
}

/**
 * @param {import('mongoose').Document} gb - GuestBooking mongoose doc
 * @param {import('mongoose').Types.ObjectId} userId
 */
async function onGuestBookingConfirmed(gb, userId) {
  if (gb.status !== 'confirmed') return { skipped: true, reason: 'not_confirmed' };
  if (gb.revenueTransactionId) return { skipped: true, reason: 'already_recorded' };

  const total = Number(gb.totalAmount) || 0;
  if (total <= 0) return { skipped: true, reason: 'no_amount' };

  const deposit = Math.min(Number(gb.deposit) || 0, total);

  const arAcc = await guestReceivableAccountService.ensureForGuestBooking(gb, userId);

  const debtor = await Debtor.create({
    name: gb.guestName,
    contactEmail: gb.guestEmail,
    contactPhone: gb.guestPhone,
    description: `Guest booking ${gb.trackingCode}`,
    amountOwed: total,
    amountPaid: deposit,
    status: debtorStatusFor(total, deposit),
    guestBookingRef: gb._id,
    receivableAccountId: arAcc._id,
    createdBy: userId,
  });

  const tx = await Transaction.create({
    type: 'income',
    category: 'booking',
    amount: total,
    date: new Date(),
    description: `Confirmed guest booking — ${gb.guestName} (${gb.trackingCode})`,
    reference: gb.trackingCode,
    guestBooking: gb._id,
    source: 'guest_booking_confirm',
    revenueRecognition: 'accrual_ar',
    receivableAccountCode: arAcc.code,
    createdBy: userId,
  });

  try {
    const entryId = await transactionJournalService.postJournalForTransaction(tx, userId);
    tx.journalEntryId = entryId;
    await tx.save();
  } catch (err) {
    await Transaction.findByIdAndDelete(tx._id);
    await Debtor.findByIdAndDelete(debtor._id);
    await guestReceivableAccountService.deactivateForGuestBooking(gb);
    throw err;
  }

  gb.debtorId = debtor._id;
  gb.revenueTransactionId = tx._id;
  await gb.save();

  return { debtorId: debtor._id, transactionId: tx._id, journalEntryId: tx.journalEntryId };
}

/**
 * @param {import('mongoose').Document} b - internal Booking mongoose doc
 * @param {import('mongoose').Types.ObjectId} userId
 */
async function onInternalBookingConfirmed(b, userId) {
  if (b.status !== 'confirmed') return { skipped: true, reason: 'not_confirmed' };
  if (b.revenueTransactionId) return { skipped: true, reason: 'already_recorded' };

  const total = Number(b.amount) || 0;
  if (total <= 0) return { skipped: true, reason: 'no_amount' };

  const deposit = Math.min(Number(b.deposit) || 0, total);
  const category = b.type === 'event' ? 'event' : 'booking';

  const arAcc = await guestReceivableAccountService.ensureForInternalBooking(b, userId);

  const debtor = await Debtor.create({
    name: b.guestName,
    contactEmail: b.guestEmail,
    contactPhone: b.guestPhone,
    description: `Booking ${b.type} — ${b._id}`,
    amountOwed: total,
    amountPaid: deposit,
    status: debtorStatusFor(total, deposit),
    bookingRef: b._id,
    receivableAccountId: arAcc._id,
    createdBy: userId,
  });

  const tx = await Transaction.create({
    type: 'income',
    category,
    amount: total,
    date: new Date(),
    description: `Confirmed booking — ${b.guestName} (${b.type})`,
    booking: b._id,
    source: 'booking_confirm',
    revenueRecognition: 'accrual_ar',
    receivableAccountCode: arAcc.code,
    createdBy: userId,
  });

  try {
    const entryId = await transactionJournalService.postJournalForTransaction(tx, userId);
    tx.journalEntryId = entryId;
    await tx.save();
  } catch (err) {
    await Transaction.findByIdAndDelete(tx._id);
    await Debtor.findByIdAndDelete(debtor._id);
    await guestReceivableAccountService.deactivateForInternalBooking(b);
    throw err;
  }

  b.debtorId = debtor._id;
  b.revenueTransactionId = tx._id;
  await b.save();

  return { debtorId: debtor._id, transactionId: tx._id, journalEntryId: tx.journalEntryId };
}

async function reverseGuestBookingRevenue(gb, userId) {
  if (!gb.revenueTransactionId) return { skipped: true };
  const tx = await Transaction.findById(gb.revenueTransactionId);
  if (!tx) {
    gb.revenueTransactionId = undefined;
    gb.debtorId = undefined;
    await guestReceivableAccountService.deactivateForGuestBooking(gb, { skipSave: true });
    await gb.save();
    return { skipped: true };
  }
  if (tx.journalEntryId) {
    await transactionJournalService.voidJournalLinkedToTransaction(tx, userId, 'Guest booking cancelled');
  }
  await tx.deleteOne();
  if (gb.debtorId) {
    await Debtor.findByIdAndUpdate(gb.debtorId, {
      status: 'written-off',
      amountOwed: 0,
      amountPaid: 0,
      notes: 'Closed — guest booking cancelled',
    });
  }
  gb.revenueTransactionId = undefined;
  gb.debtorId = undefined;
  await guestReceivableAccountService.deactivateForGuestBooking(gb, { skipSave: true });
  await gb.save();
  return { reversed: true };
}

async function reverseInternalBookingRevenue(b, userId) {
  if (!b.revenueTransactionId) return { skipped: true };
  const tx = await Transaction.findById(b.revenueTransactionId);
  if (!tx) {
    b.revenueTransactionId = undefined;
    b.debtorId = undefined;
    await guestReceivableAccountService.deactivateForInternalBooking(b, { skipSave: true });
    await b.save();
    return { skipped: true };
  }
  if (tx.journalEntryId) {
    await transactionJournalService.voidJournalLinkedToTransaction(tx, userId, 'Booking cancelled');
  }
  await tx.deleteOne();
  if (b.debtorId) {
    await Debtor.findByIdAndUpdate(b.debtorId, {
      status: 'written-off',
      amountOwed: 0,
      amountPaid: 0,
      notes: 'Closed — booking cancelled',
    });
  }
  b.revenueTransactionId = undefined;
  b.debtorId = undefined;
  await guestReceivableAccountService.deactivateForInternalBooking(b, { skipSave: true });
  await b.save();
  return { reversed: true };
}

module.exports = {
  onGuestBookingConfirmed,
  onInternalBookingConfirmed,
  reverseGuestBookingRevenue,
  reverseInternalBookingRevenue,
};
