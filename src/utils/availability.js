const GuestBooking = require('../models/GuestBooking');
const Booking = require('../models/Booking');
const Room = require('../models/Room');

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Calendar YYYY-MM-DD in UTC for a Date / parseable string. */
function toDateOnlyUtc(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Nights occupied by a stay: each calendar day from check-in inclusive through check-out exclusive.
 * Same calendar day (e.g. event hire) counts as that single day.
 * @returns {string[]} YYYY-MM-DD
 */
function nightsInRange(checkIn, checkOut) {
  const start = toDateOnlyUtc(checkIn);
  const end = toDateOnlyUtc(checkOut);
  if (!start || !end || start > end) return [];
  if (start === end) return [start];
  const nights = [];
  const cursor = new Date(`${start}T00:00:00.000Z`);
  const endMs = Date.parse(`${end}T00:00:00.000Z`);
  while (cursor.getTime() < endMs) {
    nights.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return nights;
}

function roomHasBlockedOverlap(blockedDates, checkIn, checkOut) {
  if (!Array.isArray(blockedDates) || !blockedDates.length) return false;
  const blocked = new Set(
    blockedDates.map((d) => String(d || '').trim().slice(0, 10)).filter((d) => DATE_ONLY_RE.test(d))
  );
  if (!blocked.size) return false;
  return nightsInRange(checkIn, checkOut).some((night) => blocked.has(night));
}

/**
 * Check if a room is free for the given date range (excludes cancelled guest bookings).
 * Also returns false if any night in [checkIn, checkOut) is in the room's blockedDates.
 * @param {ObjectId|string} roomId - Room _id
 * @param {Date|string} checkIn - Start date
 * @param {Date|string} checkOut - End date
 * @param {ObjectId|string} [excludeGuestBookingId] - Optional guest booking id to exclude (e.g. when confirming)
 * @param {ObjectId|string} [excludeBookingId] - Optional internal booking id to exclude (e.g. when updating)
 * @returns {Promise<boolean>} - true if room is available for the dates
 */
async function isRoomAvailableForDates(roomId, checkIn, checkOut, excludeGuestBookingId = null, excludeBookingId = null) {
  const start = new Date(checkIn);
  const end = new Date(checkOut);
  const room = await Room.findById(roomId).lean().select('blockedDates');
  if (!room) return false;
  if (roomHasBlockedOverlap(room.blockedDates, start, end)) return false;

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
  if (excludeBookingId) internalQuery._id = { $ne: excludeBookingId };
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

module.exports = {
  isRoomAvailableForDates,
  getBookingsForRoomInRange,
  nightsInRange,
  roomHasBlockedOverlap,
};
