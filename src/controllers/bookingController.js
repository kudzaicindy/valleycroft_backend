const Booking = require('../models/Booking');
const { asyncHandler, getPagination } = require('../utils/helpers');
const logAudit = require('../utils/audit');
const { withRoomPreviewMany, withRoomPreview } = require('../utils/bookingPreview');
const bookingRevenueService = require('../services/bookingRevenueService');
const { scheduleInternalBookingCreatedAdmin } = require('../services/invoiceNotifyService');
const { isRoomAvailableForDates } = require('../utils/availability');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9\s\-()]{7,20}$/;
const BOOKING_UPDATE_FIELDS = [
  'guestName',
  'guestEmail',
  'guestPhone',
  'type',
  'roomId',
  'checkIn',
  'checkOut',
  'eventDate',
  'amount',
  'deposit',
  'grossAmount',
  'receivedAmount',
  'platformCharge',
  'externalCharge',
  'roomName',
  'platform',
  'source',
  'status',
  'notes',
];

function pickAllowedBookingUpdates(body = {}) {
  const out = {};
  for (const key of BOOKING_UPDATE_FIELDS) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
}

function isValidDateInput(v) {
  if (v == null || v === '') return false;
  const d = new Date(v);
  return !Number.isNaN(d.getTime());
}

function validateBookingPayload(payload) {
  if (payload.guestEmail != null && payload.guestEmail !== '') {
    const email = String(payload.guestEmail).trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return 'Invalid guestEmail format';
    payload.guestEmail = email;
  }
  if (payload.guestPhone != null && payload.guestPhone !== '') {
    const phone = String(payload.guestPhone).trim();
    if (!PHONE_RE.test(phone)) return 'Invalid guestPhone format';
    payload.guestPhone = phone;
  }

  const type = String(payload.type || '').toLowerCase();
  if (type === 'bnb') {
    if (!isValidDateInput(payload.checkIn) || !isValidDateInput(payload.checkOut)) {
      return 'checkIn and checkOut are required valid dates for bnb bookings';
    }
    const inDate = new Date(payload.checkIn);
    const outDate = new Date(payload.checkOut);
    if (outDate <= inDate) return 'checkOut must be after checkIn';
  } else if (type === 'event') {
    if (!isValidDateInput(payload.eventDate)) {
      return 'eventDate is required and must be a valid date for event bookings';
    }
  }
  return null;
}

async function validateRoomAvailability(payload, excludeBookingId = null) {
  const type = String(payload.type || '').toLowerCase();
  const status = String(payload.status || 'pending').toLowerCase();
  if (status === 'cancelled') return null;
  if (!payload.roomId) return null;

  if (type === 'bnb') {
    const available = await isRoomAvailableForDates(payload.roomId, payload.checkIn, payload.checkOut, null, excludeBookingId);
    if (!available) return 'Room is already booked for the selected dates';
  } else if (type === 'event' && isValidDateInput(payload.eventDate)) {
    const eventStart = new Date(payload.eventDate);
    eventStart.setUTCHours(0, 0, 0, 0);
    const eventEnd = new Date(payload.eventDate);
    eventEnd.setUTCHours(23, 59, 59, 999);
    const available = await isRoomAvailableForDates(payload.roomId, eventStart, eventEnd, null, excludeBookingId);
    if (!available) return 'Room is already booked for the selected event date';
  }
  return null;
}

const list = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const { skip, limit: lim } = getPagination(page, limit);
  const [data, total] = await Promise.all([
    Booking.find()
      .populate('roomId', 'name type')
      .sort({ checkIn: -1 })
      .skip(skip)
      .limit(lim)
      .lean(),
    Booking.countDocuments(),
  ]);
  res.json({
    success: true,
    data: withRoomPreviewMany(data),
    meta: { page: parseInt(page, 10), limit: lim, total },
  });
});

const getAvailability = asyncHandler(async (req, res) => {
  const { checkIn, checkOut, type } = req.query;
  const start = new Date(checkIn);
  const end = new Date(checkOut);
  const overlapping = await Booking.find({
    type: type || { $in: ['bnb', 'event'] },
    status: { $nin: ['cancelled'] },
    $or: [
      { checkIn: { $lte: end }, checkOut: { $gte: start } },
      { eventDate: { $gte: start, $lte: end } },
    ],
  })
    .populate('roomId', 'name type')
    .lean()
    .select('checkIn checkOut eventDate type status roomId');
  res.json({ success: true, data: withRoomPreviewMany(overlapping) });
});

const getOne = asyncHandler(async (req, res) => {
  const booking = await Booking.findById(req.params.id).populate('roomId', 'name type').lean();
  if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
  res.json({ success: true, data: withRoomPreview(booking) });
});

const create = asyncHandler(async (req, res) => {
  const payload = { ...req.body };
  const payloadError = validateBookingPayload(payload);
  if (payloadError) {
    return res.status(400).json({ success: false, message: payloadError });
  }
  const availabilityError = await validateRoomAvailability(payload);
  if (availabilityError) {
    return res.status(400).json({ success: false, message: availabilityError });
  }

  const booking = await Booking.create({ ...payload, createdBy: req.user._id });
  if (booking.status === 'confirmed') {
    try {
      await bookingRevenueService.onInternalBookingConfirmed(booking, req.user._id);
    } catch (err) {
      await Booking.findByIdAndDelete(booking._id);
      return res.status(400).json({
        success: false,
        message: err.message || 'Could not record revenue / debtor for confirmed booking',
        hint: 'Ensure chart of accounts is seeded: npm run seed:accounting',
      });
    }
  }
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'create',
    entity: 'Booking',
    entityId: booking._id,
    after: booking.toObject(),
    req,
  });
  const created = await Booking.findById(booking._id).populate('roomId', 'name type').lean();
  const preview = withRoomPreview(created);
  scheduleInternalBookingCreatedAdmin(preview);
  res.status(201).json({ success: true, data: preview });
});

const update = asyncHandler(async (req, res) => {
  const booking = await Booking.findById(req.params.id);
  if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
  const before = booking.toObject();
  const updates = pickAllowedBookingUpdates(req.body);
  const merged = { ...before, ...updates };
  const payloadError = validateBookingPayload(merged);
  if (payloadError) {
    return res.status(400).json({ success: false, message: payloadError });
  }
  const availabilityError = await validateRoomAvailability(merged, booking._id);
  if (availabilityError) {
    return res.status(400).json({ success: false, message: availabilityError });
  }
  Object.assign(booking, updates);
  await booking.save();

  const becameConfirmed = before.status !== 'confirmed' && booking.status === 'confirmed';
  const cancelledAfterConfirm = before.status === 'confirmed' && booking.status === 'cancelled';

  if (becameConfirmed) {
    try {
      await bookingRevenueService.onInternalBookingConfirmed(booking, req.user._id);
    } catch (err) {
      await Booking.findByIdAndUpdate(booking._id, { status: before.status });
      return res.status(400).json({
        success: false,
        message: err.message || 'Could not record revenue / debtor for this confirmation',
        hint: 'Ensure chart of accounts is seeded: npm run seed:accounting',
      });
    }
  }
  if (cancelledAfterConfirm) {
    await bookingRevenueService.reverseInternalBookingRevenue(booking, req.user._id);
  }

  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'update',
    entity: 'Booking',
    entityId: booking._id,
    before,
    after: booking.toObject(),
    req,
  });
  const updated = await Booking.findById(booking._id).populate('roomId', 'name type').lean();
  res.json({ success: true, data: withRoomPreview(updated) });
});

const remove = asyncHandler(async (req, res) => {
  const booking = await Booking.findById(req.params.id);
  if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
  const before = booking.toObject();
  await booking.deleteOne();
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'delete',
    entity: 'Booking',
    entityId: req.params.id,
    before,
    req,
  });
  res.json({ success: true, message: 'Booking removed' });
});

module.exports = { list, getAvailability, getOne, create, update, remove };
