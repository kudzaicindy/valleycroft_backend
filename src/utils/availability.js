const GuestBooking = require('../models/GuestBooking');
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
  const query = {
    roomId,
    status: { $nin: ['cancelled'] },
    checkIn: { $lt: end },
    checkOut: { $gt: start },
  };
  if (excludeGuestBookingId) query._id = { $ne: excludeGuestBookingId };
  const overlapping = await GuestBooking.findOne(query).lean();
  return !overlapping;
}

/**
 * Get guest bookings that overlap the given date range for a room (excludes cancelled).
 * Use to show "who booked" when a room is unavailable.
 */
async function getBookingsForRoomInRange(roomId, checkIn, checkOut) {
  const start = new Date(checkIn);
  const end = new Date(checkOut);
  const [room, bookings] = await Promise.all([
    Room.findById(roomId).lean().select('name type'),
    GuestBooking.find({
      roomId,
      status: { $nin: ['cancelled'] },
      checkIn: { $lt: end },
      checkOut: { $gt: start },
    })
      .lean()
      .select('guestName guestEmail guestPhone checkIn checkOut status trackingCode'),
  ]);
  const roomName = room?.name;
  const roomType = room?.type;
  return bookings.map((b) => ({ ...b, roomName, roomType }));
}

module.exports = { isRoomAvailableForDates, getBookingsForRoomInRange };
