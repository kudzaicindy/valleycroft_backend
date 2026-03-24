/**
 * Generate unique GL account codes (suffix with entity id, or numeric sequence).
 */
const Account = require('../models/Account');

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Next code in sequence: prefix + incrementing digits (e.g. prefix "1050" → 10501, 10502…).
 */
async function generateNumericSequenceCode(prefix) {
  const p = String(prefix).trim();
  const escaped = escapeRegex(p);
  const rows = await Account.find({ code: new RegExp(`^${escaped}\\d+$`) }).select('code').lean();
  let max = 0;
  for (const r of rows) {
    const rest = r.code.slice(p.length);
    const n = parseInt(rest, 10);
    if (!Number.isNaN(n)) max = Math.max(max, n);
  }
  const next = max + 1;
  return `${p}${next}`;
}

/**
 * @param {Object} options
 * @param {'suffix'|'numeric_sequence'} options.strategy
 * @param {string} [options.prefix='1010'] - parent AR bucket in seed; child = `${prefix}-${entityId}`
 * @param {string|import('mongoose').Types.ObjectId} [options.entityId] - required for suffix
 */
async function generateAccountCode(options = {}) {
  const strategy = options.strategy || 'suffix';
  const prefix = (options.prefix != null ? String(options.prefix) : '1010').trim();

  if (strategy === 'suffix') {
    const entityId = options.entityId;
    if (!entityId) throw new Error('entityId is required for strategy "suffix"');
    const base = `${prefix}-${String(entityId)}`;
    const clash = await Account.findOne({ code: base }).select('_id').lean();
    if (!clash) return base;
    return `${base}-${Date.now().toString(36)}`;
  }

  if (strategy === 'numeric_sequence') {
    return generateNumericSequenceCode(prefix);
  }

  throw new Error(`Unknown account code strategy: ${strategy}`);
}

/**
 * Preview / allocate a code without inserting (same logic as generateAccountCode for suffix).
 */
async function peekSuggestedCode(options) {
  return generateAccountCode(options);
}

module.exports = {
  generateAccountCode,
  generateNumericSequenceCode,
  peekSuggestedCode,
  escapeRegex,
};
