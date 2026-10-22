/**
 * Record debtor payment + finance transaction + GL (shared by manual entry and PayFast ITN).
 */
const Debtor = require('../models/Debtor');
const DebtorPayment = require('../models/DebtorPayment');
const Transaction = require('../models/Transaction');
const Account = require('../models/Account');
const User = require('../models/User');
const financialGlPostingService = require('./financialGlPostingService');

function debtorStatusFor(owed, paid) {
  if (paid <= 0) return 'outstanding';
  if (paid >= owed) return 'paid';
  return 'partial';
}

async function syncInternalBookingPaidFromDebtor(debtorDoc, paidAt = new Date()) {
  const bookingId = debtorDoc?.bookingRef;
  if (!bookingId) return null;
  const owed = Number(debtorDoc.amountOwed) || 0;
  const paid = Number(debtorDoc.amountPaid) || 0;
  if (owed > 0 && paid + 0.009 < owed) return null;
  const Booking = require('../models/Booking');
  const booking = await Booking.findById(bookingId);
  if (!booking || booking.status === 'cancelled') return null;
  if (booking.paymentStatus === 'paid') return booking;
  booking.paymentStatus = 'paid';
  booking.paidAt = paidAt instanceof Date ? paidAt : new Date(paidAt);
  await booking.save();
  return booking;
}

async function syncInternalBookingUnpaidFromDebtor(debtorDoc) {
  const bookingId = debtorDoc?.bookingRef;
  if (!bookingId) return null;
  const owed = Number(debtorDoc.amountOwed) || 0;
  const paid = Number(debtorDoc.amountPaid) || 0;
  if (owed <= 0 || paid + 0.009 >= owed) return null;
  const Booking = require('../models/Booking');
  const booking = await Booking.findById(bookingId);
  if (!booking || booking.status === 'cancelled') return null;
  if (booking.paymentStatus !== 'paid') return booking;
  booking.paymentStatus = 'unpaid';
  booking.paidAt = undefined;
  await booking.save();
  return booking;
}

async function resolvePaymentActorUserId(preferredUserId) {
  if (preferredUserId) return preferredUserId;
  const admin = await User.findOne({ role: { $in: ['admin', 'finance'] } }).select('_id').lean();
  if (admin?._id) return admin._id;
  const any = await User.findOne().select('_id').lean();
  if (!any?._id) throw new Error('No user account found to attribute automated payment');
  return any._id;
}

/**
 * @param {import('mongoose').Types.ObjectId|string} debtorId
 * @param {{
 *   amount: number,
 *   paidAt?: Date,
 *   method?: string,
 *   reference?: string,
 *   note?: string,
 *   createdBy?: import('mongoose').Types.ObjectId,
 * }} opts
 */
async function recordDebtorPayment(debtorId, opts) {
  const debtor = await Debtor.findById(debtorId);
  if (!debtor) throw new Error('Debtor not found');

  const amount = Number(opts.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('amount must be a positive number');
  }

  const owed = Number(debtor.amountOwed) || 0;
  const paid = Number(debtor.amountPaid) || 0;
  const remaining = Math.max(0, owed - paid);
  if (amount > remaining + 0.009) {
    throw new Error(`Payment exceeds remaining balance (${remaining.toFixed(2)})`);
  }

  const actorId = await resolvePaymentActorUserId(opts.createdBy);
  const before = debtor.toObject();
  const paidAt = opts.paidAt ? new Date(opts.paidAt) : new Date();
  const method = String(opts.method || 'cash').trim().toLowerCase();
  const reference = opts.reference ? String(opts.reference).trim() : '';
  const note = opts.note ? String(opts.note).trim() : '';
  const amountPaidAfter = paid + amount;
  const remainingAfter = Math.max(0, owed - amountPaidAfter);

  let payment;
  let tx;
  let je;
  try {
    payment = await DebtorPayment.create({
      debtorId: debtor._id,
      bookingRef: debtor.bookingRef,
      guestBookingRef: debtor.guestBookingRef,
      amount,
      paidAt,
      method,
      reference,
      note,
      amountOwedBefore: owed,
      amountPaidBefore: paid,
      amountPaidAfter,
      remainingAfter,
      createdBy: actorId,
    });

    tx = await Transaction.create({
      type: 'income',
      category: 'booking_payment',
      amount,
      date: paidAt,
      description: `Payment received — ${debtor.name || 'Debtor'} (${method})`,
      reference: reference || `PAY:${payment._id}`,
      booking: debtor.bookingRef || undefined,
      guestBooking: debtor.guestBookingRef || undefined,
      source: 'debtor_payment',
      revenueRecognition: 'cash',
      createdBy: actorId,
    });

    const [bankAcc, arAcc] = await Promise.all([
      Account.findOne({ code: '1001' }).select('_id code name').lean(),
      Account.findOne({ code: '1010' }).select('_id code name').lean(),
    ]);
    if (!bankAcc || !arAcc) {
      throw new Error('Missing chart accounts for booking payment posting (1001 and/or 1010)');
    }

    je = await financialGlPostingService.postBookingPaymentAgainstArV3(debtor, amount, actorId, {
      journalDate: paidAt,
      reference: tx.reference,
    });

    tx.financialJournalEntryId = je._id;
    tx.lines = [
      {
        accountId: bankAcc._id,
        accountCode: bankAcc.code,
        accountName: bankAcc.name,
        debit: amount,
        credit: 0,
        description: 'Bank — booking payment received',
      },
      {
        accountId: arAcc._id,
        accountCode: arAcc.code,
        accountName: arAcc.name,
        debit: 0,
        credit: amount,
        description: 'Accounts receivable cleared',
      },
    ];
    await tx.save();

    payment.transactionId = tx._id;
    payment.financialJournalEntryId = je._id;
    await payment.save();

    debtor.amountPaid = amountPaidAfter;
    debtor.status = debtorStatusFor(owed, debtor.amountPaid);
    if (note) {
      const line = `[payment ${paidAt.toISOString()}] ${note}`;
      debtor.notes = debtor.notes ? `${debtor.notes}\n${line}` : line;
    }
    await debtor.save();
  } catch (err) {
    if (tx?._id) await Transaction.findByIdAndDelete(tx._id);
    if (payment?._id) await DebtorPayment.findByIdAndDelete(payment._id);
    debtor.amountPaid = paid;
    debtor.status = before.status;
    debtor.notes = before.notes;
    await debtor.save();
    throw err;
  }

  try {
    const { syncGuestBookingPaidFromDebtor } = require('./guestBookingPaymentService');
    await syncGuestBookingPaidFromDebtor(debtor, paidAt);
  } catch (err) {
    console.error('[debtor-payment] guest booking paid sync failed:', err?.message || err);
  }

  try {
    await syncInternalBookingPaidFromDebtor(debtor, paidAt);
  } catch (err) {
    console.error('[debtor-payment] internal booking paid sync failed:', err?.message || err);
  }

  return {
    debtor,
    payment,
    transaction: tx,
    financialJournalEntryId: je._id,
    meta: {
      paidNow: amount,
      remaining: Math.max(0, (Number(debtor.amountOwed) || 0) - (Number(debtor.amountPaid) || 0)),
    },
  };
}

/**
 * Delete a recorded debtor payment: reverse GL, remove finance transaction, restore balance.
 */
async function deleteDebtorPayment(debtorId, paymentId, opts = {}) {
  const debtor = await Debtor.findById(debtorId);
  if (!debtor) {
    const err = new Error('Debtor not found');
    err.statusCode = 404;
    throw err;
  }

  const payment = await DebtorPayment.findOne({ _id: paymentId, debtorId: debtor._id });
  if (!payment) {
    const err = new Error('Payment not found');
    err.statusCode = 404;
    throw err;
  }

  const actorId = await resolvePaymentActorUserId(opts.userId);
  const amount = Number(payment.amount) || 0;
  const beforePaid = Number(debtor.amountPaid) || 0;
  const afterPaid = Math.max(0, beforePaid - amount);
  const before = debtor.toObject();

  if (payment.financialJournalEntryId) {
    try {
      await financialGlPostingService.postReversalThenVoidFinancialJournalV3(
        payment.financialJournalEntryId,
        actorId,
        {
          voidReason: opts.reason || `Payment deleted (${payment.receiptNumber || payment._id})`,
          description: `Reverse booking payment — ${debtor.name || 'Debtor'}`,
        }
      );
    } catch (err) {
      // Fall back to void-only if reversal fails (legacy journals)
      await financialGlPostingService.voidFinancialJournalEntry(
        payment.financialJournalEntryId,
        actorId,
        opts.reason || `Payment deleted (${payment.receiptNumber || payment._id})`
      );
    }
  }

  if (payment.transactionId) {
    await Transaction.findByIdAndDelete(payment.transactionId);
  }

  await payment.deleteOne();

  debtor.amountPaid = afterPaid;
  debtor.status = debtorStatusFor(Number(debtor.amountOwed) || 0, afterPaid);
  const noteLine = `[payment deleted ${new Date().toISOString()}] ${payment.receiptNumber || payment._id} · R ${amount.toFixed(2)}${opts.reason ? ` — ${opts.reason}` : ''}`;
  debtor.notes = debtor.notes ? `${debtor.notes}\n${noteLine}` : noteLine;
  await debtor.save();

  try {
    const { syncGuestBookingUnpaidFromDebtor } = require('./guestBookingPaymentService');
    await syncGuestBookingUnpaidFromDebtor(debtor);
  } catch (err) {
    console.error('[debtor-payment] guest booking unpaid sync failed:', err?.message || err);
  }

  try {
    await syncInternalBookingUnpaidFromDebtor(debtor);
  } catch (err) {
    console.error('[debtor-payment] internal booking unpaid sync failed:', err?.message || err);
  }

  return {
    debtor,
    deletedPayment: {
      _id: paymentId,
      receiptNumber: payment.receiptNumber,
      amount,
    },
    before,
    meta: {
      remaining: Math.max(0, (Number(debtor.amountOwed) || 0) - (Number(debtor.amountPaid) || 0)),
    },
  };
}

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Deposit (or other cash) can sit on the debtor without a DebtorPayment row.
 * Roll amountPaid back to recorded receipts, then post one receipt for the gap.
 */
async function backfillUnreceiptedAmount(debtor, opts = {}) {
  const payments = await DebtorPayment.find({ debtorId: debtor._id }).select('amount').lean();
  const recorded = payments.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  const applied = Number(debtor.amountPaid) || 0;
  const owed = Number(debtor.amountOwed) || 0;
  const gap = Math.min(Math.max(0, applied - recorded), Math.max(0, owed - recorded));
  if (gap <= 0.009) return null;

  debtor.amountPaid = roundMoney(recorded);
  debtor.status = debtorStatusFor(owed, debtor.amountPaid);
  await debtor.save();

  return recordDebtorPayment(debtor._id, {
    amount: roundMoney(gap),
    paidAt: opts.paidAt,
    method: 'deposit',
    reference: opts.reference || 'DEPOSIT-APPLIED',
    note: 'Receipt created for a payment already applied on the booking',
    createdBy: opts.createdBy,
  });
}

async function ensureDebtorForBooking(booking, kind, userId) {
  let debtor = booking.debtorId ? await Debtor.findById(booking.debtorId) : null;
  if (!debtor) {
    debtor = await Debtor.findOne(
      kind === 'guest' ? { guestBookingRef: booking._id } : { bookingRef: booking._id }
    );
  }
  if (debtor) {
    if (!booking.debtorId || String(booking.debtorId) !== String(debtor._id)) {
      booking.debtorId = debtor._id;
      await booking.save();
    }
    return debtor;
  }

  const bookingRevenueService = require('./bookingRevenueService');
  try {
    if (kind === 'guest') {
      await bookingRevenueService.postGuestBookingRevenue(booking, userId);
    } else if (!booking.revenueTransactionId) {
      await bookingRevenueService.onInternalBookingConfirmed(booking, userId);
    }
  } catch (err) {
    if (!err.statusCode) err.statusCode = 400;
    throw err;
  }

  const BookingModel = kind === 'guest'
    ? require('../models/GuestBooking')
    : require('../models/Booking');
  const fresh = await BookingModel.findById(booking._id);
  if (fresh?.debtorId) {
    booking.debtorId = fresh.debtorId;
    debtor = await Debtor.findById(fresh.debtorId);
    if (debtor) return debtor;
  }

  const total = Number(kind === 'guest' ? booking.totalAmount : booking.amount) || 0;
  if (total <= 0) {
    const err = new Error('This booking has no amount, so a payment record cannot be created');
    err.statusCode = 400;
    throw err;
  }
  const guestReceivableAccountService = require('./guestReceivableAccountService');
  const arAcc = await guestReceivableAccountService.ensureControlAccountsReceivable(userId);
  debtor = await Debtor.create({
    name: booking.guestName || 'Guest',
    contactEmail: booking.guestEmail,
    contactPhone: booking.guestPhone,
    description: kind === 'guest'
      ? `Guest booking ${booking.trackingCode || booking._id}`
      : `Booking ${booking.type || ''} — ${booking._id}`,
    amountOwed: total,
    amountPaid: 0,
    status: 'outstanding',
    ...(kind === 'guest' ? { guestBookingRef: booking._id } : { bookingRef: booking._id }),
    receivableAccountId: arAcc?._id,
    createdBy: userId,
  });
  booking.debtorId = debtor._id;
  await booking.save();
  return debtor;
}

/**
 * Admin "mark as paid": ask for an amount, create any missing receipt, then record that payment.
 * The booking is marked paid only when the debtor balance is cleared.
 */
async function recordMarkPaid(booking, kind, opts = {}) {
  const amount = Number(opts.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    const err = new Error('Enter how much was paid');
    err.statusCode = 400;
    throw err;
  }

  const userId = opts.createdBy;
  const paidAt = opts.paidAt ? new Date(opts.paidAt) : new Date();
  let debtor = await ensureDebtorForBooking(booking, kind, userId);
  const code = kind === 'guest'
    ? (booking.trackingCode || String(booking._id).slice(-6))
    : String(booking._id).slice(-6);

  const backfill = await backfillUnreceiptedAmount(debtor, {
    paidAt,
    createdBy: userId,
    reference: `DEPOSIT-${code}`,
  });

  debtor = await Debtor.findById(debtor._id);
  const owed = Number(debtor.amountOwed) || 0;
  let remaining = Math.max(0, owed - (Number(debtor.amountPaid) || 0));
  const gapCovered = Number(backfill?.payment?.amount) || 0;

  let paymentResult = null;
  if (remaining > 0.009) {
    if (amount > remaining + gapCovered + 0.009) {
      const err = new Error(`Amount exceeds the balance of R ${remaining.toFixed(2)}`);
      err.statusCode = 400;
      throw err;
    }
    const payAmount = roundMoney(Math.min(amount, remaining));
    if (payAmount > 0.009) {
      paymentResult = await recordDebtorPayment(debtor._id, {
        amount: payAmount,
        paidAt,
        method: opts.method || 'eft',
        reference: opts.reference || `ADMIN-PAID-${code}`,
        note: opts.note || 'Marked paid by admin',
        createdBy: userId,
      });
    }
  }

  debtor = await Debtor.findById(debtor._id);
  remaining = Math.max(0, (Number(debtor?.amountOwed) || 0) - (Number(debtor?.amountPaid) || 0));
  const partial = remaining > 0.009;

  if (!partial) {
    const Model = kind === 'guest'
      ? require('../models/GuestBooking')
      : require('../models/Booking');
    const fresh = await Model.findById(booking._id);
    if (fresh && fresh.paymentStatus !== 'paid' && fresh.status !== 'cancelled') {
      fresh.paymentStatus = 'paid';
      fresh.paidAt = paidAt;
      await fresh.save();
    }
  }

  const recorded = paymentResult || backfill;
  if (!recorded) {
    const err = new Error('This booking already has a payment record for the full amount. Open Finance and check Payment history.');
    err.statusCode = 400;
    throw err;
  }
  return {
    payment: recorded,
    backfill: backfill && paymentResult ? backfill : null,
    partial,
    remaining,
    debtor,
  };
}

module.exports = {
  recordDebtorPayment,
  deleteDebtorPayment,
  debtorStatusFor,
  recordMarkPaid,
};
