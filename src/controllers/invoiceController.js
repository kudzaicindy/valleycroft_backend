const Invoice = require('../models/Invoice');
const { asyncHandler, getPagination } = require('../utils/helpers');
const logAudit = require('../utils/audit');

const list = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const { skip, limit: lim } = getPagination(page, limit);
  const [data, total] = await Promise.all([
    Invoice.find().sort({ issueDate: -1 }).skip(skip).limit(lim).lean(),
    Invoice.countDocuments(),
  ]);
  res.json({ success: true, data, meta: { page: parseInt(page, 10), limit: lim, total } });
});

const create = asyncHandler(async (req, res) => {
  const invoice = await Invoice.create({ ...req.body, createdBy: req.user._id });
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'create',
    entity: 'Invoice',
    entityId: invoice._id,
    after: invoice.toObject(),
    req,
  });
  res.status(201).json({ success: true, data: invoice });
});

const update = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findById(req.params.id);
  if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });
  const before = invoice.toObject();
  Object.assign(invoice, req.body);
  await invoice.save();
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'update',
    entity: 'Invoice',
    entityId: invoice._id,
    before,
    after: invoice.toObject(),
    req,
  });
  res.json({ success: true, data: invoice });
});

const getPdf = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findById(req.params.id).lean();
  if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });
  res.setHeader('Content-Type', 'application/json');
  res.json({ success: true, data: invoice });
});

module.exports = { list, create, update, getPdf };
