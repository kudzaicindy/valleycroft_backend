/**
 * Confirmed guest bookings are held for payment for N hours (default 24).
 * Unpaid holds expire → cancelled (dates free). Admin/PayFast mark paid to keep the hold.
 */
const GuestBooking = require('../models/GuestBooking');
const Debtor = require('../models/Debtor');
const bookingRevenueService = require('./bookingRevenueService');
const { recordDebtorPayment } = require('./debtorPaymentService');
const User = require('../models/User');

function paymentDueHoursAfterConfirm() {
  const n = Number(process.env.MAIL_PAYMENT_DUE_HOURS_AFTER_CONFIRM);
  return Number.isFinite(n) && n > 0 ? n : 24;
}

function applyPaymentHoldOnConfirm(booking, at = new Date()) {
  const confirmedAt = at instanceof Date ? at : new Date(at);
  booking.confirmedAt = confirmedAt;
  booking.paymentDueAt = new Date(confirmedAt.getTime() + paymentDueHoursAfterConfirm() * 60 * 60 * 1000);
  booking.paymentStatus = 'unpaid';
  booking.paidAt = undefined;
  booking.revokedAt = undefined;
  booking.revocationReason = undefined;
  return booking;
}

async function resolveSystemUserId(preferredUserId) {
  if (preferredUserId) return preferredUserId;
  const admin = await User.findOne({ role: { $in: ['admin', 'ceo', 'finance'] } })
    .select('_id')
    .lean();
  if (admin?._id) return admin._id;
  const any = await User.findOne().select('_id').lean();
  if (!any?._id) throw new Error('No user account found to attribute booking payment expiry');
  return any._id;
}

/**
 * Mark booking paid after debtor is fully settled (PayFast / debtor payments).
 */
async function syncGuestBookingPaidFromDebtor(debtorDoc, paidAt = new Date()) {
  const guestBookingId = debtorDoc?.guestBookingRef;
  if (!guestBookingId) return null;

  const owed = Number(debtorDoc.amountOwed) || 0;
  const paid = Number(debtorDoc.amountPaid) || 0;
  if (owed > 0 && paid + 0.009 < owed) return null;

  const booking = await GuestBooking.findById(guestBookingId);
  if (!booking) return null;
  if (booking.status === 'cancelled') return null;
  if (booking.paymentStatus === 'paid') return booking;

  booking.paymentStatus = 'paid';
  booking.paidAt = paidAt instanceof Date ? paidAt : new Date(paidAt);
  await booking.save();
  return booking;
}

/**
 * Admin (or system) marks a confirmed booking as paid — records remaining debtor balance if any.
 */
async function markGuestBookingPaid(bookingId, opts = {}) {
  const booking = await GuestBooking.findById(bookingId);
  if (!booking) {
    const err = new Error('Booking not found');
    err.statusCode = 404;
    throw err;
  }
  if (booking.status !== 'confirmed') {
    const err = new Error('Only confirmed bookings can be marked as paid');
    err.statusCode = 400;
    throw err;
  }
  if (booking.paymentStatus === 'paid') {
    return { booking, alreadyPaid: true };
  }

  const userId = await resolveSystemUserId(opts.userId);
  const paidAt = opts.paidAt ? new Date(opts.paidAt) : new Date();
  let paymentResult = null;

  if (booking.debtorId) {
    const debtor = await Debtor.findById(booking.debtorId);
    if (debtor) {
      const remaining = Math.max(0, (Number(debtor.amountOwed) || 0) - (Number(debtor.amountPaid) || 0));
      const amount =
        opts.amount != null && Number.isFinite(Number(opts.amount))
          ? Number(opts.amount)
          : remaining;
      if (amount > 0.009) {
        paymentResult = await recordDebtorPayment(debtor._id, {
          amount,
          paidAt,
          method: opts.method || 'manual',
          reference: opts.reference || `ADMIN-PAID-${booking.trackingCode}`,
          note: opts.note || 'Marked paid by admin',
          createdBy: userId,
        });
      } else {
        booking.paymentStatus = 'paid';
        booking.paidAt = paidAt;
        await booking.save();
      }
    } else {
      booking.paymentStatus = 'paid';
      booking.paidAt = paidAt;
      await booking.save();
    }
  } else {
    booking.paymentStatus = 'paid';
    booking.paidAt = paidAt;
    await booking.save();
  }

  const fresh = await GuestBooking.findById(booking._id);
  if (fresh && fresh.paymentStatus !== 'paid') {
    let remaining = 0;
    if (fresh.debtorId) {
      const debtor = await Debtor.findById(fresh.debtorId).lean();
      remaining = Math.max(
        0,
        (Number(debtor?.amountOwed) || 0) - (Number(debtor?.amountPaid) || 0)
      );
    }
    if (remaining <= 0.009) {
      fresh.paymentStatus = 'paid';
      fresh.paidAt = paidAt;
      await fresh.save();
    } else {
      return {
        booking: fresh,
        alreadyPaid: false,
        partial: true,
        payment: paymentResult,
      };
    }
  }

  return {
    booking: fresh || booking,
    alreadyPaid: false,
    payment: paymentResult,
  };
}

/**
 * Cancel confirmed unpaid bookings past paymentDueAt (frees the room).
 * @returns {{ expired: number, ids: string[] }}
 */
async function expireUnpaidGuestBookings({ roomId = null, userId = null } = {}) {
  const now = new Date();
  const query = {
    status: 'confirmed',
    paymentStatus: { $ne: 'paid' },
    paymentDueAt: { $exists: true, $ne: null, $lte: now },
  };
  if (roomId) query.roomId = roomId;

  const due = await GuestBooking.find(query);
  if (!due.length) return { expired: 0, ids: [] };

  const actorId = await resolveSystemUserId(userId);
  const ids = [];

  for (const booking of due) {
    if (booking.paymentStatus === 'paid') continue;
    const beforeStatus = booking.status;
    booking.status = 'cancelled';
    booking.paymentStatus = 'expired';
    booking.revokedAt = now;
    booking.revocationReason = 'payment_timeout';
    const noteLine = `[auto] Unpaid after ${paymentDueHoursAfterConfirm()}h hold — revoked ${now.toISOString()}`;
    booking.notes = booking.notes ? `${booking.notes}\n${noteLine}` : noteLine;
    await booking.save();

    if (beforeStatus === 'confirmed') {
      try {
        await bookingRevenueService.reverseGuestBookingRevenue(booking, actorId);
      } catch (err) {
        console.error(
          '[payment-hold] reverse revenue failed for',
          String(booking._id),
          err?.message || err
        );
      }
    }
    ids.push(String(booking._id));
  }

  return { expired: ids.length, ids };
}

module.exports = {
  paymentDueHoursAfterConfirm,
  applyPaymentHoldOnConfirm,
  markGuestBookingPaid,
  syncGuestBookingPaidFromDebtor,
  expireUnpaidGuestBookings,
};
