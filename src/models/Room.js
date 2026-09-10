const mongoose = require('mongoose');

/** Canonical `type` values accepted when creating/updating a space. */
const ROOM_TYPES = [
  'bnb',
  'event-space',
  'conference-venue',
  'event-venue',
  'garden-venue',
  'wedding-venue',
  'cottage',
  'lodge',
  'farmhouse',
  'suite',
  'other',
];

const ROOM_TYPE_OPTIONS = [
  'cottage',
  'event-venue',
  'lodge',
  'farmhouse',
  'suite',
  'conference-venue',
  'wedding-venue',
  'other',
];

const SPACE_CATEGORY_OPTIONS = ['room', 'event-hire'];

/** Accept common labels / typos and normalize to canonical enum values. */
const ROOM_TYPE_ALIASES = {
  'gaeden-venue': 'garden-venue',
  'event': 'event-space',
  'events': 'event-space',
  'eventspace': 'event-space',
  'event_space': 'event-space',
  'bnb-room': 'bnb',
  bedandbreakfast: 'bnb',
  'bed-and-breakfast': 'bnb',
  'b&b': 'bnb',
  'b and b': 'bnb',
  accommodation: 'bnb',
  stay: 'bnb',
  conference: 'conference-venue',
  venue: 'event-venue',
  garden: 'garden-venue',
  wedding: 'wedding-venue',
};

const ROOM_TYPE_OPTION_ALIASES = {
  'event venue': 'event-venue',
  'conference venue': 'conference-venue',
  'wedding venue': 'wedding-venue',
};

const SPACE_CATEGORY_ALIASES = {
  'event hire': 'event-hire',
  eventhire: 'event-hire',
  'event_hire': 'event-hire',
};

function normalizeEnumToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_/]+/g, '-')
    .replace(/\s+/g, '-');
}

const roomImageSchema = new mongoose.Schema(
  {
    url: { type: String, required: true, trim: true },
    caption: { type: String, default: '', trim: true },
    order: { type: Number, default: 0 },
  },
  { _id: false }
);

const roomSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    /** Stable path segment for `/rooms/:slug` style links */
    slug: { type: String, unique: true, sparse: true, trim: true, lowercase: true },
    description: { type: String, default: '' },
    type: { type: String, enum: ROOM_TYPES, required: true },
    roomType: { type: String, enum: ROOM_TYPE_OPTIONS },
    spaceCategory: { type: String, enum: SPACE_CATEGORY_OPTIONS },
    beds: { type: Number, min: 0 },
    bathrooms: { type: Number, min: 0 },
    capacity: { type: Number, min: 0 },
    pricePerNight: { type: Number, min: 0 },
    amenities: [{ type: String, trim: true }],
    /** Gallery photos (URLs from S3 upload or external). Sorted by `order` then array index. */
    images: { type: [roomImageSchema], default: [] },
    /** Show on marketing / landing gallery (carousel) */
    featuredOnLanding: { type: Boolean, default: false },
    /** Sort order within landing gallery (lower first) */
    landingOrder: { type: Number, default: 0 },
    isAvailable: { type: Boolean, default: true },
    /**
     * Calendar days admins have closed for booking (YYYY-MM-DD).
     * A stay that includes any of these nights (check-in inclusive, check-out exclusive) is unavailable.
     */
    blockedDates: {
      type: [String],
      default: [],
      validate: {
        validator(arr) {
          if (!Array.isArray(arr)) return false;
          return arr.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d)));
        },
        message: 'blockedDates must be YYYY-MM-DD strings',
      },
    },
    /** Sort order on public rooms list */
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

/** Legacy data may store `images` as plain URL strings */
roomSchema.pre('validate', function (next) {
  if (this.type != null) {
    const rawType = normalizeEnumToken(this.type);
    this.type = ROOM_TYPE_ALIASES[rawType] || ROOM_TYPE_ALIASES[String(this.type).trim().toLowerCase()] || rawType;
  }
  if (this.roomType != null) {
    const rawRoomType = String(this.roomType).trim().toLowerCase();
    this.roomType =
      ROOM_TYPE_OPTION_ALIASES[rawRoomType] ||
      normalizeEnumToken(this.roomType);
  }
  if (this.spaceCategory != null) {
    const rawCategory = String(this.spaceCategory).trim().toLowerCase();
    this.spaceCategory =
      SPACE_CATEGORY_ALIASES[rawCategory] ||
      normalizeEnumToken(this.spaceCategory);
  }
  if (this.blockedDates != null) {
    const seen = new Set();
    this.blockedDates = (Array.isArray(this.blockedDates) ? this.blockedDates : [])
      .map((d) => String(d || '').trim().slice(0, 10))
      .filter((d) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || seen.has(d)) return false;
        seen.add(d);
        return true;
      })
      .sort();
  }
  if (!Array.isArray(this.images)) {
    this.images = [];
    return next();
  }
  this.images = this.images.map((img, i) => {
    if (typeof img === 'string') {
      return { url: img, caption: '', order: i };
    }
    if (img && typeof img === 'object' && img.url) {
      return {
        url: String(img.url).trim(),
        caption: String(img.caption || '').trim(),
        order: Number.isFinite(Number(img.order)) ? Number(img.order) : i,
      };
    }
    return img;
  });
  next();
});

roomSchema.index({ order: 1 });
roomSchema.index({ featuredOnLanding: 1, landingOrder: 1 });
roomSchema.index({ isAvailable: 1, order: 1 });

module.exports = mongoose.model('Room', roomSchema);
module.exports.ROOM_TYPES = ROOM_TYPES;
module.exports.ROOM_TYPE_OPTIONS = ROOM_TYPE_OPTIONS;
module.exports.SPACE_CATEGORY_OPTIONS = SPACE_CATEGORY_OPTIONS;
