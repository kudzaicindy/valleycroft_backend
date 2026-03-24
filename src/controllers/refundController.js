const Refund = require('../models/Refund');
const { asyncHandler, getPagination } = require('../utils/helpers');
const logAudit = require('../utils/audit');

const list = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const { skip, limit: lim } = getPagination(page, limit);
  const [data, total] = await Promise.all([
    Refund.find().sort({ createdAt: -1 }).skip(skip).limit(lim).lean(),
    Refund.countDocuments(),
  ]);
  res.json({ success: true, data, meta: { page: parseInt(page, 10), limit: lim, total } });
});

const create = asyncHandler(async (req, res) => {
  const refund = await Refund.create({ ...req.body, createdBy: req.user._id });
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'create',
    entity: 'Refund',
    entityId: refund._id,
    after: refund.toObject(),
    req,
  });
  res.status(201).json({ success: true, data: refund });
});

const update = asyncHandler(async (req, res) => {
  const refund = await Refund.findById(req.params.id);
  if (!refund) return res.status(404).json({ success: false, message: 'Refund not found' });
  const before = refund.toObject();
  if (req.body.status) {
    refund.status = req.body.status;
    if (['approved', 'processed', 'rejected'].includes(req.body.status)) {
      refund.processedBy = req.user._id;
      refund.processedOn = new Date();
    }
  }
  if (req.body.notes !== undefined) refund.notes = req.body.notes;
  await refund.save();
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'update',
    entity: 'Refund',
    entityId: refund._id,
    before,
    after: refund.toObject(),
    req,
  });
  res.json({ success: true, data: refund });
});

module.exports = { list, create, update };
