const GuestBooking = require('../models/GuestBooking');
const Booking = require('../models/Booking');
const Room = require('../models/Room');

/**
 * Check if a room is free for the given date range (excludes cancelled guest bookings).
 * @param {ObjectId|string} roomId - Room _id
 * @param {Date|string} checkIn - Start date
 * @param {Date|string} checkOut - End date
 * @param {ObjectId|string} [excludeGuestBookingId] - Optional booking id to exclude (e.g. when confirming)
 * @returns {Promise<boolean>} - true if room is available for the dates
 */
async function isRoomAvailableForDates(roomId, checkIn, checkOut, excludeGuestBookingId = null) {
  const start = new Date(checkIn);
  const end = new Date(checkOut);
  const guestQuery = {
    roomId,
    status: { $nin: ['cancelled'] },
    checkIn: { $lt: end },
    checkOut: { $gt: start },
  };
  if (excludeGuestBookingId) guestQuery._id = { $ne: excludeGuestBookingId };
  const internalQuery = {
    roomId,
    status: { $nin: ['cancelled'] },
    $or: [
      { checkIn: { $lt: end }, checkOut: { $gt: start } },
      { eventDate: { $gte: start, $lte: end } },
    ],
  };
  const [overlappingGuest, overlappingInternal] = await Promise.all([
    GuestBooking.findOne(guestQuery).lean(),
    Booking.findOne(internalQuery).lean(),
  ]);
  return !overlappingGuest && !overlappingInternal;
}

/**
 * Get guest bookings that overlap the given date range for a room (excludes cancelled).
 * Use to show "who booked" when a room is unavailable.
 */
async function getBookingsForRoomInRange(roomId, checkIn, checkOut) {
  const start = new Date(checkIn);
  const end = new Date(checkOut);
  const [room, guestBookings, internalBookings] = await Promise.all([
    Room.findById(roomId).lean().select('name type'),
    GuestBooking.find({
      roomId,
      status: { $nin: ['cancelled'] },
      checkIn: { $lt: end },
      checkOut: { $gt: start },
    })
      .lean()
      .select('checkIn checkOut status trackingCode'),
    Booking.find({
      roomId,
      status: { $nin: ['cancelled'] },
      $or: [
        { checkIn: { $lt: end }, checkOut: { $gt: start } },
        { eventDate: { $gte: start, $lte: end } },
      ],
    })
      .lean()
      .select('type checkIn checkOut eventDate status'),
  ]);
  const roomName = room?.name;
  const roomType = room?.type;
  return [
    ...guestBookings.map((b) => ({ ...b, bookingSource: 'guest', roomName, roomType })),
    ...internalBookings.map((b) => ({ ...b, bookingSource: 'internal', roomName, roomType })),
  ];
}

module.exports = { isRoomAvailableForDates, getBookingsForRoomInRange };
