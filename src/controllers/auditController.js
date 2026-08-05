const AuditLog = require('../models/AuditLog');
// Ensures the User schema is registered before populate runs.
require('../models/User');
const { asyncHandler, getPagination } = require('../utils/helpers');

const SENSITIVE_KEYS = new Set([
  'password',
  '__v',
  'createdAt',
  'updatedAt',
]);

function isPlainObject(v) {
  return v != null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
}

function serializeValue(v) {
  if (v == null) return v;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object' && v._id != null && Object.keys(v).length <= 3) {
    return String(v._id);
  }
  if (typeof v === 'object' && typeof v.toString === 'function' && v.constructor?.name === 'ObjectId') {
    return String(v);
  }
  return v;
}

function valuesEqual(a, b) {
  return JSON.stringify(serializeValue(a)) === JSON.stringify(serializeValue(b));
}

/** Field-level diff for update audits (top-level keys). */
function buildChanges(before, after) {
  if (!isPlainObject(before) && !isPlainObject(after)) return null;
  const from = isPlainObject(before) ? before : {};
  const to = isPlainObject(after) ? after : {};
  const keys = new Set([...Object.keys(from), ...Object.keys(to)]);
  const changes = [];
  for (const key of keys) {
    if (SENSITIVE_KEYS.has(key)) continue;
    if (valuesEqual(from[key], to[key])) continue;
    changes.push({
      field: key,
      from: serializeValue(from[key]),
      to: serializeValue(to[key]),
    });
  }
  return changes;
}

function stripSensitive(obj) {
  if (!isPlainObject(obj)) return obj;
  const out = { ...obj };
  for (const key of SENSITIVE_KEYS) {
    if (key in out) delete out[key];
  }
  return out;
}

function summarizeAudit(row) {
  const userDoc = row.userId && typeof row.userId === 'object' ? row.userId : null;
  const userId = userDoc?._id ? String(userDoc._id) : row.userId ? String(row.userId) : null;
  const before = stripSensitive(row.before);
  const after = stripSensitive(row.after);

  let changes = null;
  let summary = '';

  if (row.action === 'update') {
    changes = buildChanges(before, after) || [];
    summary =
      changes.length > 0
        ? `Updated ${row.entity || 'record'}: ${changes.map((c) => c.field).join(', ')}`
        : `Updated ${row.entity || 'record'}`;
  } else if (row.action === 'delete') {
    summary = `Deleted ${row.entity || 'record'}`;
    changes = null;
  } else if (row.action === 'create') {
    summary = `Created ${row.entity || 'record'}`;
  } else {
    summary = `${String(row.action || 'action')} ${row.entity || ''}`.trim();
  }

  const user = {
    _id: userId,
    id: userId,
    name: userDoc?.name?.trim() || null,
    email: userDoc?.email || null,
    role: userDoc?.role || row.role || null,
  };
  const displayName = user.email || user.name || 'Unknown user';

  return {
    _id: row._id,
    action: row.action,
    entity: row.entity,
    entityId: row.entityId,
    role: row.role,
    /** Populated actor — frontends reading `userId.email` keep working */
    userId: user,
    userIdString: userId,
    user,
    userEmail: user.email,
    userName: user.name,
    userRole: user.role,
    performedBy: displayName,
    performedByEmail: user.email,
    summary,
    changes,
    /** Full snapshot shown for deletes */
    deleted: row.action === 'delete' ? before || null : null,
    before: before ?? null,
    after: after ?? null,
    ip: row.ip,
    userAgent: row.userAgent,
    timestamp: row.timestamp,
  };
}

function withAuditDetails(rows) {
  return (rows || []).map(summarizeAudit);
}

const USER_POPULATE = { path: 'userId', select: 'name email role' };

const list = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, userId, entity, action, start, end } = req.query;
  const { skip, limit: lim } = getPagination(page, limit);
  const filter = {};
  if (userId) filter.userId = userId;
  if (entity) filter.entity = entity;
  if (action) filter.action = action;
  if (start || end) {
    filter.timestamp = {};
    if (start) filter.timestamp.$gte = new Date(start);
    if (end) filter.timestamp.$lte = new Date(end);
  }
  const [rows, total] = await Promise.all([
    AuditLog.find(filter)
      .populate(USER_POPULATE)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(lim)
      .lean(),
    AuditLog.countDocuments(filter),
  ]);
  res.json({
    success: true,
    data: withAuditDetails(rows),
    meta: { page: parseInt(page, 10), limit: lim, total },
  });
});

const getByEntity = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const { skip, limit: lim } = getPagination(page, limit);
  const [rows, total] = await Promise.all([
    AuditLog.find({ entity: req.params.name })
      .populate(USER_POPULATE)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(lim)
      .lean(),
    AuditLog.countDocuments({ entity: req.params.name }),
  ]);
  res.json({
    success: true,
    data: withAuditDetails(rows),
    meta: { page: parseInt(page, 10), limit: lim, total },
  });
});

const getByUser = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const { skip, limit: lim } = getPagination(page, limit);
  const [rows, total] = await Promise.all([
    AuditLog.find({ userId: req.params.id })
      .populate(USER_POPULATE)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(lim)
      .lean(),
    AuditLog.countDocuments({ userId: req.params.id }),
  ]);
  res.json({
    success: true,
    data: withAuditDetails(rows),
    meta: { page: parseInt(page, 10), limit: lim, total },
  });
});

module.exports = { list, getByEntity, getByUser };
