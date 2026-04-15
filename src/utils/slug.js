/**
 * URL-safe slug from display text.
 */
function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .trim()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * @param {import('mongoose').Model} Room
 * @param {string} baseName - usually room name
 * @param {import('mongoose').Types.ObjectId} [excludeId]
 */
async function ensureUniqueRoomSlug(Room, baseName, excludeId) {
  let base = slugify(baseName);
  if (!base) base = 'room';
  let slug = base;
  let n = 0;
  for (;;) {
    const q = { slug };
    if (excludeId) q._id = { $ne: excludeId };
    // eslint-disable-next-line no-await-in-loop
    const exists = await Room.findOne(q).select('_id').lean();
    if (!exists) return slug;
    n += 1;
    slug = `${base}-${n}`;
  }
}

module.exports = { slugify, ensureUniqueRoomSlug };
