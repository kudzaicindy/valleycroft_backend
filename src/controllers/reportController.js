const Transaction = require('../models/Transaction');
const { asyncHandler } = require('../utils/helpers');
const logAudit = require('../utils/audit');

const runAggregation = async (start, end) => {
  const match = { date: { $gte: new Date(start), $lte: new Date(end) } };
  const income = await Transaction.aggregate([
    { $match: { ...match, type: 'income' } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  const expense = await Transaction.aggregate([
    { $match: { ...match, type: 'expense' } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  return {
    income: income[0]?.total ?? 0,
    expense: expense[0]?.total ?? 0,
    profit: (income[0]?.total ?? 0) - (expense[0]?.total ?? 0),
  };
};

const getWeekly = asyncHandler(async (req, res) => {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 7);
  const data = await runAggregation(start, end);
  res.json({ success: true, data });
});

const getMonthly = asyncHandler(async (req, res) => {
  const end = new Date();
  const start = new Date(end.getFullYear(), end.getMonth(), 1);
  const data = await runAggregation(start, end);
  res.json({ success: true, data });
});

const getQuarterly = asyncHandler(async (req, res) => {
  const end = new Date();
  const quarter = Math.floor(end.getMonth() / 3) + 1;
  const start = new Date(end.getFullYear(), (quarter - 1) * 3, 1);
  const data = await runAggregation(start, end);
  res.json({ success: true, data });
});

const getAnnual = asyncHandler(async (req, res) => {
  const end = new Date();
  const start = new Date(end.getFullYear(), 0, 1);
  const data = await runAggregation(start, end);
  res.json({ success: true, data });
});

const exportReport = asyncHandler(async (req, res) => {
  const { type } = req.params;
  const end = new Date();
  let start;
  if (type === 'weekly') {
    start = new Date(end);
    start.setDate(start.getDate() - 7);
  } else if (type === 'monthly') {
    start = new Date(end.getFullYear(), end.getMonth(), 1);
  } else if (type === 'quarterly') {
    const q = Math.floor(end.getMonth() / 3) + 1;
    start = new Date(end.getFullYear(), (q - 1) * 3, 1);
  } else {
    start = new Date(end.getFullYear(), 0, 1);
  }
  const data = await runAggregation(start, end);
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'export',
    entity: 'Report',
    req,
  });
  res.setHeader('Content-Type', 'application/json');
  res.json({ success: true, data });
});

module.exports = { getWeekly, getMonthly, getQuarterly, getAnnual, exportReport };
