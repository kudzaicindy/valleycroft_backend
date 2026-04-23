const Supplier = require('../models/Supplier');
const SupplierPayment = require('../models/SupplierPayment');
const { asyncHandler, getPagination } = require('../utils/helpers');
const logAudit = require('../utils/audit');
const SUPPLIER_UPDATE_FIELDS = ['name', 'contactEmail', 'contactPhone', 'category', 'bankDetails', 'isActive', 'notes'];

function pickSupplierUpdates(body = {}) {
  const out = {};
  for (const key of SUPPLIER_UPDATE_FIELDS) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
}

const list = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const { skip, limit: lim } = getPagination(page, limit);
  const [data, total] = await Promise.all([
    Supplier.find().sort({ name: 1 }).skip(skip).limit(lim).lean(),
    Supplier.countDocuments(),
  ]);
  res.json({ success: true, data, meta: { page: parseInt(page, 10), limit: lim, total } });
});

const create = asyncHandler(async (req, res) => {
  const supplier = await Supplier.create({ ...req.body, createdBy: req.user._id });
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'create',
    entity: 'Supplier',
    entityId: supplier._id,
    after: supplier.toObject(),
    req,
  });
  res.status(201).json({ success: true, data: supplier });
});

const update = asyncHandler(async (req, res) => {
  const supplier = await Supplier.findById(req.params.id);
  if (!supplier) return res.status(404).json({ success: false, message: 'Supplier not found' });
  const before = supplier.toObject();
  Object.assign(supplier, pickSupplierUpdates(req.body));
  await supplier.save();
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'update',
    entity: 'Supplier',
    entityId: supplier._id,
    before,
    after: supplier.toObject(),
    req,
  });
  res.json({ success: true, data: supplier });
});

const getPayments = asyncHandler(async (req, res) => {
  const payments = await SupplierPayment.find({ supplier: req.params.id })
    .sort({ date: -1 })
    .lean();
  res.json({ success: true, data: payments });
});

const createPayment = asyncHandler(async (req, res) => {
  const payment = await SupplierPayment.create({ ...req.body, createdBy: req.user._id });
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'create',
    entity: 'SupplierPayment',
    entityId: payment._id,
    after: payment.toObject(),
    req,
  });
  res.status(201).json({ success: true, data: payment });
});

module.exports = { list, create, update, getPayments, createPayment };
