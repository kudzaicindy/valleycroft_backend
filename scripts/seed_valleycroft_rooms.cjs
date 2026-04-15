#!/usr/bin/env node
/**
 * Upsert the three BnB stays directly in MongoDB (no API, no JWT).
 * Image paths mirror public-site strings (e.g. /house%201living%20room.jpeg).
 *
 * Usage: npm run seed:rooms
 * Requires MONGO_URI (or MONGODB_URI) in .env — same as the API.
 *
 * Image URLs:
 * - If AWS_S3_BUCKET + AWS_REGION (or S3_PUBLIC_URL_BASE) are set → HTTPS URLs in the form
 *   https://<bucket>.s3.<region>.amazonaws.com/<prefix>/<filename>
 *   (same shape as upload middleware; default prefix: uploads → e.g. uploads/house 1 bed 2.jpeg).
 * - Otherwise → if FRONTEND_URL or ROOM_IMAGE_SITE_BASE is set → absolute HTTPS URLs to that origin + path.
 * - Else → relative path only (e.g. /house%201....jpeg).
 *
 * Idempotent: matches by exact `name` and updates; creates if missing.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const Room = require('../src/models/Room');

/** S3 object key prefix, e.g. uploads → https://<bucket>.s3.<region>.amazonaws.com/uploads/... */
const S3_PREFIX = (process.env.S3_ROOM_IMAGE_PREFIX || 'uploads').replace(/^\/+|\/+$/g, '');

function hasS3UrlConfig() {
  return !!(
    (process.env.S3_PUBLIC_URL_BASE || '').trim() ||
    (process.env.AWS_S3_BUCKET && process.env.AWS_REGION)
  );
}

function explainImageUrlMode() {
  const pub = (process.env.S3_PUBLIC_URL_BASE || '').trim();
  const bucket = (process.env.AWS_S3_BUCKET || '').trim();
  const region = (process.env.AWS_REGION || '').trim();
  if (pub) return { mode: 'cdn', detail: `S3_PUBLIC_URL_BASE=${pub}` };
  if (bucket && region) {
    return {
      mode: 's3',
      detail: `bucket=${bucket} region=${region} prefix=${S3_PREFIX}`,
    };
  }
  const site = resolveSiteImageOrigin();
  if (site) return { mode: 'site', detail: site };
  return {
    mode: 'relative',
    detail: 'Set AWS_S3_BUCKET + AWS_REGION (and optional S3_ROOM_IMAGE_PREFIX) for S3 HTTPS URLs',
  };
}

/** Use https for real hosts; keep http for localhost dev. */
function preferHttps(url) {
  const s = String(url || '').trim();
  if (!/^http:\/\//i.test(s)) return s;
  try {
    const { hostname } = new URL(s);
    if (hostname === 'localhost' || hostname === '127.0.0.1') return s;
  } catch {
    return s;
  }
  return s.replace(/^http:/i, 'https:');
}

/** First origin for image URLs when not using S3 (comma-separated FRONTEND_URL supported). */
function resolveSiteImageOrigin() {
  let raw = (process.env.ROOM_IMAGE_SITE_BASE || process.env.FRONTEND_URL || '')
    .split(',')[0]
    .trim()
    .replace(/\/$/, '');
  if (!raw) return '';
  if (!/^https?:\/\//i.test(raw)) {
    raw = `https://${raw.replace(/^\/+/, '')}`;
  }
  return preferHttps(raw);
}

function publicUrlForKey(key) {
  let base = (process.env.S3_PUBLIC_URL_BASE || '').trim().replace(/\/$/, '');
  if (base) {
    base = preferHttps(base);
    const path = String(key)
      .split('/')
      .map((s) => encodeURIComponent(s))
      .join('/');
    return `${base}/${path}`;
  }
  const bucket = process.env.AWS_S3_BUCKET;
  const region = process.env.AWS_REGION;
  const path = String(key)
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  return `https://${bucket}.s3.${region}.amazonaws.com/${path}`;
}

/**
 * @param {string} sitePath e.g. /house%201living%20room.jpeg
 */
function sitePathToImage(sitePath, order) {
  const relative = String(sitePath).replace(/^\//, '');
  const fileName = decodeURIComponent(relative);
  const key = `${S3_PREFIX}/${fileName}`;
  if (hasS3UrlConfig()) {
    return { url: publicUrlForKey(key), caption: '', order };
  }
  const origin = resolveSiteImageOrigin();
  if (origin) {
    return { url: `${origin}/${relative}`, caption: '', order };
  }
  return { url: `/${relative}`, caption: '', order };
}

/** Room.type enum: bnb | event-space */
const ROOMS = [
  {
    siteSlug: 'house-1',
    name: 'Willow Cottage',
    type: 'bnb',
    pricePerNight: 1920,
    capacity: 4,
    description:
      'Two-bedroom cottage on the farm — living spaces, bedrooms and bathroom. Ideal for small families or two couples. Tags: 2 Bedrooms, Full bathroom, Farm breakfast, WiFi. [site-slug: house-1] Style: cottage.',
    images: [
      '/house%201living%20room.jpeg',
      '/house%201living%20room%202.jpeg',
      '/house%201bed%201.jpeg',
      '/house%201%20bed%202.jpeg',
      '/house%201%20bathroom.jpeg',
    ],
    isAvailable: true,
    featuredOnLanding: true,
    landingOrder: 0,
    order: 0,
  },
  {
    siteSlug: 'house-2',
    name: 'Studio Flier',
    type: 'bnb',
    pricePerNight: 1280,
    capacity: 2,
    description:
      'One-bedroom hideaway — quiet and comfortable for solo travellers or couples. (Legacy display name on older records: Garden Nook.) Tags: 1 Bedroom, Countryside, WiFi. [site-slug: house-2] Style: studio.',
    images: [
      '/house%202%20living.jpeg',
      '/house%202%20living%202.jpeg',
      '/house%202%20living%203.jpeg',
      '/house%202%20bath%201.jpeg',
      '/house%202%20bath%202.jpeg',
    ],
    isAvailable: true,
    featuredOnLanding: true,
    landingOrder: 1,
    order: 1,
  },
  {
    siteSlug: 'house-3',
    name: 'The Blue House',
    type: 'bnb',
    pricePerNight: 3200,
    capacity: 8,
    description:
      'Spacious three-bedroom home — our signature blue house — with room for larger groups. Tags: 3 Bedrooms, Blue House, Groups, WiFi. [site-slug: house-3] Style: farmhouse.',
    images: [
      '/house%203%20living.jpeg',
      '/house%203%20bed%201.jpeg',
      '/house%203%20bed%202.jpeg',
      '/house%203%20kitchen.jpeg',
      '/house%203%20bath.jpeg',
    ],
    isAvailable: true,
    featuredOnLanding: true,
    landingOrder: 2,
    order: 2,
  },
];

async function main() {
  const uri = (process.env.MONGO_URI || process.env.MONGODB_URI || '').trim();
  if (!uri) {
    console.error('Missing MONGO_URI (or MONGODB_URI) in .env');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('Connected:', mongoose.connection.host, mongoose.connection.name);

  const urlInfo = explainImageUrlMode();
  console.log('Image URL mode:', urlInfo.mode, '|', urlInfo.detail);
  if (urlInfo.mode === 'relative') {
    console.warn(
      '[seed:rooms] Image URLs will stay as /... paths until AWS_S3_BUCKET and AWS_REGION are set in .env (same file as MONGO_URI).'
    );
  }

  const sampleImg = sitePathToImage(ROOMS[0].images[0], 0);
  console.log('Sample URL (first image of first room):', sampleImg.url);

  for (const room of ROOMS) {
    const { siteSlug, images: paths, name, ...rest } = room;
    const nameTrim = String(name).trim();
    const images = paths.map((p, i) => sitePathToImage(p, i));

    // Slug first (stable vs marketing site); then exact name — avoids "Updated" while UI still shows an old duplicate by name.
    let doc =
      (await Room.findOne({ slug: siteSlug })) || (await Room.findOne({ name: nameTrim }));
    const existed = !!doc;

    if (!doc) {
      doc = new Room({ name: nameTrim });
    }

    doc.set({
      ...rest,
      name: nameTrim,
      slug: siteSlug,
      images,
    });

    await doc.save();

    console.log(existed ? 'Updated' : 'Created', ':', room.name, `(${siteSlug})`, String(doc._id));
    console.log('  → first image:', images[0]?.url || '(none)');
  }

  console.log('Done. Three stays: Willow Cottage, Studio Flier, The Blue House.');
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
