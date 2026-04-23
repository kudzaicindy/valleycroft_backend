const Room = require('../models/Room');
const GuestBooking = require('../models/GuestBooking');
const Booking = require('../models/Booking');
const { asyncHandler } = require('../utils/helpers');
const logAudit = require('../utils/audit');
const { isRoomAvailableForDates, getBookingsForRoomInRange } = require('../utils/availability');
const { uploadToS3, getUploadKey } = require('../middleware/upload');
const { ensureUniqueRoomSlug } = require('../utils/slug');

const ROOM_FIELDS = [
  'name',
  'description',
  'type',
  'roomType',
  'spaceCategory',
  'beds',
  'bathrooms',
  'capacity',
  'pricePerNight',
  'amenities',
  'images',
  'isAvailable',
  'order',
  'featuredOnLanding',
  'landingOrder',
  'slug',
];

function pickRoomPayload(body) {
  const out = {};
  for (const k of ROOM_FIELDS) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  return out;
}

function s3Configured() {
  return !!(
    (process.env.AWS_S3_BUCKET || process.env.AWS_BUCKET_NAME) &&
    process.env.AWS_REGION &&
    (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY) &&
    (process.env.AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_KEY)
  );
}

const publicSelect =
  'name slug description type roomType spaceCategory beds bathrooms capacity pricePerNight amenities images order featuredOnLanding landingOrder isAvailable _id createdAt updatedAt';

function imageBaseUrlFromReq(req) {
  const explicit = String(process.env.ASSET_BASE_URL || process.env.PUBLIC_BASE_URL || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  // Prefer first non-localhost frontend URL when configured (comma-separated supported).
  const frontendCandidates = String(process.env.FRONTEND_URL || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const publicFrontend = frontendCandidates.find((u) => /^https?:\/\//i.test(u) && !/localhost|127\.0\.0\.1/i.test(u));
  if (publicFrontend) return publicFrontend.replace(/\/+$/, '');

  const host = String(req.get('host') || '').trim();
  // In production, never emit localhost asset URLs.
  if (process.env.NODE_ENV === 'production' && /localhost|127\.0\.0\.1/i.test(host)) {
    return '';
  }
  return `${req.protocol}://${host}`;
}

function s3PublicBaseUrl() {
  const bucket = String(process.env.AWS_S3_BUCKET || process.env.AWS_BUCKET_NAME || '').trim();
  const region = String(process.env.AWS_REGION || '').trim();
  if (!bucket || !region) return '';
  return `https://${bucket}.s3.${region}.amazonaws.com`;
}

function legacyPathToS3PublicUrl(pathname) {
  const s3Base = s3PublicBaseUrl();
  if (!s3Base) return '';
  const cleanPath = String(pathname || '').trim();
  if (!cleanPath) return '';
  const leaf = cleanPath.split('/').filter(Boolean).pop();
  if (!leaf) return '';
  const normalizedLeaf = decodeURIComponent(leaf).replace(/\s+/g, '+');
  return `${s3Base}/public/${normalizedLeaf}`;
}

function normalizeImageUrl(url, req) {
  const raw = String(url || '').trim();
  if (!raw) return raw;
  const base = imageBaseUrlFromReq(req);
  if (/^https?:\/\//i.test(raw)) {
    // Rewrite legacy localhost absolute URLs to public base.
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(raw)) {
      const parsed = new URL(raw);
      const s3Url = legacyPathToS3PublicUrl(parsed.pathname);
      if (s3Url) return s3Url;
      if (base) return `${base}${parsed.pathname}`;
    }
    return raw;
  }
  const s3Url = legacyPathToS3PublicUrl(raw);
  if (s3Url) return s3Url;
  if (!base) return raw;
  const path = raw.startsWith('/') ? raw : `/${raw}`;
  return `${base}${path}`;
}

function withNormalizedRoomImages(room, req) {
  if (!room || !Array.isArray(room.images)) return room;
  return {
    ...room,
    images: room.images.map((img) => ({
      ...img,
      url: normalizeImageUrl(img.url, req),
    })),
  };
}

// Public: landing / marketing gallery — rooms flagged for homepage carousel
const getLandingGallery = asyncHandler(async (req, res) => {
  const rooms = await Room.find({
    featuredOnLanding: true,
    'images.0': { $exists: true },
  })
    .sort({ landingOrder: 1, order: 1, name: 1 })
    .lean()
    .select('name slug description type roomType spaceCategory beds bathrooms images landingOrder order pricePerNight capacity');
  res.json({ success: true, data: rooms.map((room) => withNormalizedRoomImages(room, req)) });
});

// Admin / CEO: all rooms (including unavailable) for back-office UI
const getRoomsManage = asyncHandler(async (req, res) => {
  const rooms = await Room.find({}).sort({ order: 1, name: 1 }).lean().select(publicSelect);
  res.json({ success: true, data: rooms.map((room) => withNormalizedRoomImages(room, req)) });
});

// Public: list bookable rooms. Optional ?checkIn= & ?checkOut= for availability.
const getRooms = asyncHandler(async (req, res) => {
  const { checkIn, checkOut } = req.query;
  const rooms = await Room.find({ isAvailable: true })
    .sort({ order: 1, name: 1 })
    .lean()
    .select(publicSelect);
  if (checkIn && checkOut) {
    const withAvailability = await Promise.all(
      rooms.map(async (room) => {
        const availableForDates = await isRoomAvailableForDates(room._id, checkIn, checkOut);
        const out = { ...withNormalizedRoomImages(room, req), availableForDates };
        if (!availableForDates) {
          out.bookedBy = await getBookingsForRoomInRange(room._id, checkIn, checkOut);
        }
        return out;
      })
    );
    return res.json({ success: true, data: withAvailability });
  }
  res.json({ success: true, data: rooms.map((room) => withNormalizedRoomImages(room, req)) });
});

// Public: single room by Mongo _id
const getRoomById = asyncHandler(async (req, res) => {
  const { checkIn, checkOut } = req.query;
  const room = await Room.findOne({ _id: req.params.id, isAvailable: true }).lean().select(publicSelect);
  if (!room) {
    return res.status(404).json({ success: false, message: 'Room not found' });
  }
  const normalizedRoom = withNormalizedRoomImages(room, req);
  if (checkIn && checkOut) {
    normalizedRoom.availableForDates = await isRoomAvailableForDates(room._id, checkIn, checkOut);
    if (!normalizedRoom.availableForDates) {
      normalizedRoom.bookedBy = await getBookingsForRoomInRange(room._id, checkIn, checkOut);
    }
  }
  res.json({ success: true, data: normalizedRoom });
});

// Public: single room by slug (for pretty URLs)
const getRoomBySlug = asyncHandler(async (req, res) => {
  const { checkIn, checkOut } = req.query;
  const slug = String(req.params.slug || '')
    .trim()
    .toLowerCase();
  const room = await Room.findOne({ slug, isAvailable: true }).lean().select(publicSelect);
  if (!room) {
    return res.status(404).json({ success: false, message: 'Room not found' });
  }
  const normalizedRoom = withNormalizedRoomImages(room, req);
  if (checkIn && checkOut) {
    normalizedRoom.availableForDates = await isRoomAvailableForDates(room._id, checkIn, checkOut);
    if (!normalizedRoom.availableForDates) {
      normalizedRoom.bookedBy = await getBookingsForRoomInRange(room._id, checkIn, checkOut);
    }
  }
  res.json({ success: true, data: normalizedRoom });
});

const getRoomBookings = asyncHandler(async (req, res) => {
  const room = await Room.findById(req.params.id).lean();
  if (!room) return res.status(404).json({ success: false, message: 'Room not found' });
  const { checkIn, checkOut } = req.query;
  const guestQuery = { roomId: req.params.id, status: { $nin: ['cancelled'] } };
  const internalQuery = { roomId: req.params.id, status: { $nin: ['cancelled'] } };
  if (checkIn && checkOut) {
    const start = new Date(checkIn);
    const end = new Date(checkOut);
    guestQuery.checkIn = { $lt: end };
    guestQuery.checkOut = { $gt: start };
    internalQuery.checkIn = { $lt: end };
    internalQuery.checkOut = { $gt: start };
  }
  const [guestBookings, internalBookings] = await Promise.all([
    GuestBooking.find(guestQuery)
      .sort({ checkIn: 1 })
      .lean()
      .select('guestName guestEmail guestPhone checkIn checkOut status trackingCode totalAmount deposit'),
    Booking.find(internalQuery)
      .sort({ checkIn: 1 })
      .lean()
      .select('guestName guestEmail guestPhone type checkIn checkOut eventDate status amount deposit'),
  ]);
  const guestRows = guestBookings.map((b) => ({
    ...b,
    bookingSource: 'guest',
    bookingAmount: b.totalAmount ?? 0,
    roomName: room.name,
    roomType: room.type,
  }));
  const internalRows = internalBookings.map((b) => ({
    ...b,
    bookingSource: 'internal',
    bookingAmount: b.amount ?? 0,
    roomName: room.name,
    roomType: room.type,
  }));
  const data = [...guestRows, ...internalRows].sort(
    (a, b) => new Date(a.checkIn || a.eventDate || 0) - new Date(b.checkIn || b.eventDate || 0)
  );
  res.json({ success: true, data });
});

const createRoom = asyncHandler(async (req, res) => {
  const payload = pickRoomPayload(req.body);
  if (!payload.name || !payload.type) {
    return res.status(400).json({ success: false, message: 'name and type are required' });
  }
  if (payload.slug) {
    payload.slug = String(payload.slug).trim().toLowerCase();
  } else {
    payload.slug = await ensureUniqueRoomSlug(Room, payload.name);
  }
  const room = await Room.create(payload);
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

const updateRoom = asyncHandler(async (req, res) => {
  const room = await Room.findById(req.params.id);
  if (!room) return res.status(404).json({ success: false, message: 'Room not found' });
  const before = room.toObject();
  const payload = pickRoomPayload(req.body);
  if (payload.slug !== undefined) {
    payload.slug = String(payload.slug).trim().toLowerCase();
    const taken = await Room.findOne({ slug: payload.slug, _id: { $ne: room._id } })
      .select('_id')
      .lean();
    if (taken) {
      return res.status(400).json({ success: false, message: 'slug already in use' });
    }
  }
  Object.assign(room, payload);
  if (!room.slug && room.name) {
    room.slug = await ensureUniqueRoomSlug(Room, room.name, room._id);
  }
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

/** POST multipart: field name `images` (max 15 files). Appends to room.images after S3 upload. */
const uploadRoomImages = asyncHandler(async (req, res) => {
  if (!s3Configured()) {
    return res.status(503).json({
      success: false,
      message:
        'File upload is not configured (set AWS_REGION plus bucket/keys: AWS_S3_BUCKET or AWS_BUCKET_NAME; AWS_ACCESS_KEY_ID or AWS_ACCESS_KEY; AWS_SECRET_ACCESS_KEY or AWS_SECRET_KEY)',
    });
  }
  const room = await Room.findById(req.params.id);
  if (!room) return res.status(404).json({ success: false, message: 'Room not found' });
  const files = req.files || [];
  if (!files.length) {
    return res.status(400).json({ success: false, message: 'No image files (use field name "images")' });
  }
  const maxOrder = (room.images || []).reduce((m, im) => Math.max(m, Number(im.order) || 0), -1);
  const imageCountBefore = room.images.length;
  const uploaded = [];
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const key = getUploadKey(file.originalname, `uploads/rooms/${room._id}`);
    // eslint-disable-next-line no-await-in-loop
    const url = await uploadToS3(file.buffer, key, file.mimetype);
    room.images.push({
      url,
      caption: '',
      order: maxOrder + 1 + i,
    });
    uploaded.push(url);
  }
  await room.save();
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'update',
    entity: 'Room',
    entityId: room._id,
    before: { imageCount: imageCountBefore },
    after: { imageCount: room.images.length, uploadedUrls: uploaded },
    req,
  });
  res.status(201).json({ success: true, data: { room, uploadedUrls: uploaded } });
});

/** JSON body: { "url": "https://..." } or { "urls": ["...", "..."] } — removes matching image(s) */
const removeRoomImages = asyncHandler(async (req, res) => {
  const room = await Room.findById(req.params.id);
  if (!room) return res.status(404).json({ success: false, message: 'Room not found' });
  const { url, urls } = req.body || {};
  const toRemove = new Set();
  if (url) toRemove.add(String(url).trim());
  if (Array.isArray(urls)) urls.forEach((u) => toRemove.add(String(u).trim()));
  if (!toRemove.size) {
    return res.status(400).json({ success: false, message: 'Provide url or urls[]' });
  }
  const beforeCount = room.images.length;
  room.images = room.images.filter((im) => !toRemove.has(String(im.url).trim()));
  const removed = beforeCount - room.images.length;
  if (removed === 0) {
    return res.status(404).json({ success: false, message: 'No matching image URLs on this room' });
  }
  await room.save();
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'update',
    entity: 'Room',
    entityId: room._id,
    req,
  });
  res.json({ success: true, data: room, removed });
});

const deleteRoom = asyncHandler(async (req, res) => {
  const room = await Room.findById(req.params.id);
  if (!room) return res.status(404).json({ success: false, message: 'Room not found' });
  const [guestCount, internalCount] = await Promise.all([
    GuestBooking.countDocuments({ roomId: room._id, status: { $nin: ['cancelled'] } }),
    Booking.countDocuments({ roomId: room._id, status: { $nin: ['cancelled', 'checked-out'] } }),
  ]);
  if (guestCount + internalCount > 0) {
    return res.status(400).json({
      success: false,
      message:
        'Room has active bookings. Cancel or complete them (or clear room on those bookings) before deleting.',
      meta: { guestBookings: guestCount, internalBookings: internalCount },
    });
  }
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

module.exports = {
  getRooms,
  getRoomsManage,
  getLandingGallery,
  getRoomById,
  getRoomBySlug,
  getRoomBookings,
  createRoom,
  updateRoom,
  deleteRoom,
  uploadRoomImages,
  removeRoomImages,
};
