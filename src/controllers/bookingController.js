const Booking = require('../models/Booking');
const { asyncHandler, getPagination } = require('../utils/helpers');
const logAudit = require('../utils/audit');
const { withRoomPreviewMany, withRoomPreview } = require('../utils/bookingPreview');
const bookingRevenueService = require('../services/bookingRevenueService');
const { scheduleInternalBookingCreatedAdmin } = require('../services/invoiceNotifyService');

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
  const booking = await Booking.create({ ...req.body, createdBy: req.user._id });
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
  Object.assign(booking, req.body);
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
