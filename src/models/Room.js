const mongoose = require('mongoose');

const ROOM_TYPES = [
  'bnb',
  'event-space',
  'conference-venue',
  'event-venue',
  'garden-venue',
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

/** Accept common legacy/typo labels and normalize to canonical enum values. */
const ROOM_TYPE_ALIASES = {
  'wedding-venue': 'event-venue',
  'gaeden-venue': 'garden-venue',
};

const ROOM_TYPE_OPTION_ALIASES = {
  'event venue': 'event-venue',
  'conference venue': 'conference-venue',
  'wedding venue': 'wedding-venue',
};

const SPACE_CATEGORY_ALIASES = {
  'event hire': 'event-hire',
};

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
    /** Sort order on public rooms list */
    order: { type: Number, default: 0 },
  },
  { timestamps: true }
);

/** Legacy data may store `images` as plain URL strings */
roomSchema.pre('validate', function (next) {
  if (this.type != null) {
    const rawType = String(this.type).trim().toLowerCase();
    this.type = ROOM_TYPE_ALIASES[rawType] || rawType;
  }
  if (this.roomType != null) {
    const rawRoomType = String(this.roomType).trim().toLowerCase();
    this.roomType = ROOM_TYPE_OPTION_ALIASES[rawRoomType] || rawRoomType.replace(/\s+/g, '-');
  }
  if (this.spaceCategory != null) {
    const rawCategory = String(this.spaceCategory).trim().toLowerCase();
    this.spaceCategory = SPACE_CATEGORY_ALIASES[rawCategory] || rawCategory.replace(/\s+/g, '-');
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
