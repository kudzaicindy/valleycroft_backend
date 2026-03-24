const Debtor = require('../models/Debtor');
const { asyncHandler, getPagination } = require('../utils/helpers');
const logAudit = require('../utils/audit');

const list = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const { skip, limit: lim } = getPagination(page, limit);
  const [data, total] = await Promise.all([
    Debtor.find().sort({ createdAt: -1 }).skip(skip).limit(lim).lean(),
    Debtor.countDocuments(),
  ]);
  res.json({ success: true, data, meta: { page: parseInt(page, 10), limit: lim, total } });
});

const create = asyncHandler(async (req, res) => {
  const debtor = await Debtor.create({ ...req.body, createdBy: req.user._id });
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'create',
    entity: 'Debtor',
    entityId: debtor._id,
    after: debtor.toObject(),
    req,
  });
  res.status(201).json({ success: true, data: debtor });
});

const update = asyncHandler(async (req, res) => {
  const debtor = await Debtor.findById(req.params.id);
  if (!debtor) return res.status(404).json({ success: false, message: 'Debtor not found' });
  const before = debtor.toObject();
  Object.assign(debtor, req.body);
  await debtor.save();
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'update',
    entity: 'Debtor',
    entityId: debtor._id,
    before,
    after: debtor.toObject(),
    req,
  });
  res.json({ success: true, data: debtor });
});

const remove = asyncHandler(async (req, res) => {
  const debtor = await Debtor.findById(req.params.id);
  if (!debtor) return res.status(404).json({ success: false, message: 'Debtor not found' });
  const before = debtor.toObject();
  await debtor.deleteOne();
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'delete',
    entity: 'Debtor',
    entityId: req.params.id,
    before,
    req,
  });
  res.json({ success: true, message: 'Debtor removed' });
});

module.exports = { list, create, update, remove };
