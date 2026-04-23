const Expense = require('../models/Expense');
const { asyncHandler, getPagination } = require('../utils/helpers');
const logAudit = require('../utils/audit');

const list = asyncHandler(async (req, res) => {
  const { page = 1, limit = 50, from, to, expenseKind, staff, supplier } = req.query;
  const { skip, limit: lim } = getPagination(page, limit);
  const filter = {};
  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = new Date(from);
    if (to) filter.date.$lte = new Date(to);
  }
  if (expenseKind) filter.expenseKind = String(expenseKind);
  if (staff) filter.staff = staff;
  if (supplier) filter.supplier = supplier;

  const [data, total] = await Promise.all([
    Expense.find(filter)
      .sort({ date: -1, createdAt: -1 })
      .skip(skip)
      .limit(lim)
      .populate('staff', 'name email')
      .populate('supplier', 'name')
      .populate('transaction', 'type amount category date')
      .lean(),
    Expense.countDocuments(filter),
  ]);
  res.json({
    success: true,
    data,
    meta: { page: parseInt(page, 10), limit: lim, total },
  });
});

const getById = asyncHandler(async (req, res) => {
  const doc = await Expense.findById(req.params.id)
    .populate('staff', 'name email')
    .populate('supplier', 'name')
    .populate('transaction', 'type amount category date description');
  if (!doc) return res.status(404).json({ success: false, message: 'Expense not found' });
  res.json({ success: true, data: doc });
});

const create = asyncHandler(async (req, res) => {
  const doc = await Expense.create({ ...req.body, createdBy: req.user._id });
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'create',
    entity: 'Expense',
    entityId: doc._id,
    after: doc.toObject(),
    req,
  });
  res.status(201).json({ success: true, data: doc });
});

const update = asyncHandler(async (req, res) => {
  const doc = await Expense.findById(req.params.id);
  if (!doc) return res.status(404).json({ success: false, message: 'Expense not found' });
  const before = doc.toObject();
  Object.assign(doc, req.body);
  await doc.save();
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'update',
    entity: 'Expense',
    entityId: doc._id,
    before,
    after: doc.toObject(),
    req,
  });
  res.json({ success: true, data: doc });
});

const remove = asyncHandler(async (req, res) => {
  const doc = await Expense.findById(req.params.id);
  if (!doc) return res.status(404).json({ success: false, message: 'Expense not found' });
  const before = doc.toObject();
  await doc.deleteOne();
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'delete',
    entity: 'Expense',
    entityId: req.params.id,
    before,
    req,
  });
  res.json({ success: true, message: 'Deleted' });
});

module.exports = { list, getById, create, update, remove };
