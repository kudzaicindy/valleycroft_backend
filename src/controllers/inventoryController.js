const Stock = require('../models/Stock');
const Equipment = require('../models/Equipment');
const { asyncHandler, getPagination } = require('../utils/helpers');
const logAudit = require('../utils/audit');

// Stock
const getStock = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const { skip, limit: lim } = getPagination(page, limit);
  const [data, total] = await Promise.all([
    Stock.find().sort({ name: 1 }).skip(skip).limit(lim).lean(),
    Stock.countDocuments(),
  ]);
  res.json({ success: true, data, meta: { page: parseInt(page, 10), limit: lim, total } });
});

const createStock = asyncHandler(async (req, res) => {
  const stock = await Stock.create(req.body);
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'create',
    entity: 'Stock',
    entityId: stock._id,
    after: stock.toObject(),
    req,
  });
  res.status(201).json({ success: true, data: stock });
});

const updateStock = asyncHandler(async (req, res) => {
  const stock = await Stock.findById(req.params.id);
  if (!stock) return res.status(404).json({ success: false, message: 'Stock item not found' });
  const before = stock.toObject();
  Object.assign(stock, req.body);
  if (req.body.quantity !== undefined) stock.lastRestocked = new Date();
  await stock.save();
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'update',
    entity: 'Stock',
    entityId: stock._id,
    before,
    after: stock.toObject(),
    req,
  });
  res.json({ success: true, data: stock });
});

const deleteStock = asyncHandler(async (req, res) => {
  const stock = await Stock.findById(req.params.id);
  if (!stock) return res.status(404).json({ success: false, message: 'Stock item not found' });
  const before = stock.toObject();
  await stock.deleteOne();
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'delete',
    entity: 'Stock',
    entityId: req.params.id,
    before,
    req,
  });
  res.json({ success: true, message: 'Stock item removed' });
});

// Equipment
const getEquipment = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const { skip, limit: lim } = getPagination(page, limit);
  const [data, total] = await Promise.all([
    Equipment.find().sort({ name: 1 }).skip(skip).limit(lim).lean(),
    Equipment.countDocuments(),
  ]);
  res.json({ success: true, data, meta: { page: parseInt(page, 10), limit: lim, total } });
});

const createEquipment = asyncHandler(async (req, res) => {
  const equipment = await Equipment.create(req.body);
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'create',
    entity: 'Equipment',
    entityId: equipment._id,
    after: equipment.toObject(),
    req,
  });
  res.status(201).json({ success: true, data: equipment });
});

const updateEquipment = asyncHandler(async (req, res) => {
  const equipment = await Equipment.findById(req.params.id);
  if (!equipment) return res.status(404).json({ success: false, message: 'Equipment not found' });
  const before = equipment.toObject();
  Object.assign(equipment, req.body);
  await equipment.save();
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'update',
    entity: 'Equipment',
    entityId: equipment._id,
    before,
    after: equipment.toObject(),
    req,
  });
  res.json({ success: true, data: equipment });
});

module.exports = {
  getStock,
  createStock,
  updateStock,
  deleteStock,
  getEquipment,
  createEquipment,
  updateEquipment,
};
