/**
 * Revenue recognition for stays: only when status is **confirmed** (guest or internal booking).
 * Pending requests do not create Debtor, Transaction, v3 journal, or invoice — no P&L impact until confirm.
 * On confirm: **JE-01** via `financialGlPostingService` (DR 1010 / CR 4001 or 4002) — Chynae v3.0.
 * Control A/R **1010** only (no per-booking GL sub-accounts). On cancel after confirm: posts a **reversing**
 * journal (swapped Dr/Cr on the same accounts) then **voids** the original v3 header — see `postReversalThenVoidFinancialJournalV3`.
 */
const Debtor = require('../models/Debtor');
const Transaction = require('../models/Transaction');
const Invoice = require('../models/Invoice');
const transactionJournalService = require('./transactionJournalService');
const financialGlPostingService = require('./financialGlPostingService');
const guestReceivableAccountService = require('./guestReceivableAccountService');
const bookingInvoiceService = require('./bookingInvoiceService');
const { scheduleInvoiceDelivery } = require('./invoiceNotifyService');

function bookingRecognitionDate(doc) {
  const eventDate = doc?.eventDate ? new Date(doc.eventDate) : null;
  const checkIn = doc?.checkIn ? new Date(doc.checkIn) : null;
  const preferred = eventDate || checkIn;
  if (preferred && !Number.isNaN(preferred.getTime())) return preferred;
  return new Date();
}

async function voidInvoiceLinkedToBooking(bookingDoc) {
  let invId = bookingDoc.invoiceId;
  if (!invId && bookingDoc.debtorId) {
    const d = await Debtor.findById(bookingDoc.debtorId).select('invoiceRef').lean();
    invId = d?.invoiceRef;
  }
  if (invId) await Invoice.findByIdAndUpdate(invId, { status: 'void' });
}

function debtorStatusFor(amountOwed, amountPaid) {
  const owed = Number(amountOwed) || 0;
  const paid = Number(amountPaid) || 0;
  if (paid <= 0) return 'outstanding';
  if (paid >= owed) return 'paid';
  return 'partial';
}

/** Plain invoice fields for async email (avoids Mongoose subdoc / buffer issues in setImmediate). */
function buildInvoiceEmailFields(invoice, stayTotal, deposit) {
  const o =
    invoice && typeof invoice.toObject === 'function'
      ? invoice.toObject({ flattenMaps: true })
      : invoice || {};
  const lineItems = (o.lineItems || []).map((li) => ({
    description: li.description,
    qty: li.qty,
    unitPrice: li.unitPrice,
    total: li.total,
  }));
  const tot = Number(o.total);
  return {
    invoiceNumber: o.invoiceNumber,
    total: Number.isFinite(tot) ? tot : stayTotal,
    deposit,
    balanceDue: Math.max(0, stayTotal - deposit),
    notes: o.notes,
    dueDate: o.dueDate,
    lineItems,
  };
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
  const recognitionDate = bookingRecognitionDate(gb);

  const arAcc = await guestReceivableAccountService.ensureControlAccountsReceivable(userId);
  gb.receivableAccountId = arAcc._id;
  await gb.save();

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
    date: recognitionDate,
    description: `Confirmed guest booking — ${gb.guestName} (${gb.trackingCode})`,
    reference: gb.trackingCode,
    guestBooking: gb._id,
    source: 'guest_booking_confirm',
    revenueRecognition: 'accrual_ar',
    receivableAccountCode: arAcc.code,
    createdBy: userId,
  });

  try {
    const je = await financialGlPostingService.postGuestBookingRevenueV3(gb, userId, { journalDate: recognitionDate });
    tx.financialJournalEntryId = je._id;
    await tx.save();
  } catch (err) {
    await Transaction.findByIdAndDelete(tx._id);
    await Debtor.findByIdAndDelete(debtor._id);
    await guestReceivableAccountService.deactivateForGuestBooking(gb, { skipSave: true });
    gb.receivableAccountId = undefined;
    await gb.save();
    throw err;
  }

  let invoice;
  try {
    invoice = await bookingInvoiceService.createInvoiceForConfirmedGuestBooking(gb, debtor, userId);
  } catch (err) {
    await financialGlPostingService.voidFinancialJournalEntry(tx.financialJournalEntryId, userId, 'Invoice creation failed');
    await Transaction.findByIdAndDelete(tx._id);
    await Debtor.findByIdAndDelete(debtor._id);
    await guestReceivableAccountService.deactivateForGuestBooking(gb, { skipSave: true });
    gb.receivableAccountId = undefined;
    await gb.save();
    throw err;
  }

  gb.debtorId = debtor._id;
  gb.revenueTransactionId = tx._id;
  gb.invoiceId = invoice._id;
  await gb.save();

  const stayTotal = Number(gb.totalAmount) || 0;
  const dep = Math.min(Number(gb.deposit) || 0, stayTotal);
  scheduleInvoiceDelivery({
    guestName: gb.guestName,
    email: gb.guestEmail,
    phone: gb.guestPhone,
    ...buildInvoiceEmailFields(invoice, stayTotal, dep),
    trackingCode: gb.trackingCode,
    relatedModel: 'GuestBooking',
    relatedId: gb._id,
  });

  return {
    debtorId: debtor._id,
    transactionId: tx._id,
    financialJournalEntryId: tx.financialJournalEntryId,
    invoiceId: invoice._id,
  };
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
  const recognitionDate = bookingRecognitionDate(b);

  const arAcc = await guestReceivableAccountService.ensureControlAccountsReceivable(userId);
  b.receivableAccountId = arAcc._id;
  await b.save();

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
    date: recognitionDate,
    description: `Confirmed booking — ${b.guestName} (${b.type})`,
    booking: b._id,
    source: 'booking_confirm',
    revenueRecognition: 'accrual_ar',
    receivableAccountCode: arAcc.code,
    createdBy: userId,
  });

  try {
    const je = await financialGlPostingService.postInternalBookingRevenueV3(b, userId, { journalDate: recognitionDate });
    tx.financialJournalEntryId = je._id;
    await tx.save();
  } catch (err) {
    await Transaction.findByIdAndDelete(tx._id);
    await Debtor.findByIdAndDelete(debtor._id);
    await guestReceivableAccountService.deactivateForInternalBooking(b, { skipSave: true });
    b.receivableAccountId = undefined;
    await b.save();
    throw err;
  }

  let invoice;
  try {
    invoice = await bookingInvoiceService.createInvoiceForConfirmedInternalBooking(b, debtor, userId);
  } catch (err) {
    await financialGlPostingService.voidFinancialJournalEntry(tx.financialJournalEntryId, userId, 'Invoice creation failed');
    await Transaction.findByIdAndDelete(tx._id);
    await Debtor.findByIdAndDelete(debtor._id);
    await guestReceivableAccountService.deactivateForInternalBooking(b, { skipSave: true });
    b.receivableAccountId = undefined;
    await b.save();
    throw err;
  }

  b.debtorId = debtor._id;
  b.revenueTransactionId = tx._id;
  b.invoiceId = invoice._id;
  await b.save();

  scheduleInvoiceDelivery({
    guestName: b.guestName,
    email: b.guestEmail,
    phone: b.guestPhone,
    ...buildInvoiceEmailFields(invoice, total, deposit),
    trackingCode: undefined,
    relatedModel: 'Booking',
    relatedId: b._id,
  });

  return {
    debtorId: debtor._id,
    transactionId: tx._id,
    financialJournalEntryId: tx.financialJournalEntryId,
    invoiceId: invoice._id,
  };
}

async function reverseGuestBookingRevenue(gb, userId) {
  if (!gb.revenueTransactionId) return { skipped: true };
  const tx = await Transaction.findById(gb.revenueTransactionId);
  if (!tx) {
    await voidInvoiceLinkedToBooking(gb);
    gb.revenueTransactionId = undefined;
    gb.debtorId = undefined;
    gb.invoiceId = undefined;
    await guestReceivableAccountService.deactivateForGuestBooking(gb, { skipSave: true });
    await gb.save();
    return { skipped: true };
  }
  if (tx.financialJournalEntryId) {
    await financialGlPostingService.postReversalThenVoidFinancialJournalV3(
      tx.financialJournalEntryId,
      userId,
      { voidReason: 'Guest booking cancelled' }
    );
  }
  if (tx.journalEntryId) {
    await transactionJournalService.voidJournalLinkedToTransaction(tx, userId, 'Guest booking cancelled');
  }
  await voidInvoiceLinkedToBooking(gb);
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
  gb.invoiceId = undefined;
  await guestReceivableAccountService.deactivateForGuestBooking(gb, { skipSave: true });
  await gb.save();
  return { reversed: true };
}

async function reverseInternalBookingRevenue(b, userId) {
  if (!b.revenueTransactionId) return { skipped: true };
  const tx = await Transaction.findById(b.revenueTransactionId);
  if (!tx) {
    await voidInvoiceLinkedToBooking(b);
    b.revenueTransactionId = undefined;
    b.debtorId = undefined;
    b.invoiceId = undefined;
    await guestReceivableAccountService.deactivateForInternalBooking(b, { skipSave: true });
    await b.save();
    return { skipped: true };
  }
  if (tx.financialJournalEntryId) {
    await financialGlPostingService.postReversalThenVoidFinancialJournalV3(
      tx.financialJournalEntryId,
      userId,
      { voidReason: 'Booking cancelled' }
    );
  }
  if (tx.journalEntryId) {
    await transactionJournalService.voidJournalLinkedToTransaction(tx, userId, 'Booking cancelled');
  }
  await voidInvoiceLinkedToBooking(b);
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
  b.invoiceId = undefined;
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
