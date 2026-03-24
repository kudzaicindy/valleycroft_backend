const AuditLog = require('../models/AuditLog');
const { asyncHandler, getPagination } = require('../utils/helpers');

const list = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, userId, entity, start, end } = req.query;
  const { skip, limit: lim } = getPagination(page, limit);
  const filter = {};
  if (userId) filter.userId = userId;
  if (entity) filter.entity = entity;
  if (start || end) {
    filter.timestamp = {};
    if (start) filter.timestamp.$gte = new Date(start);
    if (end) filter.timestamp.$lte = new Date(end);
  }
  const [data, total] = await Promise.all([
    AuditLog.find(filter).sort({ timestamp: -1 }).skip(skip).limit(lim).lean(),
    AuditLog.countDocuments(filter),
  ]);
  res.json({ success: true, data, meta: { page: parseInt(page, 10), limit: lim, total } });
});

const getByEntity = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const { skip, limit: lim } = getPagination(page, limit);
  const [data, total] = await Promise.all([
    AuditLog.find({ entity: req.params.name }).sort({ timestamp: -1 }).skip(skip).limit(lim).lean(),
    AuditLog.countDocuments({ entity: req.params.name }),
  ]);
  res.json({ success: true, data, meta: { page: parseInt(page, 10), limit: lim, total } });
});

const getByUser = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const { skip, limit: lim } = getPagination(page, limit);
  const [data, total] = await Promise.all([
    AuditLog.find({ userId: req.params.id }).sort({ timestamp: -1 }).skip(skip).limit(lim).lean(),
    AuditLog.countDocuments({ userId: req.params.id }),
  ]);
  res.json({ success: true, data, meta: { page: parseInt(page, 10), limit: lim, total } });
});

module.exports = { list, getByEntity, getByUser };
