const GuestBooking = require('../models/GuestBooking');
const Room = require('../models/Room');
const { asyncHandler, getPagination } = require('../utils/helpers');
const logAudit = require('../utils/audit');
const { withRoomPreview, withRoomPreviewMany } = require('../utils/bookingPreview');
const { isRoomAvailableForDates } = require('../utils/availability');
const bookingRevenueService = require('../services/bookingRevenueService');
const { scheduleNewGuestBookingEmails } = require('../services/invoiceNotifyService');
const crypto = require('crypto');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9\s\-()]{7,20}$/;

function isValidDateInput(v) {
  if (v == null || v === '') return false;
  const d = new Date(v);
  return !Number.isNaN(d.getTime());
}

const generateTrackingCode = () =>
  crypto.randomBytes(6).toString('hex').toUpperCase();

// Resolve roomId: accept MongoDB ObjectId string OR room name/slug (e.g. "garden" -> "Garden Suite")
const resolveRoomId = async (roomId) => {
  if (!roomId) return null;
  const isObjectId = /^[0-9a-fA-F]{24}$/.test(roomId);
  if (isObjectId) {
    const room = await Room.findById(roomId).lean();
    return room ? room._id : null;
  }
  const room = await Room.findOne({
    isAvailable: true,
    $or: [
      { name: { $regex: new RegExp('^' + String(roomId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') } },
      { name: { $regex: new RegExp(String(roomId), 'i') } },
    ],
  }).lean();
  return room ? room._id : null;
};

// Public: submit guest booking request
const createGuestBooking = asyncHandler(async (req, res) => {
  const { guestName, guestEmail, guestPhone, roomId, checkIn, checkOut, notes } = req.body;
  const cleanEmail = String(guestEmail || '').trim().toLowerCase();
  if (!EMAIL_RE.test(cleanEmail)) {
    return res.status(400).json({ success: false, message: 'Invalid guestEmail format' });
  }
  if (guestPhone != null && guestPhone !== '') {
    const cleanPhone = String(guestPhone).trim();
    if (!PHONE_RE.test(cleanPhone)) {
      return res.status(400).json({ success: false, message: 'Invalid guestPhone format' });
    }
  }
  if (!isValidDateInput(checkIn) || !isValidDateInput(checkOut)) {
    return res.status(400).json({ success: false, message: 'checkIn and checkOut must be valid dates' });
  }
  if (new Date(checkOut) <= new Date(checkIn)) {
    return res.status(400).json({ success: false, message: 'checkOut must be after checkIn' });
  }
  const resolvedRoomId = await resolveRoomId(roomId);
  const room = resolvedRoomId ? await Room.findById(resolvedRoomId).lean() : null;
  if (!room || !room.isAvailable) {
    return res.status(400).json({ success: false, message: 'Room not available' });
  }
  const available = await isRoomAvailableForDates(resolvedRoomId, checkIn, checkOut);
  if (!available) {
    return res.status(400).json({ success: false, message: 'Room is already booked for the selected dates' });
  }
  const nights = Math.ceil((new Date(checkOut) - new Date(checkIn)) / (1000 * 60 * 60 * 24)) || 1;
  const pricePerNight = Number(room.pricePerNight);
  if (!Number.isFinite(pricePerNight) || pricePerNight < 0) {
    return res.status(400).json({ success: false, message: 'Room pricing is invalid; contact admin' });
  }
  const totalAmount = pricePerNight * nights;
  if (!Number.isFinite(totalAmount) || totalAmount < 0) {
    return res.status(400).json({ success: false, message: 'Calculated totalAmount is invalid' });
  }
  const depositRaw = req.body.deposit != null ? Number(req.body.deposit) : totalAmount * 0.3;
  if (!Number.isFinite(depositRaw) || depositRaw < 0) {
    return res.status(400).json({ success: false, message: 'deposit must be a valid non-negative number' });
  }
  const deposit = depositRaw;

  const booking = await GuestBooking.create({
    guestName,
    guestEmail: cleanEmail,
    guestPhone,
    roomId: resolvedRoomId,
    checkIn,
    checkOut,
    totalAmount,
    deposit,
    trackingCode: generateTrackingCode(),
    source: req.body.source || 'website',
    notes,
  });
  scheduleNewGuestBookingEmails({
    guestName,
    guestEmail,
    guestPhone,
    roomName: room.name,
    roomType: room.type,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    nights,
    totalAmount: booking.totalAmount,
    deposit: booking.deposit,
    trackingCode: booking.trackingCode,
    notes,
    source: booking.source,
    guestBookingId: booking._id,
  });
  res.status(201).json({
    success: true,
    data: {
      _id: booking._id,
      trackingCode: booking.trackingCode,
      totalAmount: booking.totalAmount,
      status: booking.status,
      roomName: room.name,
      roomType: room.type,
    },
  });
});

// Public: track booking by email + trackingCode
const trackBooking = asyncHandler(async (req, res) => {
  const { email, trackingCode } = req.query;
  if (!email || !trackingCode) {
    return res.status(400).json({ success: false, message: 'email and trackingCode required' });
  }
  const booking = await GuestBooking.findOne({
    guestEmail: email,
    trackingCode: trackingCode.toUpperCase(),
  })
    .populate('roomId', 'name type')
    .lean()
    .select('guestName guestEmail checkIn checkOut totalAmount deposit status trackingCode roomId');
  if (!booking) {
    return res.status(404).json({ success: false, message: 'Booking not found' });
  }
  res.json({ success: true, data: withRoomPreview(booking) });
});

// Admin, CEO: view all guest booking requests
const getAllGuestBookings = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const { skip, limit: lim } = getPagination(page, limit);
  const [data, total] = await Promise.all([
    GuestBooking.find()
      .populate('roomId', 'name type')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(lim)
      .lean(),
    GuestBooking.countDocuments(),
  ]);
  res.json({
    success: true,
    data: withRoomPreviewMany(data),
    meta: { page: parseInt(page, 10), limit: lim, total },
  });
});

// Admin: confirm, cancel, or update status
const updateGuestBooking = asyncHandler(async (req, res) => {
  const booking = await GuestBooking.findById(req.params.id);
  if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
  const before = booking.toObject();
  if (req.body.guestEmail != null) {
    const cleanEmail = String(req.body.guestEmail || '').trim().toLowerCase();
    if (!EMAIL_RE.test(cleanEmail)) {
      return res.status(400).json({ success: false, message: 'Invalid guestEmail format' });
    }
    req.body.guestEmail = cleanEmail;
  }
  if (req.body.guestPhone != null && req.body.guestPhone !== '') {
    const cleanPhone = String(req.body.guestPhone).trim();
    if (!PHONE_RE.test(cleanPhone)) {
      return res.status(400).json({ success: false, message: 'Invalid guestPhone format' });
    }
    req.body.guestPhone = cleanPhone;
  }
  const nextCheckIn = req.body.checkIn !== undefined ? req.body.checkIn : booking.checkIn;
  const nextCheckOut = req.body.checkOut !== undefined ? req.body.checkOut : booking.checkOut;
  if ((req.body.checkIn !== undefined || req.body.checkOut !== undefined)) {
    if (!isValidDateInput(nextCheckIn) || !isValidDateInput(nextCheckOut)) {
      return res.status(400).json({ success: false, message: 'checkIn and checkOut must be valid dates' });
    }
    if (new Date(nextCheckOut) <= new Date(nextCheckIn)) {
      return res.status(400).json({ success: false, message: 'checkOut must be after checkIn' });
    }
  }
  if (req.body.status === 'confirmed' && booking.status !== 'confirmed') {
    const available = await isRoomAvailableForDates(booking.roomId, nextCheckIn, nextCheckOut, booking._id);
    if (!available) {
      return res.status(400).json({ success: false, message: 'Room is no longer available for these dates; cannot confirm' });
    }
  }
  if (req.body.status) booking.status = req.body.status;
  if (req.body.notes !== undefined) booking.notes = req.body.notes;
  await booking.save();

  const becameConfirmed = before.status !== 'confirmed' && booking.status === 'confirmed';
  const cancelledAfterConfirm = before.status === 'confirmed' && booking.status === 'cancelled';

  if (becameConfirmed) {
    try {
      await bookingRevenueService.onGuestBookingConfirmed(booking, req.user._id);
    } catch (err) {
      await GuestBooking.findByIdAndUpdate(booking._id, { status: before.status });
      return res.status(400).json({
        success: false,
        message: err.message || 'Could not record revenue / debtor for this confirmation',
        hint: 'Ensure chart of accounts is seeded: npm run seed:accounting',
      });
    }
  }
  if (cancelledAfterConfirm) {
    await bookingRevenueService.reverseGuestBookingRevenue(booking, req.user._id);
  }

  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'update',
    entity: 'GuestBooking',
    entityId: booking._id,
    before,
    after: booking.toObject(),
    req,
  });
  const updated = await GuestBooking.findById(booking._id).populate('roomId', 'name type').lean();
  res.json({ success: true, data: withRoomPreview(updated) });
});

const deleteGuestBooking = asyncHandler(async (req, res) => {
  const booking = await GuestBooking.findById(req.params.id);
  if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

  const before = booking.toObject();

  // Keep ledger/debtor/invoice consistent when deleting a previously confirmed booking.
  if (booking.status === 'confirmed' && booking.revenueTransactionId) {
    await bookingRevenueService.reverseGuestBookingRevenue(booking, req.user._id);
  }

  await booking.deleteOne();

  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'delete',
    entity: 'GuestBooking',
    entityId: req.params.id,
    before,
    req,
  });

  res.json({ success: true, message: 'Guest booking removed' });
});

module.exports = {
  createGuestBooking,
  trackBooking,
  getAllGuestBookings,
  updateGuestBooking,
  deleteGuestBooking,
};
