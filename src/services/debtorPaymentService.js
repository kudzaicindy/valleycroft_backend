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

module.exports = {
  recordDebtorPayment,
  debtorStatusFor,
};
