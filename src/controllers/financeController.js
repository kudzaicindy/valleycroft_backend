const crypto = require('crypto');
const Transaction = require('../models/Transaction');
const Salary = require('../models/Salary');
const { asyncHandler, getPagination } = require('../utils/helpers');
const logAudit = require('../utils/audit');
const transactionJournalService = require('../services/transactionJournalService');
const { withRoomPreview } = require('../utils/bookingPreview');

/** In-memory idempotency for POST /transactions (duplicate submits / Strict Mode) */
const IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000;
const idempotencyCache = new Map();
const IDEMPOTENCY_MAX = 500;

function idempotencyFingerprint(userId, clientKey, payload) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ userId: String(userId), clientKey: String(clientKey), payload }))
    .digest('hex');
}

function idempotencyRemember(fingerprint, txId) {
  idempotencyCache.set(fingerprint, { txId, at: Date.now() });
  if (idempotencyCache.size > IDEMPOTENCY_MAX) {
    const cutoff = Date.now() - IDEMPOTENCY_WINDOW_MS;
    for (const [k, v] of idempotencyCache) {
      if (v.at < cutoff) idempotencyCache.delete(k);
    }
  }
}

function addDrCr(tx) {
  const amount = Math.abs(Number(tx?.amount) || 0);
  const isExpense = tx?.type === 'expense';
  return {
    ...tx,
    debit: isExpense ? amount : 0,
    credit: isExpense ? 0 : amount,
    ledgerStatus: tx.journalEntryId ? 'posted' : 'unposted',
  };
}

/** Same-day / same-amount duplicate rows (e.g. double POST) — keep row with journal posted, else newest */
function collapseTransactionDuplicateRows(rows) {
  const byKey = new Map();
  for (const tx of rows) {
    const d = tx.date ? new Date(tx.date).toISOString().slice(0, 10) : '';
    const key = [
      d,
      tx.type,
      String(tx.category || '').toLowerCase(),
      String(tx.description || '').trim().toLowerCase(),
      Number(tx.amount),
      String(tx.createdBy || ''),
    ].join('\t');
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, tx);
      continue;
    }
    const prevJ = !!prev.journalEntryId;
    const curJ = !!tx.journalEntryId;
    if (curJ && !prevJ) byKey.set(key, tx);
    else if (curJ === prevJ) {
      const pt = new Date(prev.updatedAt || prev.createdAt || 0).getTime();
      const ct = new Date(tx.updatedAt || tx.createdAt || 0).getTime();
      if (ct >= pt) byKey.set(key, tx);
    }
  }
  return Array.from(byKey.values());
}

function addRunningBalances(rows) {
  let debitBalance = 0;
  let creditBalance = 0;
  return rows.map((tx) => {
    debitBalance += Number(tx.debit) || 0;
    creditBalance += Number(tx.credit) || 0;
    return {
      ...tx,
      debitBalance: Number(debitBalance.toFixed(2)),
      creditBalance: Number(creditBalance.toFixed(2)),
      netBalance: Number((creditBalance - debitBalance).toFixed(2)),
    };
  });
}

async function leanTransactionWithBookingPreview(txId) {
  const doc = await Transaction.findById(txId)
    .populate({
      path: 'booking',
      populate: { path: 'roomId', select: 'name type' },
    })
    .populate({
      path: 'guestBooking',
      populate: { path: 'roomId', select: 'name type' },
    })
    .lean();
  if (doc?.booking) doc.booking = withRoomPreview(doc.booking);
  if (doc?.guestBooking) doc.guestBooking = withRoomPreview(doc.guestBooking);
  return doc ? addDrCr(doc) : doc;
}

const getTransactions = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const { skip, limit: lim } = getPagination(page, limit);
  const collapseDupes = !(
    String(req.query.collapseDuplicates || '').toLowerCase() === '0' ||
    String(req.query.collapseDuplicates || '').toLowerCase() === 'false'
  );
  const [raw, total] = await Promise.all([
    Transaction.find()
      .sort({ date: -1 })
      .skip(skip)
      .limit(lim)
      .populate({
        path: 'booking',
        populate: { path: 'roomId', select: 'name type' },
      })
      .populate({
        path: 'guestBooking',
        populate: { path: 'roomId', select: 'name type' },
      })
      .lean(),
    Transaction.countDocuments(),
  ]);
  let data = raw.map((tx) => {
    if (tx.booking) tx.booking = withRoomPreview(tx.booking);
    if (tx.guestBooking) tx.guestBooking = withRoomPreview(tx.guestBooking);
    return addDrCr(tx);
  });
  let duplicateRowsCollapsed = 0;
  if (collapseDupes && data.length > 1) {
    const before = data.length;
    data = collapseTransactionDuplicateRows(data);
    duplicateRowsCollapsed = before - data.length;
    data.sort((a, b) => new Date(b.date) - new Date(a.date));
  }
  const withBalances = addRunningBalances(data);
  const totals = withBalances.reduce(
    (acc, tx) => {
      acc.debit += tx.debit || 0;
      acc.credit += tx.credit || 0;
      return acc;
    },
    { debit: 0, credit: 0 }
  );
  totals.net = Number((totals.credit - totals.debit).toFixed(2));
  totals.debit = Number(totals.debit.toFixed(2));
  totals.credit = Number(totals.credit.toFixed(2));
  res.json({
    success: true,
    data: withBalances,
    meta: {
      page: parseInt(page, 10),
      limit: lim,
      total,
      totals,
      duplicateRowsCollapsed,
      collapseDuplicates: collapseDupes,
    },
  });
});

const createTransaction = asyncHandler(async (req, res) => {
  const {
    journalEntryId: _ignoreJournal,
    guestBooking: _ignoreGuestBooking,
    source: _ignoreSource,
    revenueRecognition: _ignoreRevRec,
    receivableAccountCode: _ignoreRecvCode,
    idempotencyKey: idemFromBody,
    ...bodySafe
  } = req.body;

  const clientIdem =
    req.headers['idempotency-key'] ||
    req.headers['x-idempotency-key'] ||
    idemFromBody;

  if (clientIdem != null && String(clientIdem).trim()) {
    const fp = idempotencyFingerprint(req.user._id, String(clientIdem).trim(), bodySafe);
    const hit = idempotencyCache.get(fp);
    if (hit && Date.now() - hit.at < IDEMPOTENCY_WINDOW_MS) {
      const data = await leanTransactionWithBookingPreview(hit.txId);
      return res.status(201).json({ success: true, data, idempotentReplay: true });
    }
  }

  const tx = await Transaction.create({
    ...bodySafe,
    createdBy: req.user._id,
    source: 'manual',
    revenueRecognition: 'cash',
  });
  try {
    const entryId = await transactionJournalService.postJournalForTransaction(tx, req.user._id);
    tx.journalEntryId = entryId;
    await tx.save();
  } catch (err) {
    await Transaction.findByIdAndDelete(tx._id);
    return res.status(400).json({
      success: false,
      message: err.message || 'Could not post ledger entry',
      hint: 'Ensure chart of accounts is seeded: npm run seed:accounting',
    });
  }
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'create',
    entity: 'Transaction',
    entityId: tx._id,
    after: tx.toObject(),
    req,
  });
  const data = await leanTransactionWithBookingPreview(tx._id);

  if (clientIdem != null && String(clientIdem).trim()) {
    idempotencyRemember(idempotencyFingerprint(req.user._id, String(clientIdem).trim(), bodySafe), tx._id);
  }

  res.status(201).json({ success: true, data });
});

const updateTransaction = asyncHandler(async (req, res) => {
  const tx = await Transaction.findById(req.params.id);
  if (!tx) return res.status(404).json({ success: false, message: 'Transaction not found' });
  const before = tx.toObject();
  let voidedOld = false;
  try {
    if (tx.journalEntryId) {
      await transactionJournalService.voidJournalLinkedToTransaction(
        tx,
        req.user._id,
        'Transaction updated — reversing prior entry'
      );
      voidedOld = true;
      tx.journalEntryId = undefined;
    }
    const {
      journalEntryId: _ignore,
      guestBooking: _ig1,
      source: _ig2,
      revenueRecognition: _ig3,
      receivableAccountCode: _igRecv,
      ...bodySafe
    } = req.body;
    Object.assign(tx, bodySafe);
    tx.journalEntryId = undefined;
    await tx.save();
    const entryId = await transactionJournalService.postJournalForTransaction(tx, req.user._id);
    tx.journalEntryId = entryId;
    await tx.save();
  } catch (err) {
    if (voidedOld) {
      try {
        const recovery = {
          _id: tx._id,
          type: before.type,
          category: before.category,
          description: before.description,
          amount: before.amount,
          date: before.date,
          revenueRecognition: before.revenueRecognition,
          receivableAccountCode: before.receivableAccountCode,
        };
        const recoveryEntryId = await transactionJournalService.postJournalForTransaction(
          recovery,
          req.user._id
        );
        await Transaction.findByIdAndUpdate(tx._id, {
          type: before.type,
          category: before.category,
          description: before.description,
          amount: before.amount,
          date: before.date,
          reference: before.reference,
          booking: before.booking,
          guestBooking: before.guestBooking,
          source: before.source,
          revenueRecognition: before.revenueRecognition,
          receivableAccountCode: before.receivableAccountCode,
          journalEntryId: recoveryEntryId,
        });
      } catch (rollbackErr) {
        console.error('Transaction ledger rollback failed:', rollbackErr.message);
      }
    }
    return res.status(400).json({
      success: false,
      message: err.message || 'Could not update ledger',
      hint: 'Ensure chart of accounts is seeded: npm run seed:accounting',
    });
  }
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'update',
    entity: 'Transaction',
    entityId: tx._id,
    before,
    after: tx.toObject(),
    req,
  });
  const data = await leanTransactionWithBookingPreview(tx._id);
  res.json({ success: true, data });
});

const deleteTransaction = asyncHandler(async (req, res) => {
  const tx = await Transaction.findById(req.params.id);
  if (!tx) return res.status(404).json({ success: false, message: 'Transaction not found' });
  const before = tx.toObject();
  try {
    if (tx.journalEntryId) {
      await transactionJournalService.voidJournalLinkedToTransaction(
        tx,
        req.user._id,
        'Transaction deleted'
      );
    }
  } catch (err) {
    return res.status(400).json({
      success: false,
      message: err.message || 'Could not void linked journal entry',
    });
  }
  await tx.deleteOne();
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'delete',
    entity: 'Transaction',
    entityId: req.params.id,
    before,
    req,
  });
  res.json({ success: true, message: 'Transaction deleted' });
});

const getCashflow = asyncHandler(async (req, res) => {
  const { start, end } = req.query;
  const startDate = start ? new Date(start) : new Date(0);
  const endDate = end ? new Date(end) : new Date();
  const data = await Transaction.aggregate([
    { $match: { date: { $gte: startDate, $lte: endDate } } },
    { $group: { _id: '$type', total: { $sum: '$amount' } } },
  ]);
  res.json({ success: true, data });
});

const getIncomeStatement = asyncHandler(async (req, res) => {
  const { start, end } = req.query;
  const startDate = start ? new Date(start) : new Date(new Date().getFullYear(), 0, 1);
  const endDate = end ? new Date(end) : new Date();
  const income = await Transaction.aggregate([
    { $match: { type: 'income', date: { $gte: startDate, $lte: endDate } } },
    { $group: { _id: '$category', total: { $sum: '$amount' } } },
  ]);
  const expense = await Transaction.aggregate([
    { $match: { type: 'expense', date: { $gte: startDate, $lte: endDate } } },
    { $group: { _id: '$category', total: { $sum: '$amount' } } },
  ]);
  res.json({ success: true, data: { income, expense } });
});

const getBalanceSheet = asyncHandler(async (req, res) => {
  const totals = await Transaction.aggregate([
    { $group: { _id: '$type', total: { $sum: '$amount' } } },
  ]);
  res.json({ success: true, data: totals });
});

const getPL = asyncHandler(async (req, res) => {
  const { start, end } = req.query;
  const startDate = start ? new Date(start) : new Date(new Date().getFullYear(), 0, 1);
  const endDate = end ? new Date(end) : new Date();
  const [income] = await Transaction.aggregate([
    { $match: { type: 'income', date: { $gte: startDate, $lte: endDate } } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  const [expense] = await Transaction.aggregate([
    { $match: { type: 'expense', date: { $gte: startDate, $lte: endDate } } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  res.json({
    success: true,
    data: {
      income: income?.total ?? 0,
      expense: expense?.total ?? 0,
      profit: (income?.total ?? 0) - (expense?.total ?? 0),
    },
  });
});

const getSalary = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const { skip, limit: lim } = getPagination(page, limit);
  const [data, total] = await Promise.all([
    Salary.find().populate('employee', 'name email').sort({ paidOn: -1 }).skip(skip).limit(lim).lean(),
    Salary.countDocuments(),
  ]);
  res.json({ success: true, data, meta: { page: parseInt(page, 10), limit: lim, total } });
});

const createSalary = asyncHandler(async (req, res) => {
  const salary = await Salary.create(req.body);
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'create',
    entity: 'Salary',
    entityId: salary._id,
    after: salary.toObject(),
    req,
  });
  res.status(201).json({ success: true, data: salary });
});

const getSalaryByEmployee = asyncHandler(async (req, res) => {
  const data = await Salary.find({ employee: req.params.id }).sort({ paidOn: -1 }).lean();
  res.json({ success: true, data });
});

module.exports = {
  getTransactions,
  createTransaction,
  updateTransaction,
  deleteTransaction,
  getCashflow,
  getIncomeStatement,
  getBalanceSheet,
  getPL,
  getSalary,
  createSalary,
  getSalaryByEmployee,
};
