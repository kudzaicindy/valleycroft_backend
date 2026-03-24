const Room = require('../models/Room');
const GuestBooking = require('../models/GuestBooking');
const { asyncHandler, getPagination } = require('../utils/helpers');
const logAudit = require('../utils/audit');
const { isRoomAvailableForDates, getBookingsForRoomInRange } = require('../utils/availability');

// Public: list all available rooms. Optional ?checkIn= & ?checkOut= to get availability for dates.
const getRooms = asyncHandler(async (req, res) => {
  const { checkIn, checkOut } = req.query;
  const rooms = await Room.find({ isAvailable: true })
    .sort({ order: 1 })
    .lean()
    .select('name description type capacity pricePerNight amenities images order _id');
  if (checkIn && checkOut) {
    const withAvailability = await Promise.all(
      rooms.map(async (room) => {
        const availableForDates = await isRoomAvailableForDates(room._id, checkIn, checkOut);
        const out = { ...room, availableForDates };
        if (!availableForDates) {
          out.bookedBy = await getBookingsForRoomInRange(room._id, checkIn, checkOut);
        }
        return out;
      })
    );
    return res.json({ success: true, data: withAvailability });
  }
  res.json({ success: true, data: rooms });
});

// Public: single room detail. Optional ?checkIn= & ?checkOut= to get availability for dates.
const getRoomById = asyncHandler(async (req, res) => {
  const { checkIn, checkOut } = req.query;
  const room = await Room.findOne({ _id: req.params.id, isAvailable: true })
    .lean()
    .select('name description type capacity pricePerNight amenities images _id');
  if (!room) {
    return res.status(404).json({ success: false, message: 'Room not found' });
  }
  if (checkIn && checkOut) {
    room.availableForDates = await isRoomAvailableForDates(room._id, checkIn, checkOut);
    if (!room.availableForDates) {
      room.bookedBy = await getBookingsForRoomInRange(room._id, checkIn, checkOut);
    }
  }
  res.json({ success: true, data: room });
});

// Public or Admin: list who booked this room. Optional ?checkIn= & ?checkOut= to filter by date range; otherwise returns all non-cancelled bookings.
const getRoomBookings = asyncHandler(async (req, res) => {
  const room = await Room.findById(req.params.id).lean();
  if (!room) return res.status(404).json({ success: false, message: 'Room not found' });
  const { checkIn, checkOut } = req.query;
  let query = { roomId: req.params.id, status: { $nin: ['cancelled'] } };
  if (checkIn && checkOut) {
    const start = new Date(checkIn);
    const end = new Date(checkOut);
    query.checkIn = { $lt: end };
    query.checkOut = { $gt: start };
  }
  const bookings = await GuestBooking.find(query)
    .sort({ checkIn: 1 })
    .lean()
    .select('guestName guestEmail guestPhone checkIn checkOut status trackingCode totalAmount deposit');
  const data = bookings.map((b) => ({
    ...b,
    roomName: room.name,
    roomType: room.type,
  }));
  res.json({ success: true, data });
});

// Admin: add room
const createRoom = asyncHandler(async (req, res) => {
  const room = await Room.create(req.body);
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'create',
    entity: 'Room',
    entityId: room._id,
    after: room.toObject(),
    req,
  });
  res.status(201).json({ success: true, data: room });
});

// Admin: update room
const updateRoom = asyncHandler(async (req, res) => {
  const room = await Room.findById(req.params.id);
  if (!room) return res.status(404).json({ success: false, message: 'Room not found' });
  const before = room.toObject();
  Object.assign(room, req.body);
  await room.save();
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'update',
    entity: 'Room',
    entityId: room._id,
    before,
    after: room.toObject(),
    req,
  });
  res.json({ success: true, data: room });
});

// Admin: remove room
const deleteRoom = asyncHandler(async (req, res) => {
  const room = await Room.findById(req.params.id);
  if (!room) return res.status(404).json({ success: false, message: 'Room not found' });
  const before = room.toObject();
  await room.deleteOne();
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'delete',
    entity: 'Room',
    entityId: req.params.id,
    before,
    req,
  });
  res.json({ success: true, message: 'Room removed' });
});

module.exports = { getRooms, getRoomById, getRoomBookings, createRoom, updateRoom, deleteRoom };
