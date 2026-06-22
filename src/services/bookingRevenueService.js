/**
 * Revenue recognition for stays: only when status is **confirmed** (guest or internal booking).
 * Pending requests do not create Debtor, Transaction, v3 journal, or invoice — no P&L impact until confirm.
 * On confirm: **JE-01** via `financialGlPostingService` (DR 1010 / CR 4001 room + CR 4003 food) — Chynae v3.0.
 * Control A/R **1010** only (no per-booking GL sub-accounts). On cancel after confirm: posts a **reversing**
 * journal (swapped Dr/Cr on the same accounts) then **voids** the original v3 header — see `postReversalThenVoidFinancialJournalV3`.
 */
const Debtor = require('../models/Debtor');
const Transaction = require('../models/Transaction');
const Invoice = require('../models/Invoice');
const transactionJournalService = require('./transactionJournalService');
const financialGlPostingService = require('./financialGlPostingService');
const guestReceivableAccountService = require('./guestReceivableAccountService');
const bookingInvoiceService = require('./bookingInvoiceService');
const { scheduleInvoiceDelivery } = require('./invoiceNotifyService');
const { guestPayNowPageUrl } = require('./payfastService');
const Room = require('../models/Room');
const Account = require('../models/Account');
const { REVENUE_ACCOUNTS } = require('../constants/foodAddOns');
const {
  computeStayQuote,
  hasAnyFoodAddOn,
  getGuestBookingRevenueSplit,
} = require('../utils/foodAddOnPricing');
const { round2 } = require('../utils/math');

function bookingRecognitionDate(doc) {
  const eventDate = doc?.eventDate ? new Date(doc.eventDate) : null;
  const checkIn = doc?.checkIn ? new Date(doc.checkIn) : null;
  const preferred = eventDate || checkIn;
  if (preferred && !Number.isNaN(preferred.getTime())) return preferred;
  return new Date();
}

async function voidInvoiceLinkedToBooking(bookingDoc) {
  let invId = bookingDoc.invoiceId;
  if (!invId && bookingDoc.debtorId) {
    const d = await Debtor.findById(bookingDoc.debtorId).select('invoiceRef').lean();
    invId = d?.invoiceRef;
  }
  if (invId) await Invoice.findByIdAndUpdate(invId, { status: 'void' });
}

function debtorStatusFor(amountOwed, amountPaid) {
  const owed = Number(amountOwed) || 0;
  const paid = Number(amountPaid) || 0;
  if (paid <= 0) return 'outstanding';
  if (paid >= owed) return 'paid';
  return 'partial';
}

/** Plain invoice fields for async email (avoids Mongoose subdoc / buffer issues in setImmediate). */
function buildInvoiceEmailFields(invoice, stayTotal, deposit) {
  const o =
    invoice && typeof invoice.toObject === 'function'
      ? invoice.toObject({ flattenMaps: true })
      : invoice || {};
  const lineItems = (o.lineItems || []).map((li) => ({
    description: li.description,
    qty: li.qty,
    unitPrice: li.unitPrice,
    total: li.total,
  }));
  const tot = Number(o.total);
  const total = Number.isFinite(tot) && tot > 0 ? tot : stayTotal;
  const depositDue = total;
  return {
    invoiceNumber: o.invoiceNumber,
    total,
    deposit: depositDue,
    balanceDue: 0,
    notes: o.notes,
    dueDate: o.dueDate,
    lineItems,
  };
}

/** Ensure pricingBreakdown exists before invoice/email when food add-ons were selected. */
async function ensureGuestBookingPricingBreakdown(gb) {
  const foodAddOns = gb.foodAddOns || {};
  if (!hasAnyFoodAddOn(foodAddOns)) return;

  const existing = gb.pricingBreakdown?.lineItems || [];
  const hasFoodLine = existing.some((li) => li.id === 'breakfast' || li.id === 'picnic');
  if (hasFoodLine) return;

  const room = await Room.findById(gb.roomId).select('name pricePerNight').lean();
  if (!room) return;

  const quote = computeStayQuote({
    pricePerNight: room.pricePerNight,
    checkIn: gb.checkIn,
    checkOut: gb.checkOut,
    guestCount: gb.guestCount,
    foodAddOns,
    roomName: room.name,
  });

  gb.pricingBreakdown = {
    nights: quote.nights,
    roomTotal: round2(Number(gb.totalAmount) - quote.foodTotal),
    foodTotal: quote.foodTotal,
    lineItems: quote.lineItems,
  };
  gb.roomAmount = gb.pricingBreakdown.roomTotal;
  gb.foodAmount = gb.pricingBreakdown.foodTotal;
  await gb.save();
}

function bookingRoomReference(trackingCode) {
  const code = String(trackingCode || '').trim();
  return code ? `BOOK-${code}` : undefined;
}

function bookingFoodReference(trackingCode) {
  const code = String(trackingCode || '').trim();
  return code ? `BOOK-FOOD-${code}` : undefined;
}

async function buildRoomRevenueTxLines(roomTotal) {
  const accounts = await Account.find({ code: { $in: ['1010', REVENUE_ACCOUNTS.room] } })
    .select('_id code name')
    .lean();
  const byCode = Object.fromEntries(accounts.map((a) => [a.code, a]));
  if (!byCode['1010'] || !byCode[REVENUE_ACCOUNTS.room]) {
    throw new Error('Missing chart accounts for room revenue (1010 and/or 4001)');
  }
  const amt = round2(roomTotal);
  return [
    {
      accountId: byCode['1010']._id,
      accountCode: byCode['1010'].code,
      accountName: byCode['1010'].name,
      debit: amt,
      credit: 0,
      description: 'Guest booking receivable — room',
    },
    {
      accountId: byCode[REVENUE_ACCOUNTS.room]._id,
      accountCode: byCode[REVENUE_ACCOUNTS.room].code,
      accountName: byCode[REVENUE_ACCOUNTS.room].name,
      debit: 0,
      credit: amt,
      description: 'BnB room revenue',
    },
  ];
}

async function buildFoodRevenueTxLines(foodTotal) {
  const accounts = await Account.find({ code: { $in: ['1010', REVENUE_ACCOUNTS.food] } })
    .select('_id code name')
    .lean();
  const byCode = Object.fromEntries(accounts.map((a) => [a.code, a]));
  if (!byCode['1010'] || !byCode[REVENUE_ACCOUNTS.food]) {
    throw new Error('Missing chart account 4003 for food add-on revenue');
  }
  const amt = round2(foodTotal);
  return [
    {
      accountId: byCode['1010']._id,
      accountCode: byCode['1010'].code,
      accountName: byCode['1010'].name,
      debit: amt,
      credit: 0,
      description: 'Guest booking receivable — food',
    },
    {
      accountId: byCode[REVENUE_ACCOUNTS.food]._id,
      accountCode: byCode[REVENUE_ACCOUNTS.food].code,
      accountName: byCode[REVENUE_ACCOUNTS.food].name,
      debit: 0,
      credit: amt,
      description: 'Food add-on revenue',
    },
  ];
}

async function buildGuestBookingRevenueTxLines(split) {
  const codes = ['1010', REVENUE_ACCOUNTS.room];
  if (split.foodTotal > 0) codes.push(REVENUE_ACCOUNTS.food);
  const accounts = await Account.find({ code: { $in: codes } })
    .select('_id code name')
    .lean();
  const byCode = Object.fromEntries(accounts.map((a) => [a.code, a]));
  if (!byCode['1010'] || !byCode[REVENUE_ACCOUNTS.room]) {
    throw new Error('Missing chart accounts for booking revenue (1010 and/or 4001)');
  }
  if (split.foodTotal > 0 && !byCode[REVENUE_ACCOUNTS.food]) {
    throw new Error('Missing chart account 4003 for food add-on revenue');
  }

  const lines = [
    {
      accountId: byCode['1010']._id,
      accountCode: byCode['1010'].code,
      accountName: byCode['1010'].name,
      debit: split.total,
      credit: 0,
      description: 'Guest booking receivable',
    },
  ];

  if (split.roomTotal > 0) {
    const acc = byCode[REVENUE_ACCOUNTS.room];
    lines.push({
      accountId: acc._id,
      accountCode: acc.code,
      accountName: acc.name,
      debit: 0,
      credit: split.roomTotal,
      description: 'BnB room revenue',
    });
  }

  if (split.foodTotal > 0) {
    const acc = byCode[REVENUE_ACCOUNTS.food];
    lines.push({
      accountId: acc._id,
      accountCode: acc.code,
      accountName: acc.name,
      debit: 0,
      credit: split.foodTotal,
      description: 'Food add-on revenue',
    });
  }

  return lines;
}

/**
 * Post debtor, invoice, GL journal, and split revenue transactions (room + food).
 * Idempotent — safe to call from confirm or manual "Post room & food revenue".
 */
async function postGuestBookingRevenue(gb, userId) {
  if (gb.status !== 'confirmed') {
    throw new Error('Booking must be confirmed before revenue can be posted');
  }

  const split = getGuestBookingRevenueSplit(gb);
  const roomPostedId = gb.roomRevenueTransactionId || gb.revenueTransactionId;
  const foodNeeded = split.foodTotal > 0;

  if (roomPostedId && gb.debtorId && gb.invoiceId && (!foodNeeded || gb.foodRevenueTransactionId)) {
    const roomTxCheck = await Transaction.findById(roomPostedId).select('financialJournalEntryId').lean();
    if (roomTxCheck?.financialJournalEntryId) {
      return {
        skipped: true,
        reason: 'already_recorded',
        debtorId: gb.debtorId,
        roomRevenueTransactionId: gb.roomRevenueTransactionId || gb.revenueTransactionId,
        foodRevenueTransactionId: gb.foodRevenueTransactionId,
        revenueTransactionId: gb.revenueTransactionId,
        financialJournalEntryId: roomTxCheck.financialJournalEntryId,
        invoiceId: gb.invoiceId,
        roomTotal: split.roomTotal,
        foodTotal: split.foodTotal,
        total: Number(gb.totalAmount) || 0,
      };
    }
  }

  const total = Number(gb.totalAmount) || 0;
  if (total <= 0) throw new Error('Booking has no amount to recognise');

  gb.deposit = total;
  await gb.save();

  await ensureGuestBookingPricingBreakdown(gb);

  const recognitionDate = bookingRecognitionDate(gb);
  const roomRef = bookingRoomReference(gb.trackingCode);
  const foodRef = bookingFoodReference(gb.trackingCode);

  const arAcc = await guestReceivableAccountService.ensureControlAccountsReceivable(userId);
  if (!gb.receivableAccountId) {
    gb.receivableAccountId = arAcc._id;
    await gb.save();
  }

  let debtor;
  if (!gb.debtorId) {
    debtor = await Debtor.create({
      name: gb.guestName,
      contactEmail: gb.guestEmail,
      contactPhone: gb.guestPhone,
      description: `Guest booking ${gb.trackingCode}`,
      amountOwed: total,
      amountPaid: 0,
      status: debtorStatusFor(total, 0),
      guestBookingRef: gb._id,
      receivableAccountId: arAcc._id,
      createdBy: userId,
    });
    gb.debtorId = debtor._id;
    await gb.save();
  } else {
    debtor = await Debtor.findById(gb.debtorId);
    if (!debtor) throw new Error('Linked debtor record not found');
    if (Number(debtor.amountOwed) !== total) {
      debtor.amountOwed = total;
      debtor.status = debtorStatusFor(total, Number(debtor.amountPaid) || 0);
      await debtor.save();
    }
  }

  let roomTxId = gb.roomRevenueTransactionId || gb.revenueTransactionId;
  let roomTx = roomTxId ? await Transaction.findById(roomTxId) : null;

  if (roomTx && split.foodTotal > 0 && Number(roomTx.amount) === total) {
    roomTx.amount = split.roomTotal;
    roomTx.reference = roomRef;
    roomTx.description = `Room revenue — ${gb.guestName} (${gb.trackingCode})`;
    roomTx.lines = await buildRoomRevenueTxLines(split.roomTotal);
    await roomTx.save();
  }

  if (!roomTx) {
    const roomAmount = split.foodTotal > 0 ? split.roomTotal : total;
    roomTx = await Transaction.create({
      type: 'income',
      category: 'booking',
      amount: roomAmount,
      date: recognitionDate,
      description: `Room revenue — ${gb.guestName} (${gb.trackingCode})`,
      reference: roomRef,
      guestBooking: gb._id,
      source: 'guest_booking_confirm',
      revenueRecognition: 'accrual_ar',
      receivableAccountCode: arAcc.code,
      createdBy: userId,
      lines: await buildRoomRevenueTxLines(roomAmount),
    });
    roomTxId = roomTx._id;
    gb.roomRevenueTransactionId = roomTxId;
    gb.revenueTransactionId = roomTxId;
    await gb.save();
  } else if (!gb.roomRevenueTransactionId) {
    gb.roomRevenueTransactionId = roomTx._id;
    gb.revenueTransactionId = roomTx._id;
    await gb.save();
  }

  let foodTx = gb.foodRevenueTransactionId
    ? await Transaction.findById(gb.foodRevenueTransactionId)
    : null;

  if (split.foodTotal > 0 && !foodTx) {
    foodTx = await Transaction.create({
      type: 'income',
      category: 'catering',
      amount: split.foodTotal,
      date: recognitionDate,
      description: `Food add-on revenue — ${gb.guestName} (${gb.trackingCode})`,
      reference: foodRef,
      guestBooking: gb._id,
      source: 'guest_booking_confirm_food',
      revenueRecognition: 'accrual_ar',
      receivableAccountCode: arAcc.code,
      createdBy: userId,
      lines: await buildFoodRevenueTxLines(split.foodTotal),
    });
    gb.foodRevenueTransactionId = foodTx._id;
    await gb.save();
  }

  if (!roomTx.financialJournalEntryId) {
    try {
      const je = await financialGlPostingService.postGuestBookingRevenueV3(gb, userId, {
        journalDate: recognitionDate,
      });
      roomTx.financialJournalEntryId = je._id;
      roomTx.lines = await buildGuestBookingRevenueTxLines(split);
      await roomTx.save();
      if (foodTx) {
        foodTx.financialJournalEntryId = je._id;
        await foodTx.save();
      }
    } catch (err) {
      if (!gb.debtorId || (await Transaction.countDocuments({ guestBooking: gb._id })) <= 1) {
        await Transaction.deleteMany({ guestBooking: gb._id, _id: { $in: [roomTx._id, foodTx?._id].filter(Boolean) } });
        if (debtor && !gb.invoiceId) {
          await Debtor.findByIdAndDelete(debtor._id);
          gb.debtorId = undefined;
        }
        gb.roomRevenueTransactionId = undefined;
        gb.foodRevenueTransactionId = undefined;
        gb.revenueTransactionId = undefined;
        gb.receivableAccountId = undefined;
        await gb.save();
      }
      throw err;
    }
  }

  let invoice;
  if (!gb.invoiceId) {
    try {
      invoice = await bookingInvoiceService.createInvoiceForConfirmedGuestBooking(gb, debtor, userId);
      gb.invoiceId = invoice._id;
      await gb.save();
    } catch (err) {
      if (roomTx.financialJournalEntryId) {
        await financialGlPostingService.voidFinancialJournalEntry(
          roomTx.financialJournalEntryId,
          userId,
          'Invoice creation failed',
        );
      }
      await Transaction.deleteMany({ guestBooking: gb._id });
      await Debtor.findByIdAndDelete(debtor._id);
      gb.debtorId = undefined;
      gb.roomRevenueTransactionId = undefined;
      gb.foodRevenueTransactionId = undefined;
      gb.revenueTransactionId = undefined;
      gb.invoiceId = undefined;
      gb.receivableAccountId = undefined;
      await guestReceivableAccountService.deactivateForGuestBooking(gb, { skipSave: true });
      await gb.save();
      throw err;
    }

    scheduleInvoiceDelivery({
      ...buildInvoiceEmailFields(invoice, total, total),
      guestName: gb.guestName,
      email: gb.guestEmail,
      phone: gb.guestPhone,
      checkIn: gb.checkIn,
      checkOut: gb.checkOut,
      guestCount: gb.guestCount,
      foodAddOns: gb.foodAddOns,
      pricingBreakdown: gb.pricingBreakdown,
      trackingCode: gb.trackingCode,
      payNowUrl: guestPayNowPageUrl(gb.guestEmail, gb.trackingCode),
      relatedModel: 'GuestBooking',
      relatedId: gb._id,
    });
  }

  return {
    debtorId: gb.debtorId,
    roomRevenueTransactionId: gb.roomRevenueTransactionId,
    foodRevenueTransactionId: gb.foodRevenueTransactionId,
    revenueTransactionId: gb.revenueTransactionId,
    financialJournalEntryId: roomTx.financialJournalEntryId,
    invoiceId: gb.invoiceId,
    roomTotal: split.roomTotal,
    foodTotal: split.foodTotal,
    total,
  };
}

/**
 * @param {import('mongoose').Document} gb - GuestBooking mongoose doc
 * @param {import('mongoose').Types.ObjectId} userId
 */
async function onGuestBookingConfirmed(gb, userId) {
  if (gb.status !== 'confirmed') return { skipped: true, reason: 'not_confirmed' };
  return postGuestBookingRevenue(gb, userId);
}

/**
 * @param {import('mongoose').Document} b - internal Booking mongoose doc
 * @param {import('mongoose').Types.ObjectId} userId
 */
async function onInternalBookingConfirmed(b, userId) {
  if (b.status !== 'confirmed') return { skipped: true, reason: 'not_confirmed' };
  if (b.revenueTransactionId) return { skipped: true, reason: 'already_recorded' };

  const total = Number(b.amount) || 0;
  if (total <= 0) return { skipped: true, reason: 'no_amount' };

  const deposit = Math.min(Number(b.deposit) || 0, total);
  const category = b.type === 'event' ? 'event' : 'booking';
  const recognitionDate = bookingRecognitionDate(b);

  const arAcc = await guestReceivableAccountService.ensureControlAccountsReceivable(userId);
  b.receivableAccountId = arAcc._id;
  await b.save();

  const debtor = await Debtor.create({
    name: b.guestName,
    contactEmail: b.guestEmail,
    contactPhone: b.guestPhone,
    description: `Booking ${b.type} — ${b._id}`,
    amountOwed: total,
    amountPaid: deposit,
    status: debtorStatusFor(total, deposit),
    bookingRef: b._id,
    receivableAccountId: arAcc._id,
    createdBy: userId,
  });

  const tx = await Transaction.create({
    type: 'income',
    category,
    amount: total,
    date: recognitionDate,
    description: `Confirmed booking — ${b.guestName} (${b.type})`,
    booking: b._id,
    source: 'booking_confirm',
    revenueRecognition: 'accrual_ar',
    receivableAccountCode: arAcc.code,
    createdBy: userId,
  });

  try {
    const je = await financialGlPostingService.postInternalBookingRevenueV3(b, userId, { journalDate: recognitionDate });
    tx.financialJournalEntryId = je._id;
    await tx.save();
  } catch (err) {
    await Transaction.findByIdAndDelete(tx._id);
    await Debtor.findByIdAndDelete(debtor._id);
    await guestReceivableAccountService.deactivateForInternalBooking(b, { skipSave: true });
    b.receivableAccountId = undefined;
    await b.save();
    throw err;
  }

  let invoice;
  try {
    invoice = await bookingInvoiceService.createInvoiceForConfirmedInternalBooking(b, debtor, userId);
  } catch (err) {
    await financialGlPostingService.voidFinancialJournalEntry(tx.financialJournalEntryId, userId, 'Invoice creation failed');
    await Transaction.findByIdAndDelete(tx._id);
    await Debtor.findByIdAndDelete(debtor._id);
    await guestReceivableAccountService.deactivateForInternalBooking(b, { skipSave: true });
    b.receivableAccountId = undefined;
    await b.save();
    throw err;
  }

  b.debtorId = debtor._id;
  b.revenueTransactionId = tx._id;
  b.invoiceId = invoice._id;
  await b.save();

  // Internal bookings: no guest email/WhatsApp (admin alert only, on create via scheduleInternalBookingCreatedAdmin).

  return {
    debtorId: debtor._id,
    transactionId: tx._id,
    financialJournalEntryId: tx.financialJournalEntryId,
    invoiceId: invoice._id,
  };
}

async function reverseGuestBookingRevenue(gb, userId) {
  const txIds = [
    gb.foodRevenueTransactionId,
    gb.roomRevenueTransactionId || gb.revenueTransactionId,
  ].filter(Boolean);

  if (!txIds.length) return { skipped: true };

  const txs = await Transaction.find({ _id: { $in: txIds } });
  const jeId = txs.find((t) => t.financialJournalEntryId)?.financialJournalEntryId;

  if (jeId) {
    await financialGlPostingService.postReversalThenVoidFinancialJournalV3(jeId, userId, {
      voidReason: 'Guest booking cancelled',
    });
  }

  for (const tx of txs) {
    if (tx.journalEntryId) {
      await transactionJournalService.voidJournalLinkedToTransaction(tx, userId, 'Guest booking cancelled');
    }
    await tx.deleteOne();
  }

  await voidInvoiceLinkedToBooking(gb);
  if (gb.debtorId) {
    const currentDebtor = await Debtor.findById(gb.debtorId).select('amountPaid').lean();
    const preservedPaid = Number(currentDebtor?.amountPaid) || 0;
    await Debtor.findByIdAndUpdate(gb.debtorId, {
      status: preservedPaid > 0 ? 'paid' : 'written-off',
      amountOwed: 0,
      amountPaid: preservedPaid,
      notes: 'Closed — guest booking cancelled (revenue reversed, payment retained)',
    });
  }
  gb.revenueTransactionId = undefined;
  gb.roomRevenueTransactionId = undefined;
  gb.foodRevenueTransactionId = undefined;
  gb.debtorId = undefined;
  gb.invoiceId = undefined;
  await guestReceivableAccountService.deactivateForGuestBooking(gb, { skipSave: true });
  await gb.save();
  return { reversed: true };
}

async function reverseInternalBookingRevenue(b, userId) {
  if (!b.revenueTransactionId) return { skipped: true };
  const tx = await Transaction.findById(b.revenueTransactionId);
  if (!tx) {
    await voidInvoiceLinkedToBooking(b);
    b.revenueTransactionId = undefined;
    b.debtorId = undefined;
    b.invoiceId = undefined;
    await guestReceivableAccountService.deactivateForInternalBooking(b, { skipSave: true });
    await b.save();
    return { skipped: true };
  }
  if (tx.financialJournalEntryId) {
    await financialGlPostingService.postReversalThenVoidFinancialJournalV3(
      tx.financialJournalEntryId,
      userId,
      { voidReason: 'Booking cancelled' }
    );
  }
  if (tx.journalEntryId) {
    await transactionJournalService.voidJournalLinkedToTransaction(tx, userId, 'Booking cancelled');
  }
  await voidInvoiceLinkedToBooking(b);
  await tx.deleteOne();
  if (b.debtorId) {
    const currentDebtor = await Debtor.findById(b.debtorId).select('amountPaid').lean();
    const preservedPaid = Number(currentDebtor?.amountPaid) || 0;
    await Debtor.findByIdAndUpdate(b.debtorId, {
      status: preservedPaid > 0 ? 'paid' : 'written-off',
      amountOwed: 0,
      amountPaid: preservedPaid,
      notes: 'Closed — booking cancelled (revenue reversed, payment retained)',
    });
  }
  b.revenueTransactionId = undefined;
  b.debtorId = undefined;
  b.invoiceId = undefined;
  await guestReceivableAccountService.deactivateForInternalBooking(b, { skipSave: true });
  await b.save();
  return { reversed: true };
}

module.exports = {
  postGuestBookingRevenue,
  onGuestBookingConfirmed,
  onInternalBookingConfirmed,
  reverseGuestBookingRevenue,
  reverseInternalBookingRevenue,
};
