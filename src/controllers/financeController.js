const crypto = require('crypto');
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const GuestBooking = require('../models/GuestBooking');
const Salary = require('../models/Salary');
const User = require('../models/User');
const { asyncHandler, getPagination } = require('../utils/helpers');
const logAudit = require('../utils/audit');
const transactionJournalService = require('../services/transactionJournalService');
const { CHART_OF_ACCOUNTS_V3 } = require('../constants/chartOfAccountsV3');
const { attachLedgerEntriesToTransactions } = require('../services/transactionLedgerLinesService');
const { withRoomPreview } = require('../utils/bookingPreview');

const FINANCE_TX_MAX_LIMIT = 500;
/** When filtering by GL account, scan recent rows in-range then filter in memory (cap for safety). */
const FINANCE_TX_ACCOUNT_FILTER_SCAN_CAP = 3000;

function parseUtcStart(iso) {
  const s = String(iso || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T00:00:00.000Z`);
  const d = new Date(s);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function parseUtcEnd(iso) {
  const s = String(iso || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T23:59:59.999Z`);
  const d = new Date(s);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

function accountDisplayName(accountCode) {
  const n = Number(String(accountCode).trim());
  if (!Number.isFinite(n)) return String(accountCode);
  return CHART_OF_ACCOUNTS_V3[n]?.name || String(accountCode);
}

/**
 * Normalized GL-style lines for grouping: embedded `lines`, legacy `ledgerEntry.lines`, or inferred from `buildLines`.
 * @param {Record<string, unknown>} tx
 * @returns {Array<{ accountCode: string, accountName: string, debit: number, credit: number, description: string }>}
 */
function getLedgerStyleLinesForTransaction(tx) {
  if (Array.isArray(tx.lines) && tx.lines.length) {
    return tx.lines.map((l) => ({
      accountCode: String(l.accountCode || '').trim() || '—',
      accountName: String(l.accountName || '').trim() || accountDisplayName(l.accountCode),
      debit: Number(l.debit) || 0,
      credit: Number(l.credit) || 0,
      description: String(l.description || ''),
    }));
  }
  if (tx.ledgerEntry && Array.isArray(tx.ledgerEntry.lines) && tx.ledgerEntry.lines.length) {
    return tx.ledgerEntry.lines.map((l) => ({
      accountCode: String(l.accountCode || '').trim() || '—',
      accountName: String(l.accountName || '').trim() || accountDisplayName(l.accountCode),
      debit: Number(l.debit) || 0,
      credit: Number(l.credit) || 0,
      description: String(l.description || ''),
    }));
  }
  try {
    const specs = transactionJournalService.buildLines(tx);
    return specs.map((s) => ({
      accountCode: String(s.accountCode).trim(),
      accountName: accountDisplayName(s.accountCode),
      debit: Number(s.debit) || 0,
      credit: Number(s.credit) || 0,
      description: String(s.description || ''),
    }));
  } catch {
    return [];
  }
}

/**
 * Per-account rollups + line-level drill-down for the finance transactions UI.
 * @param {Array<Record<string, unknown>>} rows
 */
function buildByAccountDrillDown(rows, drillParamsNoAccount) {
  /** @type {Map<string, { accountCode: string, accountName: string, debitTotal: number, creditTotal: number, drillDown: { lines: object[] } }>} */
  const byCode = new Map();
  const baseQs = drillParamsNoAccount || '';

  for (const tx of rows) {
    const lines = getLedgerStyleLinesForTransaction(tx);
    const txId = String(tx._id);
    const txDate = tx.date;
    const txDesc = tx.description || '';
    const txType = tx.type;
    const txCategory = tx.category || '';

    for (const L of lines) {
      const code = L.accountCode || '—';
      if (!byCode.has(code)) {
        byCode.set(code, {
          accountCode: code,
          accountName: L.accountName || accountDisplayName(code),
          debitTotal: 0,
          creditTotal: 0,
          drillDown: { lines: [] },
        });
      }
      const bucket = byCode.get(code);
      bucket.debitTotal += L.debit;
      bucket.creditTotal += L.credit;
      bucket.drillDown.lines.push({
        transactionId: txId,
        date: txDate,
        description: txDesc,
        type: txType,
        category: txCategory,
        debit: Number(Number(L.debit || 0).toFixed(2)),
        credit: Number(Number(L.credit || 0).toFixed(2)),
        lineDescription: L.description || '',
      });
    }
  }

  const accounts = [...byCode.values()]
    .map((a) => ({
      ...a,
      debitTotal: Number(a.debitTotal.toFixed(2)),
      creditTotal: Number(a.creditTotal.toFixed(2)),
      net: Number((a.debitTotal - a.creditTotal).toFixed(2)),
      lineCount: a.drillDown.lines.length,
      drillDownUrl: `/api/finance/transactions?${baseQs}${baseQs ? '&' : ''}accountCode=${encodeURIComponent(a.accountCode)}`,
    }))
    .sort((x, y) => String(x.accountCode).localeCompare(String(y.accountCode)));

  return accounts;
}

/** In-memory idempotency for POST /transactions (duplicate submits / Strict Mode) */
const IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000;
const idempotencyCache = new Map();
const IDEMPOTENCY_MAX = 500;

/** Same-payload duplicate POSTs within this window collapse to one row (double-click, Strict Mode, etc.) */
const DUPLICATE_BODY_WINDOW_MS = 20 * 1000;
/** Manual income category "booking" vs recent confirm with same amount — avoid second GL (ms) */
const MANUAL_BOOKING_INCOME_DEDUPE_AGAINST_CONFIRM_MS = 10 * 60 * 1000;
/** One in-flight create per normalized body fingerprint (parallel duplicate requests share one Promise) */
const inFlightTransactionByFingerprint = new Map();

function normalizeManualTransactionBody(body) {
  const d = body.date ? new Date(body.date) : new Date();
  return {
    type: body.type,
    category: String(body.category || '').trim(),
    description: String(body.description || '').trim(),
    amount: Number(body.amount),
    dateKey: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`,
  };
}

function withTransactionDedupeLock(fingerprint, fn) {
  if (inFlightTransactionByFingerprint.has(fingerprint)) {
    return inFlightTransactionByFingerprint.get(fingerprint);
  }
  const p = fn().finally(() => {
    inFlightTransactionByFingerprint.delete(fingerprint);
  });
  inFlightTransactionByFingerprint.set(fingerprint, p);
  return p;
}

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
  const withDrCr = doc ? addDrCr(doc) : doc;
  if (!withDrCr) return withDrCr;
  const [withLedger] = await attachLedgerEntriesToTransactions([withDrCr]);
  return withLedger;
}

const getTransactions = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const lim = Math.min(FINANCE_TX_MAX_LIMIT, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const skip = (page - 1) * lim;

  const startRaw = req.query.start || req.query.startDate;
  const endRaw = req.query.end || req.query.endDate;
  /** @type {Record<string, unknown>} */
  const mongoMatch = {};
  if (startRaw || endRaw) {
    mongoMatch.date = {};
    if (startRaw) mongoMatch.date.$gte = parseUtcStart(startRaw);
    if (endRaw) mongoMatch.date.$lte = parseUtcEnd(endRaw);
  }
  if (req.query.type === 'income' || req.query.type === 'expense') {
    mongoMatch.type = req.query.type;
  }

  const accountCodeFilter = req.query.accountCode
    ? String(req.query.accountCode).trim()
    : '';

  const includeLedger =
    String(req.query.includeLedger ?? '1').toLowerCase() !== '0' &&
    String(req.query.includeLedger ?? '').toLowerCase() !== 'false';
  const includeByAccount =
    String(req.query.includeByAccount ?? '1').toLowerCase() !== '0' &&
    String(req.query.includeByAccount ?? '').toLowerCase() !== 'false';
  const collapseDupes = !(
    String(req.query.collapseDuplicates || '').toLowerCase() === '0' ||
    String(req.query.collapseDuplicates || '').toLowerCase() === 'false'
  );

  let raw;
  let total;
  let accountFilterMeta = null;

  if (accountCodeFilter) {
    raw = await Transaction.find(mongoMatch)
      .sort({ date: -1 })
      .limit(FINANCE_TX_ACCOUNT_FILTER_SCAN_CAP)
      .populate({
        path: 'booking',
        populate: { path: 'roomId', select: 'name type' },
      })
      .populate({
        path: 'guestBooking',
        populate: { path: 'roomId', select: 'name type' },
      })
      .lean();
    total = await Transaction.countDocuments(mongoMatch);
    accountFilterMeta = {
      mode: 'accountCode',
      scanCap: FINANCE_TX_ACCOUNT_FILTER_SCAN_CAP,
      scanned: raw.length,
      note:
        'Rows are scanned newest-first up to scanCap, filtered by resolved GL lines (embedded, legacy journal, or inferred), then paginated.',
    };
  } else {
    [raw, total] = await Promise.all([
      Transaction.find(mongoMatch)
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
      Transaction.countDocuments(mongoMatch),
    ]);
  }

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

  let withLedger = includeLedger
    ? await attachLedgerEntriesToTransactions(data)
    : data.map((tx) => ({ ...tx, ledgerEntry: null }));

  if (accountCodeFilter) {
    withLedger = withLedger.filter((tx) =>
      getLedgerStyleLinesForTransaction(tx).some((l) => String(l.accountCode) === accountCodeFilter),
    );
    const filteredTotal = withLedger.length;
    withLedger = withLedger.slice(skip, skip + lim);
    accountFilterMeta = {
      ...accountFilterMeta,
      matchingRows: filteredTotal,
      totalRowsInPeriod: total,
    };
    total = filteredTotal;
  }

  const withBalances = addRunningBalances(withLedger);
  const totals = withBalances.reduce(
    (acc, tx) => {
      acc.debit += tx.debit || 0;
      acc.credit += tx.credit || 0;
      return acc;
    },
    { debit: 0, credit: 0 },
  );
  totals.net = Number((totals.credit - totals.debit).toFixed(2));
  totals.debit = Number(totals.debit.toFixed(2));
  totals.credit = Number(totals.credit.toFixed(2));

  const drillParams = new URLSearchParams();
  if (startRaw) drillParams.set('start', String(startRaw).trim());
  if (endRaw) drillParams.set('end', String(endRaw).trim());
  if (req.query.type === 'income' || req.query.type === 'expense') drillParams.set('type', String(req.query.type));
  drillParams.set('limit', String(Math.min(FINANCE_TX_MAX_LIMIT, 500)));

  const byAccount = includeByAccount ? buildByAccountDrillDown(withBalances, drillParams.toString()) : [];

  res.json({
    success: true,
    data: withBalances,
    meta: {
      apiPath: '/api/finance/transactions',
      page,
      limit: lim,
      total,
      totals,
      duplicateRowsCollapsed,
      collapseDuplicates: collapseDupes,
      includeLedger,
      includeByAccount,
      dateRange:
        startRaw || endRaw
          ? {
              start: startRaw ? parseUtcStart(startRaw).toISOString() : null,
              end: endRaw ? parseUtcEnd(endRaw).toISOString() : null,
            }
          : null,
      accountCodeFilter: accountCodeFilter || null,
      accountFilter: accountFilterMeta,
      byAccount,
    },
  });
});

const createTransaction = asyncHandler(async (req, res) => {
  const rawGb = req.body.guestBooking;
  const rawBooking = req.body.booking;
  const guestBookingDedupeId =
    rawGb != null && /^[0-9a-fA-F]{24}$/.test(String(rawGb).trim()) ? String(rawGb).trim() : null;
  const bookingDedupeId =
    rawBooking != null && /^[0-9a-fA-F]{24}$/.test(String(rawBooking).trim()) ? String(rawBooking).trim() : null;

  const {
    journalEntryId: _ignoreJournal,
    lines: _ignoreLines,
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

  if (guestBookingDedupeId) {
    const gb = await GuestBooking.findById(guestBookingDedupeId).select('revenueTransactionId status').lean();
    if (gb?.status === 'confirmed' && gb.revenueTransactionId) {
      const data = await leanTransactionWithBookingPreview(gb.revenueTransactionId);
      return res.status(200).json({
        success: true,
        data,
        duplicateSuppressed: true,
        message:
          'Revenue for this booking is already in the ledger (posted when the booking was confirmed). No duplicate entry was created.',
      });
    }
  }

  const bodyFp = idempotencyFingerprint(
    req.user._id,
    '__manual_tx_body__',
    normalizeManualTransactionBody(bodySafe)
  );

  const outcome = await withTransactionDedupeLock(bodyFp, async () => {
    const norm = normalizeManualTransactionBody(bodySafe);
    const windowStart = new Date(Date.now() - DUPLICATE_BODY_WINDOW_MS);
    const d = bodySafe.date ? new Date(bodySafe.date) : new Date();
    const dayStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    const existing = await Transaction.findOne({
      createdBy: req.user._id,
      source: 'manual',
      revenueRecognition: 'cash',
      type: norm.type,
      category: norm.category,
      description: norm.description,
      amount: norm.amount,
      date: { $gte: dayStart, $lt: dayEnd },
      createdAt: { $gte: windowStart },
    })
      .sort({ createdAt: -1 })
      .exec();

    if (existing) {
      return { kind: 'ok', tx: existing, created: false };
    }

    // If payment already posted through /debtors/:id/payments, suppress follow-up manual row.
    if (
      norm.type === 'income' &&
      ['booking', 'booking_payment'].includes(String(norm.category || '').toLowerCase()) &&
      Number(norm.amount) > 0 &&
      (guestBookingDedupeId || bookingDedupeId)
    ) {
      const paymentQuery = {
        source: 'debtor_payment',
        type: 'income',
        amount: norm.amount,
      };
      if (guestBookingDedupeId) paymentQuery.guestBooking = guestBookingDedupeId;
      if (bookingDedupeId) paymentQuery.booking = bookingDedupeId;
      const existingPaymentTx = await Transaction.findOne(paymentQuery).sort({ createdAt: -1 }).exec();
      if (existingPaymentTx) {
        return {
          kind: 'ok',
          tx: existingPaymentTx,
          created: false,
          suppressReason: 'debtor_payment_already_posted',
        };
      }
    }

    if (
      norm.type === 'income' &&
      String(norm.category || '').toLowerCase() === 'booking' &&
      Number(norm.amount) > 0
    ) {
      const recentConfirm = await Transaction.findOne({
        source: { $in: ['guest_booking_confirm', 'booking_confirm'] },
        type: 'income',
        amount: norm.amount,
        createdAt: {
          $gte: new Date(Date.now() - MANUAL_BOOKING_INCOME_DEDUPE_AGAINST_CONFIRM_MS),
        },
      })
        .sort({ createdAt: -1 })
        .exec();
      if (recentConfirm) {
        return {
          kind: 'ok',
          tx: recentConfirm,
          created: false,
          suppressReason: 'booking_confirm_already_gl',
        };
      }
    }

    const tx = await Transaction.create({
      ...bodySafe,
      createdBy: req.user._id,
      source: 'manual',
      revenueRecognition: 'cash',
    });
    try {
      const { entryId, lines, financialJournalEntryId } =
        await transactionJournalService.postJournalForTransaction(tx, req.user._id);
      tx.journalEntryId = entryId;
      tx.financialJournalEntryId = financialJournalEntryId;
      tx.lines = lines;
      await tx.save();
    } catch (err) {
      await Transaction.findByIdAndDelete(tx._id);
      return {
        kind: 'ledger_error',
        message: err.message || 'Could not post ledger entry',
        hint: 'Ensure chart of accounts is seeded: npm run seed:accounting',
      };
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
    return { kind: 'ok', tx, created: true };
  });

  if (outcome.kind === 'ledger_error') {
    return res.status(400).json({
      success: false,
      message: outcome.message,
      hint: outcome.hint,
    });
  }

  const { tx, created, suppressReason } = outcome;
  const data = await leanTransactionWithBookingPreview(tx._id);

  if (clientIdem != null && String(clientIdem).trim()) {
    idempotencyRemember(idempotencyFingerprint(req.user._id, String(clientIdem).trim(), bodySafe), tx._id);
  }

  const dupMeta =
    created || !suppressReason
      ? {}
      : {
          message:
            suppressReason === 'debtor_payment_already_posted'
              ? 'This payment was already posted via debtor payment (Dr Bank, Cr Accounts Receivable). Duplicate manual transaction was not created.'
              : 'Same amount was already posted from a confirmed booking (Dr A/R, Cr revenue). This manual booking-income row was not created to avoid double-counting.',
        };

  res.status(201).json({
    success: true,
    data,
    ...(created ? {} : { idempotentReplay: true, duplicateSuppressed: true }),
    ...(suppressReason ? { suppressReason, ...dupMeta } : {}),
  });
});

const updateTransaction = asyncHandler(async (req, res) => {
  const tx = await Transaction.findById(req.params.id);
  if (!tx) return res.status(404).json({ success: false, message: 'Transaction not found' });
  const before = tx.toObject();
  let voidedOld = false;
  try {
    if (tx.financialJournalEntryId) {
      await transactionJournalService.voidFinancialJournalLinkedToTransaction(
        tx,
        req.user._id,
        'Transaction updated — reversing prior entry'
      );
      voidedOld = true;
      tx.financialJournalEntryId = undefined;
    }
    if (tx.journalEntryId) {
      await transactionJournalService.voidJournalLinkedToTransaction(
        tx,
        req.user._id,
        'Transaction updated — reversing prior entry'
      );
      voidedOld = true;
      tx.journalEntryId = undefined;
      tx.lines = [];
    }
    const {
      journalEntryId: _ignore,
      lines: _ignoreLines,
      guestBooking: _ig1,
      source: _ig2,
      revenueRecognition: _ig3,
      receivableAccountCode: _igRecv,
      ...bodySafe
    } = req.body;
    Object.assign(tx, bodySafe);
    tx.journalEntryId = undefined;
    tx.lines = [];
    await tx.save();
    const { entryId, lines, financialJournalEntryId } =
      await transactionJournalService.postJournalForTransaction(tx, req.user._id);
    tx.journalEntryId = entryId;
    tx.financialJournalEntryId = financialJournalEntryId;
    tx.lines = lines;
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
        const { entryId: recoveryEntryId, lines: recoveryLines, financialJournalEntryId: recoveryFjId } =
          await transactionJournalService.postJournalForTransaction(recovery, req.user._id);
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
          financialJournalEntryId: recoveryFjId,
          lines: recoveryLines,
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
    if (tx.financialJournalEntryId) {
      await transactionJournalService.voidFinancialJournalLinkedToTransaction(
        tx,
        req.user._id,
        'Transaction deleted'
      );
    }
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
  const refundTotal = expense.find((r) => r._id === 'refund')?.total ?? 0;
  const grossRevenue = income.reduce((s, r) => s + (r.total || 0), 0);
  res.json({
    success: true,
    data: {
      income,
      expense,
      refunds: refundTotal,
      revenue: { gross: grossRevenue, refunds: refundTotal, net: grossRevenue - refundTotal },
    },
  });
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
  const [refundsAgg] = await Transaction.aggregate([
    {
      $match: {
        type: 'expense',
        category: 'refund',
        date: { $gte: startDate, $lte: endDate },
      },
    },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  const [expenseExRefunds] = await Transaction.aggregate([
    {
      $match: {
        type: 'expense',
        category: { $ne: 'refund' },
        date: { $gte: startDate, $lte: endDate },
      },
    },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  const grossIncome = income?.total ?? 0;
  const refunds = refundsAgg?.total ?? 0;
  const expenseOps = expenseExRefunds?.total ?? 0;
  const netRevenue = grossIncome - refunds;
  res.json({
    success: true,
    data: {
      income: grossIncome,
      refunds,
      netRevenue,
      expense: expenseOps,
      expenseIncludingRefunds: expenseOps + refunds,
      profit: netRevenue - expenseOps,
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

async function salaryExpenseDescription(salaryDoc) {
  let who = (salaryDoc.payeeName && String(salaryDoc.payeeName).trim()) || '';
  if (!who && salaryDoc.employee) {
    const u = await User.findById(salaryDoc.employee).select('name').lean();
    who = u?.name || 'Staff';
  }
  if (!who) who = 'Worker / payroll';
  const m = salaryDoc.month ? ` · ${salaryDoc.month}` : '';
  return `Salary — ${who}${m}`;
}

const createSalary = asyncHandler(async (req, res) => {
  const body = { ...req.body };
  const emp = body.employee;
  if (emp === '' || emp === undefined || emp === null) {
    delete body.employee;
  } else if (!mongoose.Types.ObjectId.isValid(String(emp))) {
    delete body.employee;
  }

  const amt = Number(body.amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    return res.status(400).json({ success: false, message: 'amount must be a positive number' });
  }

  const salary = await Salary.create(body);

  let expenseTx = null;
  const paidOn = salary.paidOn ? new Date(salary.paidOn) : null;

  if (paidOn && amt > 0) {
    const tx = await Transaction.create({
      type: 'expense',
      category: 'salary',
      amount: amt,
      date: paidOn,
      description: await salaryExpenseDescription(salary),
      reference: `SALARY:${String(salary._id)}`,
      source: 'manual',
      revenueRecognition: 'cash',
      createdBy: req.user._id,
    });
    try {
      const { entryId, lines, financialJournalEntryId } = await transactionJournalService.postJournalForTransaction(
        tx,
        req.user._id,
      );
      tx.journalEntryId = entryId;
      tx.financialJournalEntryId = financialJournalEntryId;
      tx.lines = lines;
      await tx.save();
      salary.expenseTransactionId = tx._id;
      await salary.save();
      expenseTx = tx;
      await logAudit({
        userId: req.user._id,
        role: req.user.role,
        action: 'create',
        entity: 'Transaction',
        entityId: tx._id,
        after: tx.toObject(),
        req,
      });
    } catch (err) {
      await Transaction.findByIdAndDelete(tx._id);
      await Salary.findByIdAndDelete(salary._id);
      return res.status(400).json({
        success: false,
        message: err.message || 'Could not post salary expense to the ledger',
        hint: 'Ensure chart of accounts is seeded (e.g. npm run seed:chart-v3).',
      });
    }
  }

  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'create',
    entity: 'Salary',
    entityId: salary._id,
    after: salary.toObject(),
    req,
  });

  const data = await Salary.findById(salary._id).populate('employee', 'name email').lean();
  const related = expenseTx ? { expenseTransaction: await leanTransactionWithBookingPreview(expenseTx._id) } : {};

  res.status(201).json({
    success: true,
    data,
    ...related,
    meta: {
      expenseTransactionCreated: !!expenseTx,
      expenseTransactionNote: expenseTx
        ? null
        : 'Set paidOn to the payment date when recording a paid run to create the expense transaction and bank journal automatically.',
    },
  });
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
