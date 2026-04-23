const Debtor = require('../models/Debtor');
const DebtorPayment = require('../models/DebtorPayment');
const Transaction = require('../models/Transaction');
const Account = require('../models/Account');
const { asyncHandler, getPagination } = require('../utils/helpers');
const logAudit = require('../utils/audit');
const financialGlPostingService = require('../services/financialGlPostingService');
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
    'guestName guestEmail guestPhone checkIn checkOut status totalAmount deposit trackingCode roomId notes',
  populate: { path: 'roomId', select: 'name type slug capacity pricePerNight roomType spaceCategory' },
};

const bookingPopulate = {
  path: 'bookingRef',
  select: 'guestName guestEmail guestPhone type checkIn checkOut eventDate status amount deposit roomId',
  populate: { path: 'roomId', select: 'name type slug capacity pricePerNight roomType spaceCategory' },
};

function mapDebtorRowsWithRoom(rows) {
  return rows.map((r) => ({
    ...r,
    bookingRef: r.bookingRef ? withRoomPreview(r.bookingRef) : r.bookingRef,
    guestBookingRef: r.guestBookingRef ? withRoomPreview(r.guestBookingRef) : r.guestBookingRef,
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

function debtorStatusFor(owed, paid) {
  if (paid <= 0) return 'outstanding';
  if (paid >= owed) return 'paid';
  return 'partial';
}

const recordPayment = asyncHandler(async (req, res) => {
  const debtor = await Debtor.findById(req.params.id);
  if (!debtor) return res.status(404).json({ success: false, message: 'Debtor not found' });

  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ success: false, message: 'amount must be a positive number' });
  }

  const owed = Number(debtor.amountOwed) || 0;
  const paid = Number(debtor.amountPaid) || 0;
  const remaining = Math.max(0, owed - paid);
  if (amount > remaining) {
    return res.status(400).json({
      success: false,
      message: `Payment exceeds remaining balance (${remaining})`,
      meta: { remaining },
    });
  }

  const before = debtor.toObject();
  const paidAt = req.body.paidAt ? new Date(req.body.paidAt) : new Date();
  const method = String(req.body.method || 'cash').trim().toLowerCase();
  const reference = req.body.reference ? String(req.body.reference).trim() : '';
  const note = req.body.note ? String(req.body.note).trim() : '';
  const amountPaidAfter = paid + amount;
  const remainingAfter = Math.max(0, owed - amountPaidAfter);

  let payment;
  let tx;
  let je;
  try {
    payment = await DebtorPayment.create({
      debtorId: debtor._id,
      bookingRef: debtor.bookingRef,
      guestBookingRef: debtor.guestBookingRef,
      amount,
      paidAt,
      method,
      reference,
      note,
      amountOwedBefore: owed,
      amountPaidBefore: paid,
      amountPaidAfter,
      remainingAfter,
      createdBy: req.user._id,
    });

    tx = await Transaction.create({
      type: 'income',
      category: 'booking_payment',
      amount,
      date: paidAt,
      description: `Payment received — ${debtor.name || 'Debtor'} (${method})`,
      reference: reference || `PAY:${payment._id}`,
      booking: debtor.bookingRef || undefined,
      guestBooking: debtor.guestBookingRef || undefined,
      source: 'debtor_payment',
      revenueRecognition: 'cash',
      createdBy: req.user._id,
    });

    const [bankAcc, arAcc] = await Promise.all([
      Account.findOne({ code: '1001' }).select('_id code name').lean(),
      Account.findOne({ code: '1010' }).select('_id code name').lean(),
    ]);
    if (!bankAcc || !arAcc) {
      throw new Error('Missing chart accounts for booking payment posting (1001 and/or 1010)');
    }

    je = await financialGlPostingService.postBookingPaymentAgainstArV3(
      debtor,
      amount,
      req.user._id,
      { journalDate: paidAt, reference: tx.reference }
    );

    tx.financialJournalEntryId = je._id;
    tx.lines = [
      {
        accountId: bankAcc._id,
        accountCode: bankAcc.code,
        accountName: bankAcc.name,
        debit: amount,
        credit: 0,
        description: 'Bank — booking payment received',
      },
      {
        accountId: arAcc._id,
        accountCode: arAcc.code,
        accountName: arAcc.name,
        debit: 0,
        credit: amount,
        description: 'Accounts receivable cleared',
      },
    ];
    await tx.save();

    payment.transactionId = tx._id;
    payment.financialJournalEntryId = je._id;
    await payment.save();

    debtor.amountPaid = amountPaidAfter;
    debtor.status = debtorStatusFor(owed, debtor.amountPaid);
    if (note) {
      const line = `[payment ${paidAt.toISOString()}] ${note}`;
      debtor.notes = debtor.notes ? `${debtor.notes}\n${line}` : line;
    }
    await debtor.save();
  } catch (err) {
    if (tx?._id) await Transaction.findByIdAndDelete(tx._id);
    if (payment?._id) await DebtorPayment.findByIdAndDelete(payment._id);
    debtor.amountPaid = paid;
    debtor.status = before.status;
    debtor.notes = before.notes;
    await debtor.save();
    throw err;
  }

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

  res.json({
    success: true,
    data: debtor,
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
      paidNow: amount,
      remaining: Math.max(0, (Number(debtor.amountOwed) || 0) - (Number(debtor.amountPaid) || 0)),
      paymentId: payment._id,
      transactionId: tx._id,
      financialJournalEntryId: je._id,
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
