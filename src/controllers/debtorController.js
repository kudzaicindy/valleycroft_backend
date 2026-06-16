const Debtor = require('../models/Debtor');
const { asyncHandler, getPagination } = require('../utils/helpers');
const logAudit = require('../utils/audit');
const { recordDebtorPayment } = require('../services/debtorPaymentService');
const { withRoomPreview } = require('../utils/bookingPreview');
const DEBTOR_UPDATE_FIELDS = [
  'name',
  'contactEmail',
  'contactPhone',
  'description',
  'amountOwed',
  'amountPaid',
  'dueDate',
  'status',
  'notes',
];

function pickDebtorUpdates(body = {}) {
  const out = {};
  for (const key of DEBTOR_UPDATE_FIELDS) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
}

const guestBookingPopulate = {
  path: 'guestBookingRef',
  select:
    'guestName guestEmail guestPhone checkIn checkOut status totalAmount deposit trackingCode source roomId notes',
  populate: { path: 'roomId', select: 'name type slug capacity pricePerNight roomType spaceCategory' },
};

const bookingPopulate = {
  path: 'bookingRef',
  select: 'guestName guestEmail guestPhone type checkIn checkOut eventDate status amount deposit platform roomId',
  populate: { path: 'roomId', select: 'name type slug capacity pricePerNight roomType spaceCategory' },
};

function mapDebtorRowsWithRoom(rows) {
  return rows.map((r) => ({
    ...r,
    platform: r.bookingRef?.platform || r.guestBookingRef?.source || 'direct',
    bookingRef: r.bookingRef ? { ...withRoomPreview(r.bookingRef), platform: r.bookingRef.platform || 'direct' } : r.bookingRef,
    guestBookingRef: r.guestBookingRef
      ? { ...withRoomPreview(r.guestBookingRef), platform: r.guestBookingRef.source || 'website' }
      : r.guestBookingRef,
  }));
}

const list = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const { skip, limit: lim } = getPagination(page, limit);
  const [raw, total] = await Promise.all([
    Debtor.find()
      .populate(bookingPopulate)
      .populate(guestBookingPopulate)
      .populate('invoiceRef', 'invoiceNumber status dueDate total')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(lim)
      .lean({ virtuals: true }),
    Debtor.countDocuments(),
  ]);
  const data = mapDebtorRowsWithRoom(raw);
  res.json({ success: true, data, meta: { page: parseInt(page, 10), limit: lim, total } });
});

const pendingBookings = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const { skip, limit: lim } = getPagination(page, limit);
  const query = {
    status: { $in: ['outstanding', 'partial'] },
    $or: [{ bookingRef: { $ne: null } }, { guestBookingRef: { $ne: null } }],
    // Keep count + page rows consistent: only include debtors that truly still owe.
    $expr: { $gt: [{ $ifNull: ['$amountOwed', 0] }, { $ifNull: ['$amountPaid', 0] }] },
  };

  const [rows, total] = await Promise.all([
    Debtor.find(query)
      .populate(bookingPopulate)
      .populate(guestBookingPopulate)
      .populate('invoiceRef', 'invoiceNumber status dueDate total')
      .sort({ dueDate: 1, createdAt: -1 })
      .skip(skip)
      .limit(lim)
      .lean({ virtuals: true }),
    Debtor.countDocuments(query),
  ]);
  res.json({
    success: true,
    data: mapDebtorRowsWithRoom(rows),
    meta: { page: parseInt(page, 10), limit: lim, total },
  });
});

const recordPayment = asyncHandler(async (req, res) => {
  const debtor = await Debtor.findById(req.params.id);
  if (!debtor) return res.status(404).json({ success: false, message: 'Debtor not found' });

  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ success: false, message: 'amount must be a positive number' });
  }

  const before = debtor.toObject();
  const paidAt = req.body.paidAt ? new Date(req.body.paidAt) : new Date();
  const method = String(req.body.method || 'cash').trim().toLowerCase();
  const reference = req.body.reference ? String(req.body.reference).trim() : '';
  const note = req.body.note ? String(req.body.note).trim() : '';

  let result;
  try {
    result = await recordDebtorPayment(debtor._id, {
      amount,
      paidAt,
      method,
      reference,
      note,
      createdBy: req.user._id,
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      message: err.message || 'Could not record payment',
    });
  }

  const { debtor: updated, payment, transaction: tx, financialJournalEntryId, meta } = result;

  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'update',
    entity: 'Debtor',
    entityId: debtor._id,
    before,
    after: updated.toObject(),
    req,
  });

  res.json({
    success: true,
    data: updated,
    related: {
      payment: {
        _id: payment._id,
        amount: payment.amount,
        paidAt: payment.paidAt,
        method: payment.method,
        reference: payment.reference,
      },
      transaction: {
        _id: tx._id,
        type: tx.type,
        category: tx.category,
        amount: tx.amount,
        date: tx.date,
        reference: tx.reference,
        source: tx.source,
        financialJournalEntryId: tx.financialJournalEntryId,
        lines: tx.lines,
      },
    },
    meta: {
      ...meta,
      paymentId: payment._id,
      transactionId: tx._id,
      financialJournalEntryId,
    },
  });
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
  if (req.body.amountPaid !== undefined) {
    return res.status(400).json({
      success: false,
      message: 'Use POST /api/finance/debtors/:id/payments to record payment and create transaction entries',
    });
  }
  const before = debtor.toObject();
  Object.assign(debtor, pickDebtorUpdates(req.body));
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

module.exports = { list, pendingBookings, recordPayment, create, update, remove };
