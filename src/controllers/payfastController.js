const mongoose = require('mongoose');
const GuestBooking = require('../models/GuestBooking');
const Debtor = require('../models/Debtor');
const PayfastPayment = require('../models/PayfastPayment');
const { asyncHandler } = require('../utils/helpers');
const payfast = require('../services/payfastService');
const { recordDebtorPayment } = require('../services/debtorPaymentService');

function remainingBalance(debtor) {
  const owed = Number(debtor.amountOwed) || 0;
  const paid = Number(debtor.amountPaid) || 0;
  return Math.max(0, owed - paid);
}

function resolveCheckoutAmount(debtor, guestBooking, paymentType, customAmount) {
  const remaining = remainingBalance(debtor);
  if (remaining <= 0) {
    throw new Error('Nothing outstanding on this booking');
  }

  if (paymentType === 'custom') {
    const amt = Number(customAmount);
    if (!Number.isFinite(amt) || amt <= 0) throw new Error('amount must be a positive number');
    if (amt > remaining + 0.009) {
      throw new Error(`amount exceeds remaining balance (${remaining.toFixed(2)})`);
    }
    return { amount: amt, paymentType: 'custom' };
  }

  if (paymentType === 'deposit' && guestBooking) {
    const dep = Math.min(Number(guestBooking.deposit) || 0, Number(guestBooking.totalAmount) || 0);
    const alreadyCounted = Number(debtor.amountPaid) || 0;
    const depositStillDue = Math.max(0, dep - alreadyCounted);
    if (depositStillDue <= 0) {
      throw new Error('Deposit already received — pay balance instead');
    }
    return { amount: Math.min(depositStillDue, remaining), paymentType: 'deposit' };
  }

  return { amount: remaining, paymentType: paymentType === 'full' ? 'full' : 'balance' };
}

async function loadGuestBookingDebtor(email, trackingCode) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const code = String(trackingCode || '').trim().toUpperCase();
  if (!cleanEmail || !code) {
    throw new Error('email and trackingCode are required');
  }

  const guestBooking = await GuestBooking.findOne({
    guestEmail: cleanEmail,
    trackingCode: code,
  })
    .populate('roomId', 'name type')
    .lean();
  if (!guestBooking) throw new Error('Booking not found');
  if (guestBooking.status !== 'confirmed') {
    throw new Error('Online payment is only available after your booking is confirmed');
  }

  const debtor = await Debtor.findOne({ guestBookingRef: guestBooking._id }).lean();
  if (!debtor) {
    throw new Error('Payment account not ready yet — contact us if this persists');
  }

  return { guestBooking, debtor };
}

async function createCheckoutSession({ debtor, guestBooking, paymentType, customAmount }) {
  const { amount, paymentType: resolvedType } = resolveCheckoutAmount(
    debtor,
    guestBooking,
    paymentType,
    customAmount,
  );

  const mPaymentId = `VC-${new mongoose.Types.ObjectId().toString()}`;
  const pf = await PayfastPayment.create({
    mPaymentId,
    debtorId: debtor._id,
    guestBookingRef: guestBooking?._id,
    bookingRef: debtor.bookingRef || undefined,
    amount,
    paymentType: resolvedType,
    status: 'pending',
  });

  const roomName = guestBooking?.roomId?.name || 'Valley Croft stay';
  const ref = guestBooking?.trackingCode || String(debtor._id);
  const fields = payfast.buildCheckoutFields({
    mPaymentId,
    amount,
    itemName: `Booking ${ref}`,
    itemDescription: `${roomName} — ${resolvedType} payment`,
    guestName: guestBooking?.guestName || debtor.name,
    guestEmail: guestBooking?.guestEmail || debtor.contactEmail,
    guestPhone: guestBooking?.guestPhone || debtor.contactPhone,
  });

  return {
    paymentId: pf._id,
    mPaymentId,
    amount,
    paymentType: resolvedType,
    remainingBefore: remainingBalance(debtor),
    payfast: {
      action: payfast.processUrl(),
      method: 'POST',
      fields,
    },
    sandbox: payfast.isSandbox(),
  };
}

async function safeLoadGuestBookingDebtor(email, trackingCode) {
  try {
    return await loadGuestBookingDebtor(email, trackingCode);
  } catch (err) {
    return { error: err.message || 'Invalid booking' };
  }
}

/** Public: start PayFast checkout after guest booking confirmation */
const guestBookingCheckout = asyncHandler(async (req, res) => {
  if (!payfast.payfastConfigured()) {
    return res.status(503).json({ success: false, message: 'Online payments are not configured yet' });
  }

  const { email, trackingCode, paymentType = 'balance', amount: customAmount } = req.body || {};
  const loaded = await safeLoadGuestBookingDebtor(email, trackingCode);
  if (loaded.error) {
    return res.status(400).json({ success: false, message: loaded.error });
  }
  const { guestBooking, debtor } = loaded;

  try {
    const session = await createCheckoutSession({
      debtor,
      guestBooking,
      paymentType: String(paymentType || 'balance').toLowerCase(),
      customAmount,
    });
    return res.json({ success: true, data: session });
  } catch (err) {
    return res.status(400).json({ success: false, message: err.message || 'Could not start checkout' });
  }
});

/** Public: payment options for confirmed guest booking (track page / pay page) */
const guestBookingPaymentOptions = asyncHandler(async (req, res) => {
  const { email, trackingCode } = req.query;
  const loaded = await safeLoadGuestBookingDebtor(email, trackingCode);
  if (loaded.error) {
    return res.status(400).json({ success: false, message: loaded.error });
  }
  const { guestBooking, debtor } = loaded;
  const remaining = remainingBalance(debtor);
  const dep = Math.min(Number(guestBooking.deposit) || 0, Number(guestBooking.totalAmount) || 0);
  const paid = Number(debtor.amountPaid) || 0;
  const depositStillDue = Math.max(0, dep - paid);

  res.json({
    success: true,
    data: {
      guestName: guestBooking.guestName,
      trackingCode: guestBooking.trackingCode,
      status: guestBooking.status,
      totalAmount: guestBooking.totalAmount,
      deposit: guestBooking.deposit,
      amountPaid: paid,
      balanceDue: remaining,
      depositStillDue,
      payfastEnabled: payfast.payfastConfigured(),
      payNowPageUrl: payfast.guestPayNowPageUrl(guestBooking.guestEmail, guestBooking.trackingCode),
    },
  });
});

/** PayFast ITN webhook — must be public HTTPS */
const handleItn = asyncHandler(async (req, res) => {
  const post = req.body || {};
  if (!payfast.verifyItnSignature(post)) {
    console.error('[payfast] ITN signature verification failed');
    return res.status(400).send('Invalid signature');
  }

  if (String(post.merchant_id || '') !== payfast.merchantId()) {
    console.error('[payfast] ITN merchant_id mismatch');
    return res.status(400).send('Invalid merchant');
  }

  const mPaymentId = String(post.m_payment_id || '').trim();
  const pfPayment = await PayfastPayment.findOne({ mPaymentId });
  if (!pfPayment) {
    console.error('[payfast] ITN unknown m_payment_id', mPaymentId);
    return res.status(404).send('Unknown payment');
  }

  const paymentStatus = String(post.payment_status || '').toUpperCase();
  pfPayment.pfPaymentStatus = paymentStatus;
  pfPayment.payfastPaymentId = post.pf_payment_id ? String(post.pf_payment_id) : pfPayment.payfastPaymentId;
  pfPayment.rawItn = post;

  if (paymentStatus !== 'COMPLETE') {
    if (['CANCELLED', 'FAILED'].includes(paymentStatus)) {
      pfPayment.status = paymentStatus === 'CANCELLED' ? 'cancelled' : 'failed';
      pfPayment.failureReason = String(post.reason_code || paymentStatus);
    }
    await pfPayment.save();
    return res.status(200).send('OK');
  }

  if (pfPayment.status === 'complete') {
    return res.status(200).send('OK');
  }

  const gross = Number(post.amount_gross);
  const expected = Number(pfPayment.amount);
  if (!Number.isFinite(gross) || Math.abs(gross - expected) > 0.02) {
    pfPayment.status = 'failed';
    pfPayment.failureReason = `amount_mismatch expected ${expected} got ${post.amount_gross}`;
    await pfPayment.save();
    console.error('[payfast] ITN amount mismatch', mPaymentId, expected, post.amount_gross);
    return res.status(400).send('Amount mismatch');
  }

  try {
    const result = await recordDebtorPayment(pfPayment.debtorId, {
      amount: expected,
      paidAt: new Date(),
      method: 'payfast',
      reference: `PF:${post.pf_payment_id || mPaymentId}`,
      note: `PayFast ITN ${mPaymentId}`,
      createdBy: undefined,
    });

    pfPayment.status = 'complete';
    pfPayment.fulfilledAt = new Date();
    pfPayment.debtorPaymentId = result.payment._id;
    pfPayment.transactionId = result.transaction._id;
    await pfPayment.save();
  } catch (err) {
    pfPayment.status = 'failed';
    pfPayment.failureReason = err.message;
    await pfPayment.save();
    console.error('[payfast] ITN fulfillment failed:', err.message);
    return res.status(500).send('Fulfillment failed');
  }

  return res.status(200).send('OK');
});

const getPaymentStatus = asyncHandler(async (req, res) => {
  const doc = await PayfastPayment.findById(req.params.id).lean();
  if (!doc) return res.status(404).json({ success: false, message: 'Payment not found' });
  res.json({
    success: true,
    data: {
      _id: doc._id,
      mPaymentId: doc.mPaymentId,
      status: doc.status,
      amount: doc.amount,
      paymentType: doc.paymentType,
      fulfilledAt: doc.fulfilledAt,
      failureReason: doc.failureReason,
    },
  });
});

module.exports = {
  guestBookingCheckout,
  guestBookingPaymentOptions,
  handleItn,
  getPaymentStatus,
};
