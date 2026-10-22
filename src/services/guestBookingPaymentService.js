/**
 * Confirmed guest bookings are held for payment for N hours (default 24).
 * Unpaid holds expire → cancelled (dates free). Admin/PayFast mark paid to keep the hold.
 */
const GuestBooking = require('../models/GuestBooking');
const Debtor = require('../models/Debtor');
const bookingRevenueService = require('./bookingRevenueService');
const { recordMarkPaid } = require('./debtorPaymentService');
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
 * When a payment is deleted and the debtor is no longer fully settled, clear paid status
 * on the linked confirmed guest booking (hold resumes / unpaid again).
 */
async function syncGuestBookingUnpaidFromDebtor(debtorDoc) {
  const guestBookingId = debtorDoc?.guestBookingRef;
  if (!guestBookingId) return null;

  const owed = Number(debtorDoc.amountOwed) || 0;
  const paid = Number(debtorDoc.amountPaid) || 0;
  const fullyPaid = owed <= 0 || paid + 0.009 >= owed;
  if (fullyPaid) return null;

  const booking = await GuestBooking.findById(guestBookingId);
  if (!booking) return null;
  if (booking.status === 'cancelled') return null;
  if (booking.paymentStatus !== 'paid') return booking;

  booking.paymentStatus = 'unpaid';
  booking.paidAt = undefined;
  await booking.save();
  return booking;
}

/**
 * Admin marks a confirmed booking as paid.
 * Requires the amount received and always creates a payment receipt.
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

  const userId = await resolveSystemUserId(opts.userId);
  const result = await recordMarkPaid(booking, 'guest', {
    amount: opts.amount,
    paidAt: opts.paidAt,
    method: opts.method,
    reference: opts.reference,
    note: opts.note,
    createdBy: userId,
  });
  const fresh = await GuestBooking.findById(booking._id);
  return {
    booking: fresh || booking,
    alreadyPaid: false,
    partial: result.partial,
    remaining: result.remaining,
    payment: result.payment,
    backfill: result.backfill,
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

    try {
      const { scheduleGuestBookingPaymentExpiredEmails } = require('./invoiceNotifyService');
      scheduleGuestBookingPaymentExpiredEmails({
        guestName: booking.guestName,
        guestEmail: booking.guestEmail,
        guestPhone: booking.guestPhone,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        totalAmount: booking.totalAmount,
        deposit: booking.deposit,
        trackingCode: booking.trackingCode,
        paymentDueAt: booking.paymentDueAt,
        guestCount: booking.guestCount,
        foodAddOns: booking.foodAddOns,
        pricingBreakdown: booking.pricingBreakdown,
        guestBookingId: booking._id,
        relatedId: booking._id,
      });
    } catch (err) {
      console.error('[payment-hold] expiry email schedule failed:', err?.message || err);
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
  syncGuestBookingUnpaidFromDebtor,
  expireUnpaidGuestBookings,
};
