const GuestBooking = require('../models/GuestBooking');
const Room = require('../models/Room');
const { asyncHandler, getPagination } = require('../utils/helpers');
const logAudit = require('../utils/audit');
const { withRoomPreview, withRoomPreviewMany } = require('../utils/bookingPreview');
const { isRoomAvailableForDates } = require('../utils/availability');
const bookingRevenueService = require('../services/bookingRevenueService');
const { scheduleNewGuestBookingEmails } = require('../services/invoiceNotifyService');
const {
  parseFoodAddOns,
  hasAnyFoodAddOn,
  computeStayQuote,
  catalogueForApi,
  bookingNights,
  resolveBookingAmounts,
  pricingBreakdownFromAmounts,
} = require('../utils/foodAddOnPricing');
const foodAddOnService = require('../services/foodAddOnService');
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

function parseGuestCount(body) {
  const raw = body.guestCount ?? body.adults ?? body.guests ?? body.numberOfGuests;
  if (raw == null || raw === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : NaN;
}

/** When the website sends foodAmount but not guestCount, infer guests from breakfast/picnic totals. */
function inferGuestCountFromFoodAmount(foodAddOns, nights, foodAmount) {
  const amount = Number(foodAmount);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const morningCount = Math.max(1, Number(nights) || 1);
  const breakfast = foodAddOns.breakfast;
  const picnic = foodAddOns.picnic;
  if (breakfast && !picnic) {
    const breakfastDef = foodAddOnService.getFoodAddOn('breakfast');
    const perGuest = (breakfastDef?.unitPrice || 100) * morningCount;
    if (perGuest > 0) return Math.max(1, Math.round(amount / perGuest));
  }
  if (picnic && !breakfast) {
    const picnicDef = foodAddOnService.getFoodAddOn('picnic');
    const perGuest = picnicDef?.unitPrice || 800;
    return Math.max(1, Math.round(amount / perGuest));
  }
  return 0;
}

function resolveGuestCount(body, foodAddOns, nights) {
  const parsed = parseGuestCount(body);
  if (parsed >= 1) return parsed;
  if (!hasAnyFoodAddOn(foodAddOns)) return parsed;
  const inferred = inferGuestCountFromFoodAmount(foodAddOns, nights, body.foodAmount);
  return inferred >= 1 ? inferred : parsed;
}

function resolveDeposit(bodyDeposit, totalAmount) {
  const total = Number(totalAmount) || 0;
  if (total <= 0) return 0;
  if (bodyDeposit == null || bodyDeposit === '') return total;
  const d = Number(bodyDeposit);
  if (!Number.isFinite(d) || d <= 0) return total;
  return Math.min(d, total);
}

function foodAddOnsFromBody(body) {
  const raw =
    body.foodAddOns ??
    body.foodAddons ??
    body.addons ??
    body.addOns;
  if (raw !== undefined) {
    if (typeof raw === 'string' && raw.includes(',')) {
      return parseFoodAddOns(raw.split(',').map((s) => s.trim()));
    }
    const parsed = parseFoodAddOns(raw);
    if (hasAnyFoodAddOn(parsed)) return parsed;
  }

  const notes = String(body.notes || '');
  const fromNotes = { breakfast: /breakfast/i.test(notes), picnic: /picnic/i.test(notes) };
  if (fromNotes.breakfast || fromNotes.picnic) {
    return parseFoodAddOns(fromNotes);
  }

  const foodAmount = Number(body.foodAmount);
  if (Number.isFinite(foodAmount) && foodAmount > 0) {
    return parseFoodAddOns(['breakfast']);
  }

  return parseFoodAddOns({
    breakfast: body.breakfast,
    picnic: body.picnic,
  });
}

function validateFoodAddOnGuestCount(guestCount, foodAddOns, roomCapacity) {
  if (!hasAnyFoodAddOn(foodAddOns)) return null;
  if (!Number.isFinite(guestCount) || guestCount < 1) {
    return 'guestCount is required (minimum 1) when food add-ons are selected';
  }
  const cap = Number(roomCapacity);
  if (Number.isFinite(cap) && cap > 0 && guestCount > cap) {
    return `guestCount cannot exceed room capacity (${cap})`;
  }
  return null;
}

function bookingPayloadFromRecord(booking, room, quoteExtras = {}) {
  const roomName = room?.name || quoteExtras.roomName;
  return {
    _id: booking._id,
    trackingCode: booking.trackingCode,
    checkIn: booking.checkIn,
    checkOut: booking.checkOut,
    guestCount: booking.guestCount,
    foodAddOns: booking.foodAddOns,
    roomAmount: booking.roomAmount,
    foodAmount: booking.foodAmount,
    roomTotal: booking.roomAmount,
    foodTotal: booking.foodAmount,
    totalAmount: booking.totalAmount,
    deposit: booking.deposit,
    pricingBreakdown: booking.pricingBreakdown,
    lineItems: booking.pricingBreakdown?.lineItems,
    nights: booking.pricingBreakdown?.nights,
    status: booking.status,
    roomName,
    roomType: room?.type,
    currency: 'ZAR',
    debtorId: booking.debtorId,
    roomRevenueTransactionId: booking.roomRevenueTransactionId,
    foodRevenueTransactionId: booking.foodRevenueTransactionId,
    revenueTransactionId: booking.revenueTransactionId,
  };
}
const getFoodAddOnCatalogue = asyncHandler(async (_req, res) => {
  res.json({ success: true, data: catalogueForApi() });
});

// Public: quote room + food add-ons before submitting
const quoteGuestBooking = asyncHandler(async (req, res) => {
  const { roomId, checkIn, checkOut } = req.query;
  if (!roomId || !checkIn || !checkOut) {
    return res.status(400).json({
      success: false,
      message: 'roomId, checkIn and checkOut are required',
    });
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
  const foodAddOns = foodAddOnsFromBody(req.query);
  const guestCount = resolveGuestCount(req.query, foodAddOns, bookingNights(checkIn, checkOut));
  if (Number.isNaN(guestCount)) {
    return res.status(400).json({ success: false, message: 'guestCount must be a valid non-negative number' });
  }
  const guestErr = validateFoodAddOnGuestCount(guestCount, foodAddOns, room.capacity);
  if (guestErr) {
    return res.status(400).json({ success: false, message: guestErr });
  }
  const pricePerNight = Number(room.pricePerNight);
  if (!Number.isFinite(pricePerNight) || pricePerNight < 0) {
    return res.status(400).json({ success: false, message: 'Room pricing is invalid; contact admin' });
  }
  const quote = computeStayQuote({
    pricePerNight,
    checkIn,
    checkOut,
    guestCount,
    foodAddOns,
    roomName: room.name,
  });
  const amounts = resolveBookingAmounts(req.query, quote);
  const breakdown = pricingBreakdownFromAmounts(quote, amounts, room.name);
  res.json({
    success: true,
    data: {
      roomId: room._id,
      roomName: room.name,
      roomType: room.type,
      capacity: room.capacity,
      currency: 'ZAR',
      ...quote,
      roomAmount: amounts.roomAmount,
      foodAmount: amounts.foodAmount,
      roomTotal: amounts.roomAmount,
      foodTotal: amounts.foodAmount,
      totalAmount: amounts.totalAmount,
      pricingBreakdown: breakdown,
      lineItems: breakdown.lineItems,
      deposit: amounts.totalAmount,
    },
  });
});

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
  const foodAddOns = foodAddOnsFromBody(req.body);
  const guestCount = resolveGuestCount(req.body, foodAddOns, nights);
  if (Number.isNaN(guestCount)) {
    return res.status(400).json({ success: false, message: 'guestCount must be a valid non-negative number' });
  }
  const guestErr = validateFoodAddOnGuestCount(guestCount, foodAddOns, room.capacity);
  if (guestErr) {
    return res.status(400).json({ success: false, message: guestErr });
  }
  const quote = computeStayQuote({
    pricePerNight,
    checkIn,
    checkOut,
    guestCount,
    foodAddOns,
    roomName: room.name,
  });
  const amounts = resolveBookingAmounts(req.body, quote);
  const totalAmount = amounts.totalAmount;
  if (!Number.isFinite(totalAmount) || totalAmount < 0) {
    return res.status(400).json({ success: false, message: 'Calculated totalAmount is invalid' });
  }
  const clientFood = Number(req.body.foodAmount);
  if (Number.isFinite(clientFood) && clientFood > 0 && amounts.foodAmount <= 0) {
    return res.status(400).json({
      success: false,
      message: 'Food add-ons could not be applied. Send foodAddons (e.g. ["breakfast"]) and foodAmount or guestCount.',
    });
  }
  const pricingBreakdown = pricingBreakdownFromAmounts(quote, amounts, room.name);
  const deposit = resolveDeposit(req.body.deposit, totalAmount);

  const booking = await GuestBooking.create({
    guestName,
    guestEmail: cleanEmail,
    guestPhone,
    roomId: resolvedRoomId,
    checkIn,
    checkOut,
    guestCount,
    foodAddOns,
    pricingBreakdown,
    roomAmount: amounts.roomAmount,
    foodAmount: amounts.foodAmount,
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
    guestCount,
    foodAddOns,
    pricingBreakdown: booking.pricingBreakdown,
    lineItems: pricingBreakdown.lineItems,
    roomAmount: amounts.roomAmount,
    foodAmount: amounts.foodAmount,
    roomTotal: amounts.roomAmount,
    foodTotal: amounts.foodAmount,
    totalAmount: booking.totalAmount,
    deposit: booking.deposit,
    trackingCode: booking.trackingCode,
    notes,
    source: booking.source,
    guestBookingId: booking._id,
  });
  res.status(201).json({
    success: true,
    data: bookingPayloadFromRecord(booking, room),
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
    .select('guestName guestEmail checkIn checkOut guestCount foodAddOns roomAmount foodAmount pricingBreakdown totalAmount deposit status trackingCode roomId roomRevenueTransactionId foodRevenueTransactionId revenueTransactionId debtorId');
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

/** Admin: post or repair split room + food revenue transactions */
const postGuestBookingRevenue = asyncHandler(async (req, res) => {
  const booking = await GuestBooking.findById(req.params.id);
  if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
  if (booking.status !== 'confirmed') {
    return res.status(400).json({
      success: false,
      message: 'Booking must be confirmed before posting revenue',
    });
  }
  try {
    const result = await bookingRevenueService.postGuestBookingRevenue(booking, req.user._id);
    const updated = await GuestBooking.findById(booking._id).populate('roomId', 'name type').lean();
    return res.json({
      success: true,
      data: withRoomPreview(updated),
      revenue: result,
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      message: err.message || 'Could not post room & food revenue',
      hint: 'Ensure chart of accounts is seeded: npm run seed:accounting',
    });
  }
});

const deleteGuestBooking = asyncHandler(async (req, res) => {
  const booking = await GuestBooking.findById(req.params.id);
  if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

  const before = booking.toObject();

  // Keep ledger/debtor/invoice consistent when deleting a previously confirmed booking.
  if (booking.status === 'confirmed' && (booking.revenueTransactionId || booking.roomRevenueTransactionId)) {
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
  getFoodAddOnCatalogue,
  quoteGuestBooking,
  createGuestBooking,
  trackBooking,
  getAllGuestBookings,
  updateGuestBooking,
  postGuestBookingRevenue,
  deleteGuestBooking,
};
