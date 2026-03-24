const GuestBooking = require('../models/GuestBooking');
const Room = require('../models/Room');
const { asyncHandler, getPagination } = require('../utils/helpers');
const logAudit = require('../utils/audit');
const { withRoomPreview, withRoomPreviewMany } = require('../utils/bookingPreview');
const { isRoomAvailableForDates } = require('../utils/availability');
const bookingRevenueService = require('../services/bookingRevenueService');
const crypto = require('crypto');

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
  const totalAmount = (room.pricePerNight || 0) * nights;
  const deposit = req.body.deposit != null ? req.body.deposit : totalAmount * 0.3;

  const booking = await GuestBooking.create({
    guestName,
    guestEmail,
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
  if (req.body.status === 'confirmed' && booking.status !== 'confirmed') {
    const available = await isRoomAvailableForDates(booking.roomId, booking.checkIn, booking.checkOut, booking._id);
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

module.exports = {
  createGuestBooking,
  trackBooking,
  getAllGuestBookings,
  updateGuestBooking,
};
