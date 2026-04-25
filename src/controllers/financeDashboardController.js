const Transaction = require('../models/Transaction');
const JournalEntry = require('../models/JournalEntry');
const Debtor = require('../models/Debtor');
const Invoice = require('../models/Invoice');
const Supplier = require('../models/Supplier');
const Booking = require('../models/Booking');
const GuestBooking = require('../models/GuestBooking');
const Salary = require('../models/Salary');
const Room = require('../models/Room');
const Stock = require('../models/Stock');
const AuditLog = require('../models/AuditLog');
const { asyncHandler } = require('../utils/helpers');
const { round2, percent } = require('../utils/math');

function pctChange(current, prior) {
  if (prior == null || prior === 0) return current > 0 ? 100 : current < 0 ? -100 : 0;
  return round2(((current - prior) / Math.abs(prior)) * 100);
}

function utcDay(d) {
  const x = new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
}

function sameUtcDay(a, b) {
  return utcDay(a).getTime() === utcDay(b).getTime();
}

function utcStartOfDay(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function displayStatusForInvoice(status) {
  if (status === 'sent') return 'Sent';
  if (status === 'draft') return 'Draft';
  if (status === 'paid') return 'Paid';
  if (status === 'void') return 'Void';
  return status || '—';
}

function suggestedActionForInvoice(inv) {
  if (inv.status === 'draft') return 'Review';
  if (inv.type === 'supplier') return 'Pay';
  if (inv.type === 'guest') return 'Record';
  return 'Review';
}

async function invoiceOpenAndDueStats(now = new Date()) {
  const today0 = utcStartOfDay(now);
  const weekEnd = new Date(today0);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);
  weekEnd.setUTCHours(23, 59, 59, 999);

  const [facet] = await Invoice.aggregate([
    {
      $facet: {
        open: [{ $match: { status: { $in: ['draft', 'sent'] } } }, { $count: 'n' }],
        dueThisWeek: [
          {
            $match: {
              status: { $in: ['draft', 'sent'] },
              dueDate: { $gte: today0, $lte: weekEnd },
            },
          },
          { $group: { _id: null, n: { $sum: 1 }, total: { $sum: { $ifNull: ['$total', 0] } } } },
        ],
        overdue: [
          {
            $match: {
              status: 'sent',
              dueDate: { $lt: today0 },
            },
          },
          { $group: { _id: null, n: { $sum: 1 }, total: { $sum: { $ifNull: ['$total', 0] } } } },
        ],
      },
    },
  ]);

  const openCount = facet.open[0]?.n || 0;
  const dueW = facet.dueThisWeek[0];
  const od = facet.overdue[0];
  return {
    openInvoicesCount: openCount,
    dueThisWeekCount: dueW?.n || 0,
    dueThisWeekAmount: round2(dueW?.total || 0),
    overdueInvoicesCount: od?.n || 0,
    overdueAmount: round2(od?.total || 0),
  };
}

async function latestPostedJournalMeta() {
  const last = await JournalEntry.findOne({ status: 'POSTED' })
    .sort({ entryDate: -1 })
    .select('entryDate')
    .lean();
  if (!last?.entryDate) {
    return { status: 'unknown', lastPostedAt: null, daysSincePost: null };
  }
  const days = (Date.now() - new Date(last.entryDate).getTime()) / 86400000;
  return {
    status: days <= 7 ? 'current' : 'stale',
    lastPostedAt: new Date(last.entryDate).toISOString(),
    daysSincePost: round2(days),
  };
}

function buildControlHeadline(ledgerMeta, invStats) {
  const ledgerOk = ledgerMeta.status === 'current';
  const ledgerPart = ledgerOk
    ? 'Ledgers are current.'
    : ledgerMeta.status === 'stale'
      ? 'Ledger activity may need attention.'
      : 'No posted journals yet.';

  let duePart = 'No invoices due this week.';
  if (invStats.dueThisWeekCount > 0) {
    duePart = `${invStats.dueThisWeekCount} invoice${invStats.dueThisWeekCount === 1 ? '' : 's'} due this week`;
  }

  const odPart =
    invStats.overdueInvoicesCount === 0
      ? 'nothing overdue.'
      : `${invStats.overdueInvoicesCount} overdue (R ${invStats.overdueAmount}).`;

  return `${ledgerPart} ${duePart} — ${odPart}`;
}

async function buildPayrollQueueRow(monthStr, y, m) {
  const unpaid = await Salary.find({ month: monthStr, paidOn: null }).lean();
  if (!unpaid.length) return null;
  const total = unpaid.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const last = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999));
  const monthName = new Date(Date.UTC(y, m, 1)).toLocaleString('en-ZA', { month: 'long' });
  return {
    id: `payroll-${monthStr}`,
    source: 'payroll',
    party: 'Staff payroll',
    reference: `${monthName} run`,
    dueDate: last.toISOString(),
    dueLabel: dueLabel(last),
    amount: round2(total),
    status: 'scheduled',
    displayStatus: 'Scheduled',
    categoryLabel: 'Payroll',
    suggestedAction: 'Review',
    type: 'payroll',
  };
}

function mergePaymentQueue(invoiceRows, payrollRow, limit = 25) {
  const rows = payrollRow ? [...invoiceRows, payrollRow] : [...invoiceRows];
  rows.sort((a, b) => {
    const ta = a.dueDate ? new Date(a.dueDate).getTime() : 9e15;
    const tb = b.dueDate ? new Date(b.dueDate).getTime() : 9e15;
    return ta - tb;
  });
  return rows.slice(0, limit);
}

function utcEndOfDay(d = new Date()) {
  const start = utcStartOfDay(d);
  const next = new Date(start);
  next.setUTCDate(next.getUTCDate() + 1);
  // inclusive end: 23:59:59.999
  next.setUTCMilliseconds(next.getUTCMilliseconds() - 1);
  return next;
}

function inUtcRange(dateValue, startUtc, endUtc) {
  if (!dateValue) return false;
  const t = new Date(dateValue).getTime();
  return t >= startUtc.getTime() && t <= endUtc.getTime();
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function collapseTransactionDuplicateRows(rows) {
  const byKey = new Map();
  for (const tx of rows || []) {
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
    if (curJ && !prevJ) {
      byKey.set(key, tx);
      continue;
    }
    if (curJ === prevJ) {
      const pt = new Date(prev.updatedAt || prev.createdAt || 0).getTime();
      const ct = new Date(tx.updatedAt || tx.createdAt || 0).getTime();
      if (ct >= pt) byKey.set(key, tx);
    }
  }
  return Array.from(byKey.values());
}

function normalizeDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function recognizedTransactionAmount(tx, start, end) {
  const amount = Number(tx?.amount || 0);
  if (!Number.isFinite(amount) || amount === 0) return 0;
  const category = String(tx?.category || '').toLowerCase();
  const booking = tx?.booking || null;
  const guestBooking = tx?.guestBooking || null;

  if (category === 'booking') {
    const checkIn = booking?.checkIn || guestBooking?.checkIn;
    if (!checkIn) return 0;
    const ci = normalizeDay(checkIn);
    const ps = normalizeDay(start);
    const pe = normalizeDay(end);
    return ci >= ps && ci <= pe ? amount : 0;
  }
  if (category === 'event') {
    const eventDate = booking?.eventDate ? new Date(booking.eventDate) : null;
    if (eventDate && !Number.isNaN(eventDate.getTime())) {
      return eventDate >= new Date(start) && eventDate <= new Date(end) ? amount : 0;
    }
  }

  const txDate = new Date(tx?.date);
  return txDate >= new Date(start) && txDate <= new Date(end) ? amount : 0;
}

async function recognizedRevenueBreakdown(start, end) {
  const rows = await Transaction.find({
    type: 'income',
    category: { $in: ['booking', 'event'] },
    $or: [{ date: { $gte: new Date(start), $lte: new Date(end) } }, { category: { $in: ['booking', 'event'] } }],
  })
    .select('type category amount date description createdBy journalEntryId createdAt updatedAt booking guestBooking')
    .populate('booking', 'checkIn eventDate')
    .populate('guestBooking', 'checkIn')
    .lean();

  const deduped = collapseTransactionDuplicateRows(rows);
  let bookingRevenue = 0;
  let eventRevenue = 0;
  for (const tx of deduped) {
    const recognized = recognizedTransactionAmount(tx, start, end);
    if (!recognized) continue;
    const category = String(tx.category || '').toLowerCase();
    if (category === 'booking') bookingRevenue += recognized;
    else if (category === 'event') eventRevenue += recognized;
  }
  return {
    bookingRevenue: round2(bookingRevenue),
    eventRevenue: round2(eventRevenue),
    totalRevenue: round2(bookingRevenue + eventRevenue),
  };
}

function overlapSoldNights(checkIn, checkOut, start, end) {
  if (!checkIn || !checkOut) return 0;
  const stayStart = utcStartOfDay(new Date(checkIn));
  const stayEnd = utcStartOfDay(new Date(checkOut));
  const rangeStart = utcStartOfDay(new Date(start));
  const rangeEndExclusive = new Date(utcStartOfDay(new Date(end)).getTime() + MS_PER_DAY);
  const overlapStart = Math.max(stayStart.getTime(), rangeStart.getTime());
  const overlapEnd = Math.min(stayEnd.getTime(), rangeEndExclusive.getTime());
  if (overlapEnd <= overlapStart) return 0;
  return Math.floor((overlapEnd - overlapStart) / MS_PER_DAY);
}

async function buildMonthlyRoomOccupancy(monthSpecs) {
  if (!Array.isArray(monthSpecs) || monthSpecs.length === 0) return { windowMonths: 0, months: [], byRoom: [] };

  const first = monthSpecs[0];
  const last = monthSpecs[monthSpecs.length - 1];
  const { start: windowStart } = monthBounds(first.ty, first.tm);
  const { end: windowEnd } = monthBounds(last.ty, last.tm);

  const [rooms, internalBookings, guestBookings] = await Promise.all([
    Room.find().select('_id name type').sort({ name: 1 }).lean(),
    Booking.find({
      status: { $nin: ['cancelled'] },
      roomId: { $ne: null },
      checkIn: { $lte: windowEnd },
      checkOut: { $gte: windowStart },
    })
      .select('roomId checkIn checkOut')
      .lean(),
    GuestBooking.find({
      status: { $nin: ['cancelled'] },
      roomId: { $ne: null },
      checkIn: { $lte: windowEnd },
      checkOut: { $gte: windowStart },
    })
      .select('roomId checkIn checkOut')
      .lean(),
  ]);

  const bookingsByRoom = new Map();
  for (const row of [...internalBookings, ...guestBookings]) {
    const roomId = String(row.roomId || '');
    if (!roomId) continue;
    if (!bookingsByRoom.has(roomId)) bookingsByRoom.set(roomId, []);
    bookingsByRoom.get(roomId).push(row);
  }

  const months = monthSpecs.map(({ ty, tm }) => {
    const { start, end } = monthBounds(ty, tm);
    const daysInMonth = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
    return {
      key: `${ty}-${String(tm + 1).padStart(2, '0')}`,
      label: new Date(Date.UTC(ty, tm, 1)).toLocaleString('en-ZA', { month: 'short' }),
      start,
      end,
      daysInMonth,
    };
  });

  const byRoom = rooms.map((room) => {
    const roomId = String(room._id);
    const roomBookings = bookingsByRoom.get(roomId) || [];
    const series = months.map((month) => {
      const soldNights = roomBookings.reduce(
        (sum, b) => sum + overlapSoldNights(b.checkIn, b.checkOut, month.start, month.end),
        0
      );
      const occupancyPct = month.daysInMonth > 0 ? round2((soldNights / month.daysInMonth) * 100) : 0;
      return {
        key: month.key,
        soldNights,
        availableNights: month.daysInMonth,
        occupancyPct,
      };
    });
    return {
      roomId,
      roomName: room.name || '—',
      roomType: room.type || null,
      monthly: series,
      averageOccupancyPct:
        series.length > 0 ? round2(series.reduce((s, x) => s + x.occupancyPct, 0) / series.length) : 0,
    };
  });

  const overallByMonth = months.map((month) => {
    const totals = byRoom.reduce(
      (acc, room) => {
        const point = room.monthly.find((x) => x.key === month.key);
        acc.soldNights += Number(point?.soldNights || 0);
        acc.availableNights += Number(point?.availableNights || 0);
        return acc;
      },
      { soldNights: 0, availableNights: 0 }
    );
    return {
      key: month.key,
      label: month.label,
      soldNights: totals.soldNights,
      availableNights: totals.availableNights,
      occupancyPct: totals.availableNights > 0 ? round2((totals.soldNights / totals.availableNights) * 100) : 0,
    };
  });

  return {
    windowMonths: months.length,
    months: months.map(({ key, label }) => ({ key, label })),
    byRoom,
    overallByMonth,
  };
}

async function buildOperationsDashboard(now, monthSpecs = []) {
  const todayStart = utcStartOfDay(now);
  const todayEnd = utcEndOfDay(now);

  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setUTCDate(yesterdayStart.getUTCDate() - 1);
  const yesterdayEnd = new Date(todayStart.getTime() - 1);

  // Expected check-ins/outs today
  const [internalCheckIns, internalCheckOuts, guestCheckIns, guestCheckOuts] = await Promise.all([
    Booking.countDocuments({
      status: { $ne: 'cancelled' },
      checkIn: { $gte: todayStart, $lte: todayEnd },
    }),
    Booking.countDocuments({
      status: { $ne: 'cancelled' },
      checkOut: { $gte: todayStart, $lte: todayEnd },
    }),
    GuestBooking.countDocuments({
      status: { $ne: 'cancelled' },
      checkIn: { $gte: todayStart, $lte: todayEnd },
    }),
    GuestBooking.countDocuments({
      status: { $ne: 'cancelled' },
      checkOut: { $gte: todayStart, $lte: todayEnd },
    }),
  ]);

  const [internalCheckInsYest, internalCheckOutsYest, guestCheckInsYest, guestCheckOutsYest] = await Promise.all([
    Booking.countDocuments({
      status: { $ne: 'cancelled' },
      checkIn: { $gte: yesterdayStart, $lte: yesterdayEnd },
    }),
    Booking.countDocuments({
      status: { $ne: 'cancelled' },
      checkOut: { $gte: yesterdayStart, $lte: yesterdayEnd },
    }),
    GuestBooking.countDocuments({
      status: { $ne: 'cancelled' },
      checkIn: { $gte: yesterdayStart, $lte: yesterdayEnd },
    }),
    GuestBooking.countDocuments({
      status: { $ne: 'cancelled' },
      checkOut: { $gte: yesterdayStart, $lte: yesterdayEnd },
    }),
  ]);

  const checkInsExpectedTodayCount = internalCheckIns + guestCheckIns;
  const checkOutsExpectedTodayCount = internalCheckOuts + guestCheckOuts;

  // Stock alerts (low stock)
  const lowStock = await Stock.find({
    reorderLevel: { $ne: null },
    $expr: { $lt: ['$quantity', '$reorderLevel'] },
  })
    .select('name category quantity reorderLevel lastRestocked')
    .sort({ reorderLevel: -1 })
    .lean();

  const lowStockCount = lowStock.length;

  // “Cleared since yesterday” (best-effort approximation)
  const pendingToday = checkInsExpectedTodayCount + checkOutsExpectedTodayCount + lowStockCount;
  const pendingYesterday =
    internalCheckInsYest +
    internalCheckOutsYest +
    guestCheckInsYest +
    guestCheckOutsYest +
    lowStockCount;
  const clearedSinceYesterday = Math.max(0, pendingYesterday - pendingToday);

  // Movement rows for today
  const [bookingsToday, guestBookingsToday] = await Promise.all([
    Booking.find({
      status: { $ne: 'cancelled' },
      $or: [
        { checkIn: { $gte: todayStart, $lte: todayEnd } },
        { checkOut: { $gte: todayStart, $lte: todayEnd } },
      ],
    })
      .populate('roomId', 'name type isAvailable')
      .lean(),
    GuestBooking.find({
      status: { $ne: 'cancelled' },
      $or: [
        { checkIn: { $gte: todayStart, $lte: todayEnd } },
        { checkOut: { $gte: todayStart, $lte: todayEnd } },
      ],
    })
      .populate('roomId', 'name type isAvailable')
      .lean(),
  ]);

  const firstCheckInAt = [
    ...bookingsToday.map((b) => b.checkIn).filter(Boolean),
    ...guestBookingsToday.map((g) => g.checkIn).filter(Boolean),
  ].sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0];

  const firstCheckOutAt = [
    ...bookingsToday.map((b) => b.checkOut).filter(Boolean),
    ...guestBookingsToday.map((g) => g.checkOut).filter(Boolean),
  ].sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0];

  const checkInsFirstLabel = firstCheckInAt
    ? new Date(firstCheckInAt).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })
    : null;
  const checkOutsFirstLabel = firstCheckOutAt
    ? new Date(firstCheckOutAt).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })
    : null;

  const movementsToday = [];
  for (const b of bookingsToday) {
    const roomName = b.roomId?.name || '—';
    const guests = 1;
    const isCheckInToday = inUtcRange(b.checkIn, todayStart, todayEnd);
    const isCheckOutToday = inUtcRange(b.checkOut, todayStart, todayEnd);
    movementsToday.push({
      id: `booking:${b._id}`,
      source: 'booking',
      guest: b.guestName,
      room: roomName,
      checkIn: b.checkIn,
      checkOut: b.checkOut,
      guests,
      status:
        b.status === 'confirmed'
          ? 'Confirmed'
          : b.status === 'checked-in'
            ? 'Checked-In'
            : b.status === 'checked-out'
              ? 'Checked-Out'
              : b.status,
      suggestedAction: isCheckInToday ? 'check-in' : isCheckOutToday ? 'check-out' : null,
      detailsHref: `/bookings/${b._id}`,
    });
  }
  for (const g of guestBookingsToday) {
    const roomName = g.roomId?.name || '—';
    const guests = 1;
    const isCheckInToday = inUtcRange(g.checkIn, todayStart, todayEnd);
    const isCheckOutToday = inUtcRange(g.checkOut, todayStart, todayEnd);
    movementsToday.push({
      id: `guestBooking:${g._id}`,
      source: 'guestBooking',
      guest: g.guestName,
      room: roomName,
      checkIn: g.checkIn,
      checkOut: g.checkOut,
      guests,
      status: g.status === 'confirmed' ? 'Confirmed' : g.status ? g.status[0].toUpperCase() + g.status.slice(1) : '—',
      trackingCode: g.trackingCode,
      suggestedAction: isCheckInToday ? 'check-in' : isCheckOutToday ? 'check-out' : null,
      detailsHref: `/guest-bookings/${g._id}`,
    });
  }

  movementsToday.sort((a, b) => {
    const ta = a.checkIn ? new Date(a.checkIn).getTime() : 9e15;
    const tb = b.checkIn ? new Date(b.checkIn).getTime() : 9e15;
    return ta - tb;
  });

  // Room occupancy
  const [roomCounts, occupiedRooms] = await Promise.all([
    (async () => {
      const [totalRooms, maintenanceRooms] = await Promise.all([
        Room.countDocuments(),
        Room.countDocuments({ isAvailable: false }),
      ]);
      return { totalRooms, maintenanceRooms };
    })(),
    (async () => {
      const [occupiedInternal, occupiedGuests] = await Promise.all([
        Booking.find({
          status: { $in: ['confirmed', 'checked-in'] },
          roomId: { $ne: null },
          checkIn: { $lte: todayEnd },
          checkOut: { $gt: todayStart },
        })
          .select('roomId')
          .lean(),
        GuestBooking.find({
          status: 'confirmed',
          roomId: { $ne: null },
          checkIn: { $lte: todayEnd },
          checkOut: { $gt: todayStart },
        })
          .select('roomId')
          .lean(),
      ]);
      const roomIds = new Set([
        ...occupiedInternal.map((r) => String(r.roomId)),
        ...occupiedGuests.map((r) => String(r.roomId)),
      ]);
      return roomIds;
    })(),
  ]);

  const occupiedRoomsCount = occupiedRooms.size;
  const vacantRoomsCount = Math.max(0, roomCounts.totalRooms - occupiedRoomsCount - roomCounts.maintenanceRooms);
  const occupancyPct = roomCounts.totalRooms > 0 ? round2((occupiedRoomsCount / roomCounts.totalRooms) * 100) : 0;
  const monthlyRoomOccupancy = await buildMonthlyRoomOccupancy(monthSpecs);
  const selectedMonthOverall =
    Array.isArray(monthlyRoomOccupancy.overallByMonth) && monthlyRoomOccupancy.overallByMonth.length > 0
      ? monthlyRoomOccupancy.overallByMonth[monthlyRoomOccupancy.overallByMonth.length - 1]
      : null;

  return {
    title: 'Operations dashboard',
    cards: {
      pendingActions: {
        total: pendingToday,
        clearedSinceYesterday,
        checkInsExpectedTodayCount,
        checkOutsExpectedTodayCount,
        stockAlertsCount: lowStockCount,
      },
      checkInsToday: {
        count: checkInsExpectedTodayCount,
        firstAtLabel: checkInsFirstLabel,
      },
      checkOutsToday: {
        count: checkOutsExpectedTodayCount,
        firstAtLabel: checkOutsFirstLabel,
      },
      stockAlerts: {
        count: lowStockCount,
        items: lowStock.slice(0, 4).map((s) => ({
          id: String(s._id),
          name: s.name,
          category: s.category,
          quantity: s.quantity,
          reorderLevel: s.reorderLevel,
        })),
      },
    },
    occupancy: {
      totalRooms: roomCounts.totalRooms,
      occupiedRooms: occupiedRoomsCount,
      vacantRooms: vacantRoomsCount,
      maintenanceRooms: roomCounts.maintenanceRooms,
      occupancyPct,
      occupancyPctToday: occupancyPct,
      selectedMonthOccupancyPct: Number(selectedMonthOverall?.occupancyPct || 0),
      monthlyByRoom: monthlyRoomOccupancy,
    },
    movementsToday,
  };
}

/** @param {number} y @param {number} m 0-11 */
function monthBounds(y, m) {
  const start = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999));
  return { start, end };
}

/** Month-to-date: from 1st through today if viewing current month; else full month. */
function monthToDateRange(y, m, now = new Date()) {
  const { start, end: monthEnd } = monthBounds(y, m);
  if (now.getUTCFullYear() !== y || now.getUTCMonth() !== m) {
    return { start, end: monthEnd, isFullMonth: true };
  }
  const end = new Date(Date.UTC(y, m, now.getUTCDate(), 23, 59, 59, 999));
  return { start, end, isFullMonth: false };
}

/** Same number of days in previous month for MTD comparison (e.g. Mar 1–24 vs Feb 1–24). */
function priorMonthMtdRange(y, m, now = new Date()) {
  const { end } = monthToDateRange(y, m, now);
  const day = end.getUTCDate();
  const pmY = m === 0 ? y - 1 : y;
  const pmM = m === 0 ? 11 : m - 1;
  const lastDayPrev = new Date(Date.UTC(pmY, pmM + 1, 0)).getUTCDate();
  const d = Math.min(day, lastDayPrev);
  const start = new Date(Date.UTC(pmY, pmM, 1, 0, 0, 0, 0));
  const pEnd = new Date(Date.UTC(pmY, pmM, d, 23, 59, 59, 999));
  return { start, end: pEnd };
}

async function sumIncome(start, end) {
  const [r] = await Transaction.aggregate([
    { $match: { type: 'income', date: { $gte: start, $lte: end } } },
    { $group: { _id: null, t: { $sum: '$amount' } } },
  ]);
  return r?.t || 0;
}

/** Revenue used by finance dashboard cards: recognized booking + event income only. */
async function sumRevenue(start, end) {
  const recognized = await recognizedRevenueBreakdown(start, end);
  return recognized.totalRevenue;
}

/** Cash inflow (money received): income transactions recognised on cash basis only. */
async function sumCashIn(start, end) {
  const [r] = await Transaction.aggregate([
    {
      $match: {
        type: 'income',
        date: { $gte: start, $lte: end },
        $or: [{ revenueRecognition: 'cash' }, { revenueRecognition: { $exists: false } }],
      },
    },
    { $group: { _id: null, t: { $sum: '$amount' } } },
  ]);
  return r?.t || 0;
}

async function sumRefunds(start, end) {
  const [r] = await Transaction.aggregate([
    {
      $match: {
        type: 'expense',
        category: 'refund',
        date: { $gte: start, $lte: end },
      },
    },
    { $group: { _id: null, t: { $sum: '$amount' } } },
  ]);
  return r?.t || 0;
}

async function sumExpenseOps(start, end) {
  const [r] = await Transaction.aggregate([
    {
      $match: {
        type: 'expense',
        category: { $ne: 'refund' },
        date: { $gte: start, $lte: end },
      },
    },
    { $group: { _id: null, t: { $sum: '$amount' } } },
  ]);
  return r?.t || 0;
}

async function countPostedJournalLines(start, end) {
  const rows = await JournalEntry.aggregate([
    {
      $match: {
        status: 'POSTED',
        entryDate: { $gte: start, $lte: end },
      },
    },
    { $unwind: '$lines' },
    { $count: 'n' },
  ]);
  return rows[0]?.n || 0;
}

async function debtorAging() {
  const debtors = await Debtor.find({ status: { $in: ['outstanding', 'partial'] } }).lean();
  let total = 0;
  let current = 0;
  let overdue1_30 = 0;
  let overdue31_60 = 0;
  let overdue61plus = 0;
  const today = utcDay(new Date());

  for (const d of debtors) {
    const bal = round2((Number(d.amountOwed) || 0) - (Number(d.amountPaid) || 0));
    if (bal <= 0) continue;
    total += bal;
    if (!d.dueDate) {
      current += bal;
      continue;
    }
    const due = utcDay(d.dueDate);
    const daysPast = Math.floor((today - due) / 86400000);
    if (daysPast <= 0) current += bal;
    else if (daysPast <= 30) overdue1_30 += bal;
    else if (daysPast <= 60) overdue31_60 += bal;
    else overdue61plus += bal;
  }

  return {
    totalBalance: round2(total),
    currentPct: total > 0 ? percent(current, total) : 0,
    buckets: {
      current: round2(current),
      days1_30: round2(overdue1_30),
      days31_60: round2(overdue31_60),
      days61plus: round2(overdue61plus),
    },
  };
}

async function supplierPayablesSnapshot() {
  const match = { type: 'supplier', status: { $in: ['draft', 'sent'] } };
  const [sumRow] = await Invoice.aggregate([
    { $match: match },
    { $group: { _id: null, t: { $sum: '$total' } } },
  ]);
  const now = new Date();
  const soon = new Date(now);
  soon.setUTCDate(soon.getUTCDate() + 60);
  const scheduledCount = await Invoice.countDocuments({
    ...match,
    dueDate: { $gte: now, $lte: soon },
  });
  return { total: round2(sumRow?.t || 0), scheduledPaymentsCount: scheduledCount };
}

function dueLabel(d) {
  if (!d) return '—';
  const day = new Date(d);
  const now = new Date();
  if (sameUtcDay(day, now)) return 'Today';
  const tmr = new Date(now);
  tmr.setUTCDate(tmr.getUTCDate() + 1);
  if (sameUtcDay(day, tmr)) return 'Tomorrow';
  return day.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
}

async function invoicesDueAndRecent(limit = 20) {
  const invoices = await Invoice.find({
    status: { $in: ['draft', 'sent'] },
  })
    .sort({ dueDate: 1, issueDate: -1 })
    .limit(limit)
    .lean();

  const supplierIds = [
    ...new Set(invoices.filter((i) => i.type === 'supplier' && i.relatedTo).map((i) => String(i.relatedTo))),
  ];
  const relIds = [
    ...new Set(invoices.filter((i) => i.type === 'guest' && i.relatedTo).map((i) => String(i.relatedTo))),
  ];

  const [suppliers, bookings, guestBookings] = await Promise.all([
    supplierIds.length ? Supplier.find({ _id: { $in: supplierIds } }).select('name').lean() : [],
    relIds.length ? Booking.find({ _id: { $in: relIds } }).select('guestName type').lean() : [],
    relIds.length ? GuestBooking.find({ _id: { $in: relIds } }).select('guestName trackingCode').lean() : [],
  ]);

  const smap = Object.fromEntries(suppliers.map((s) => [String(s._id), s.name]));
  const bmap = Object.fromEntries(bookings.map((b) => [String(b._id), b]));
  const gbmap = Object.fromEntries(guestBookings.map((g) => [String(g._id), g]));

  return invoices.map((inv) => {
    let party = '—';
    if (inv.type === 'supplier' && inv.relatedTo) {
      party = smap[String(inv.relatedTo)] || 'Supplier';
    } else if (inv.type === 'guest' && inv.relatedTo) {
      const id = String(inv.relatedTo);
      if (bmap[id]) party = bmap[id].guestName;
      else if (gbmap[id]) party = gbmap[id].guestName;
      else party = 'Guest';
    }
    const lineHint = inv.lineItems?.[0]?.description || '';
    return {
      id: String(inv._id),
      source: 'invoice',
      party,
      reference: inv.invoiceNumber || lineHint || '—',
      dueDate: inv.dueDate,
      dueLabel: dueLabel(inv.dueDate),
      amount: round2(Number(inv.total) || 0),
      status: inv.status,
      displayStatus: displayStatusForInvoice(inv.status),
      suggestedAction: suggestedActionForInvoice(inv),
      type: inv.type,
      categoryLabel: inv.type === 'supplier' ? 'Supplier' : inv.type === 'guest' ? 'Guest' : inv.type,
    };
  });
}

function actionVerb(a) {
  const m = { create: 'Created', update: 'Updated', delete: 'Deleted', export: 'Exported', login: 'Login' };
  return m[a] || a;
}

function formatActivity(log) {
  const entity = log.entity || 'Record';
  let detail = '';
  const after = log.after || {};
  if (after.invoiceNumber) detail = after.invoiceNumber;
  else if (after.trackingCode) detail = after.trackingCode;
  else if (after.description && typeof after.description === 'string') detail = after.description.slice(0, 80);
  else if (after.email) detail = after.email;
  return {
    at: log.timestamp,
    action: log.action,
    entity,
    title: `${actionVerb(log.action)} ${entity}`,
    detail: detail || String(log.entityId || '').slice(-8),
  };
}

async function financeActivityToday(limit = 25) {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const importantActions = ['create', 'update', 'delete'];
  const logs = await AuditLog.find({
    timestamp: { $gte: start },
    action: { $in: importantActions },
  })
    .sort({ timestamp: -1 })
    .limit(limit)
    .select('action entity entityId after timestamp')
    .lean();
  return logs.map(formatActivity);
}

async function buildDeadlines(y, m) {
  const monthStr = `${y}-${String(m + 1).padStart(2, '0')}`;
  const monthNameLong = new Date(Date.UTC(y, m, 1)).toLocaleString('en-ZA', { month: 'long' });
  const payrollPending = await Salary.countDocuments({
    month: monthStr,
    paidOn: null,
  });
  const nextWeek = new Date();
  nextWeek.setUTCDate(nextWeek.getUTCDate() + 14);

  const dueInvoices = await Invoice.find({
    status: 'sent',
    dueDate: { $gte: new Date(), $lte: nextWeek },
  })
    .sort({ dueDate: 1 })
    .limit(5)
    .select('invoiceNumber dueDate total type')
    .lean();

  const deadlines = [];

  if (payrollPending > 0) {
    const last = new Date(Date.UTC(y, m + 1, 0));
    const approveBy = new Date(last);
    approveBy.setUTCDate(approveBy.getUTCDate() - 1);
    const dueFmt = last.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
    const apprFmt = approveBy.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
    deadlines.push({
      kind: 'payroll',
      title: `${monthNameLong} payroll run`,
      subtitle: `${dueFmt} · approve by ${apprFmt} · ${payrollPending} record(s) without paid date`,
      dueDate: last.toISOString().slice(0, 10),
      approveBy: approveBy.toISOString().slice(0, 10),
      status: 'ready',
    });
  }

  for (const inv of dueInvoices) {
    deadlines.push({
      kind: 'invoice',
      title: `Invoice ${inv.invoiceNumber || ''}`,
      subtitle: `${inv.type} · R ${round2(inv.total || 0)}`,
      dueDate: inv.dueDate ? new Date(inv.dueDate).toISOString().slice(0, 10) : null,
      status: 'review',
    });
  }

  return deadlines;
}

/** JWT role from protect middleware — only these hit this route via authorize(). */
function dashboardRoleFromRequest(req) {
  const r = String(req.user?.role || '').toLowerCase();
  if (r === 'ceo' || r === 'finance' || r === 'admin') return r;
  return 'finance';
}

/**
 * SPA paths under `/finance` (canonical API base `/api/finance`).
 * `roles` lists who sees each quick link.
 */
function quickLinksForDashboardRole(role) {
  const all = [
    { id: 'transactions', label: 'Transactions', href: '/finance/transactions', roles: ['finance', 'admin', 'ceo'] },
    {
      id: 'debtorsPending',
      label: 'Pending debtors',
      href: '/finance/debtors/pending-bookings',
      roles: ['finance', 'admin', 'ceo'],
    },
    { id: 'chartOfAccounts', label: 'Chart of accounts', href: '/accounting/accounts', roles: ['finance', 'admin'] },
    { id: 'cashFlow', label: 'Cash flow', href: '/finance/cash-flow', roles: ['finance', 'admin', 'ceo'] },
    {
      id: 'incomeStatement',
      label: 'Income statement',
      href: '/finance/income-statement',
      roles: ['finance', 'admin', 'ceo'],
    },
    { id: 'balanceSheet', label: 'Balance sheet', href: '/finance/balance-sheet', roles: ['finance', 'admin', 'ceo'] },
  ];
  return all.filter((x) => x.roles.includes(role)).map(({ id, label, href }) => ({ id, label, href }));
}

/**
 * Role-based dashboard: same aggregates for everyone; CEO gets an executive layout
 * (no raw activity feed, shorter queues, smaller movements list).
 * @param {Record<string, unknown>} payload
 * @param {'finance'|'admin'|'ceo'} role
 */
function shapeDashboardPayloadForRole(payload, role) {
  const controlCentre = {
    ...payload.controlCentre,
    quickLinks: quickLinksForDashboardRole(role),
  };
  if (role === 'ceo' && payload.controlCentre?.sectionKeys) {
    controlCentre.sectionKeys = { ...payload.controlCentre.sectionKeys };
    delete controlCentre.sectionKeys.activityToday;
  }

  if (role === 'ceo') {
    const { activityToday: _drop, ...rest } = payload;
    const ops = payload.operationsDashboard
      ? {
          ...payload.operationsDashboard,
          movementsToday: Array.isArray(payload.operationsDashboard.movementsToday)
            ? payload.operationsDashboard.movementsToday.slice(0, 10)
            : [],
        }
      : payload.operationsDashboard;
    return {
      ...rest,
      controlCentre,
      operationsDashboard: ops,
      paymentQueue: Array.isArray(payload.paymentQueue) ? payload.paymentQueue.slice(0, 12) : payload.paymentQueue,
      invoicesDueAndRecent: Array.isArray(payload.invoicesDueAndRecent)
        ? payload.invoicesDueAndRecent.slice(0, 8)
        : payload.invoicesDueAndRecent,
    };
  }

  return { ...payload, controlCentre };
}

function dashboardMeta(role, shaped) {
  const layout = role === 'ceo' ? 'executive' : 'operations';
  const sectionCatalog = [
    { key: 'controlCentre', label: 'Control centre', roles: ['finance', 'admin', 'ceo'] },
    { key: 'operationsDashboard', label: 'Operations', roles: ['finance', 'admin', 'ceo'] },
    { key: 'kpis', label: 'KPIs', roles: ['finance', 'admin', 'ceo'] },
    { key: 'period', label: 'Period', roles: ['finance', 'admin', 'ceo'] },
    { key: 'ledgerActivity', label: 'Ledger activity', roles: ['finance', 'admin', 'ceo'] },
    { key: 'collections', label: 'Collections', roles: ['finance', 'admin', 'ceo'] },
    { key: 'debtors', label: 'Debtor aging', roles: ['finance', 'admin', 'ceo'] },
    { key: 'supplierPayables', label: 'Supplier payables', roles: ['finance', 'admin', 'ceo'] },
    { key: 'revenueReceiptsMonthly', label: 'Revenue trend', roles: ['finance', 'admin', 'ceo'] },
    { key: 'revenueMonthly', label: 'Revenue monthly', roles: ['finance', 'admin', 'ceo'] },
    { key: 'cashflowMonthly', label: 'Cashflow monthly', roles: ['finance', 'admin', 'ceo'] },
    { key: 'ledgerSnapshot', label: 'Ledger snapshot', roles: ['finance', 'admin', 'ceo'] },
    { key: 'invoicesDueAndRecent', label: 'Invoices due / recent', roles: ['finance', 'admin', 'ceo'] },
    { key: 'paymentQueue', label: 'Payment queue', roles: ['finance', 'admin', 'ceo'] },
    { key: 'activityToday', label: "Today's activity", roles: ['finance', 'admin'] },
    { key: 'deadlines', label: 'Deadlines', roles: ['finance', 'admin', 'ceo'] },
  ];
  const modules = sectionCatalog.map((m) => ({
    key: m.key,
    label: m.label,
    visible: m.roles.includes(role),
  }));
  return {
    role,
    layout,
    primaryAppBase: '/finance',
    /** Call these REST bases from the finance dashboard — do not use `/api/admin/*` for finance data. */
    api: {
      useAdminPrefix: false,
      bases: {
        finance: '/api/finance',
        statements: '/api/statements',
        accounting: '/api/accounting',
        accountingV3: '/api/accounting/v3',
        debtors: '/api/finance/debtors',
        suppliers: '/api/finance/suppliers',
        invoices: '/api/finance/invoices',
        refunds: '/api/finance/refunds',
      },
    },
    modules,
    sectionKeysInResponse: Object.keys(shaped),
  };
}

/**
 * GET /api/finance/dashboard
 * Query: month=YYYY-MM (default current UTC month), revenueMonths=6|12
 */
const getDashboard = asyncHandler(async (req, res) => {
  const now = new Date();
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth();
  if (req.query.month && /^\d{4}-\d{2}$/.test(String(req.query.month).trim())) {
    const [yy, mm] = String(req.query.month).trim().split('-');
    y = parseInt(yy, 10);
    m = parseInt(mm, 10) - 1;
  }

  const revenueWindow = Math.min(12, Math.max(6, parseInt(req.query.revenueMonths, 10) || 6));

  const { start: mtdStart, end: mtdEnd, isFullMonth } = monthToDateRange(y, m, now);
  const { start: priorMtdStart, end: priorMtdEnd } = priorMonthMtdRange(y, m, now);
  const { start: monthStart, end: monthEnd } = monthBounds(y, m);

  const pmY = m === 0 ? y - 1 : y;
  const pmM = m === 0 ? 11 : m - 1;
  const { start: prevMonthStart, end: prevMonthEnd } = monthBounds(pmY, pmM);

  const dueSoonEnd = new Date();
  dueSoonEnd.setUTCDate(dueSoonEnd.getUTCDate() + 14);

  const [
    postedLinesMtd,
    postedLinesPriorMtd,
    postedLinesFullPrior,
    collectionsMtd,
    collectionsPriorMtd,
    collectionsFullPriorMonth,
    incomeFullMonth,
    refundsFullMonth,
    expenseFullMonth,
    recognizedRev,
    aging,
    payables,
    invoiceRows,
    activity,
    deadlines,
    expenseMtd,
    expensePriorMtd,
    refundsMtd,
    refundsPriorMtd,
    dueSoonInvoiceCount,
    ledgerMeta,
    invOpenStats,
  ] = await Promise.all([
    countPostedJournalLines(mtdStart, mtdEnd),
    countPostedJournalLines(priorMtdStart, priorMtdEnd),
    countPostedJournalLines(prevMonthStart, prevMonthEnd),
    sumRevenue(mtdStart, mtdEnd),
    sumRevenue(priorMtdStart, priorMtdEnd),
    sumRevenue(prevMonthStart, prevMonthEnd),
    sumIncome(monthStart, monthEnd),
    sumRefunds(monthStart, monthEnd),
    sumExpenseOps(monthStart, monthEnd),
    recognizedRevenueBreakdown(monthStart, monthEnd),
    debtorAging(),
    supplierPayablesSnapshot(),
    invoicesDueAndRecent(20),
    financeActivityToday(25),
    buildDeadlines(y, m),
    sumExpenseOps(mtdStart, mtdEnd),
    sumExpenseOps(priorMtdStart, priorMtdEnd),
    sumRefunds(mtdStart, mtdEnd),
    sumRefunds(priorMtdStart, priorMtdEnd),
    Invoice.countDocuments({
      status: 'sent',
      dueDate: { $gte: new Date(), $lte: dueSoonEnd },
    }),
    latestPostedJournalMeta(),
    invoiceOpenAndDueStats(now),
  ]);

  const monthStrKey = `${y}-${String(m + 1).padStart(2, '0')}`;
  const payrollQueueRow = await buildPayrollQueueRow(monthStrKey, y, m);
  const paymentQueue = mergePaymentQueue(invoiceRows, payrollQueueRow, 25);

  const netRevenueMonth = round2(incomeFullMonth - refundsFullMonth);
  const netProfitMonth = round2(netRevenueMonth - expenseFullMonth);

  /** Last N full calendar months ending at selected month: net receipts (income − refunds), oldest first. */
  const monthSpecs = Array.from({ length: revenueWindow }, (_, i) => {
    const offset = revenueWindow - 1 - i;
    let ty = y;
    let tm = m - offset;
    while (tm < 0) {
      tm += 12;
      ty -= 1;
    }
    return { ty, tm };
  });

  const monthlyReceipts = await Promise.all(
    monthSpecs.map(async ({ ty, tm }) => {
      const { start: ms, end: me } = monthBounds(ty, tm);
      const [inc, ref, exp, cashIn] = await Promise.all([
        sumRevenue(ms, me),
        sumRefunds(ms, me),
        sumExpenseOps(ms, me),
        sumCashIn(ms, me),
      ]);
      // Receipts should mirror revenue (gross collections), not net of refunds.
      const net = round2(inc);
      const label = new Date(Date.UTC(ty, tm, 1)).toLocaleString('en-ZA', { month: 'long' });
      return {
        key: `${ty}-${String(tm + 1).padStart(2, '0')}`,
        year: ty,
        monthIndex: tm + 1,
        label,
        grossIncome: round2(inc),
        cashIn: round2(cashIn),
        refunds: round2(ref),
        expenses: round2(exp),
        netReceipts: net,
      };
    })
  );

  const avgPerMonth =
    monthlyReceipts.length > 0
      ? round2(monthlyReceipts.reduce((s, r) => s + r.netReceipts, 0) / monthlyReceipts.length)
      : 0;

  const thisWindowSum = monthlyReceipts.reduce((s, r) => s + r.netReceipts, 0);
  const priorYearWindowSums = await Promise.all(
    monthlyReceipts.map(async (row) => {
      const { start: ps, end: pe } = monthBounds(row.year - 1, row.monthIndex - 1);
      const [inc, ref] = await Promise.all([sumRevenue(ps, pe), sumRefunds(ps, pe)]);
      return round2(inc);
    })
  );
  const priorYearWindowSum = priorYearWindowSums.reduce((a, b) => a + b, 0);
  const yoyChangePct = pctChange(thisWindowSum, priorYearWindowSum);

  const collectionsChangeVsPriorMtd = pctChange(collectionsMtd, collectionsPriorMtd);
  const expenseChangeVsPriorMtd = pctChange(expenseMtd, expensePriorMtd);
  const postedChangeVsPriorMonth = isFullMonth
    ? pctChange(postedLinesMtd, postedLinesFullPrior)
    : pctChange(postedLinesMtd, postedLinesPriorMtd);

  const monthLabel = new Date(Date.UTC(y, m, 1)).toLocaleString('en-ZA', {
    month: 'long',
    year: 'numeric',
  });

  const netMtd = round2(collectionsMtd - refundsMtd - expenseMtd);
  const bookingTotal = round2(recognizedRev?.bookingRevenue || 0);
  const eventTotal = round2(recognizedRev?.eventRevenue || 0);
  const bookingsNoteParts = [];
  if (bookingTotal > 0) bookingsNoteParts.push(`BnB ${bookingTotal}`);
  if (eventTotal > 0) bookingsNoteParts.push(`events ${eventTotal}`);
  const bookingsNote =
    bookingsNoteParts.length > 0
      ? `${monthLabel}: booking revenue ${bookingsNoteParts.join(' · ')} (ZAR, full month).`
      : null;

  const headline = buildControlHeadline(ledgerMeta, invOpenStats);
  const receiptsMtd = round2(collectionsMtd);
  const postedComparisonNote = isFullMonth
    ? 'Compared to full prior calendar month.'
    : 'Same day-range vs prior month (MTD).';
  const postedLinesOnTrack = postedChangeVsPriorMonth >= 0;

  const controlCentre = {
    title: 'Finance control centre',
    headline,
    ledger: ledgerMeta,
    invoices: invOpenStats,
    /** Replaced per-role in `shapeDashboardPayloadForRole`. */
    quickLinks: [],
    tiles: {
      receiptsMtd,
      openInvoicesCount: invOpenStats.openInvoicesCount,
      dueThisWeekCount: invOpenStats.dueThisWeekCount,
      dueThisWeekAmount: invOpenStats.dueThisWeekAmount,
      postedLinesThisMonth: postedLinesMtd,
      postedLinesVsPriorPct: postedChangeVsPriorMonth,
      postedLinesOnTrack,
      postedLinesComparisonNote: postedComparisonNote,
      collectionsMtd: round2(collectionsMtd),
      collectionsVsPriorPct: collectionsChangeVsPriorMtd,
      debtorsBalance: aging.totalBalance,
      debtorsCurrentPct: aging.currentPct,
      supplierPayables: payables.total,
      supplierScheduledPaymentsCount: payables.scheduledPaymentsCount,
    },
    /** Same payload as root `data.*` — use these string keys to read sibling sections without duplication. */
    sectionKeys: {
      revenueReceiptsMonthly: 'revenueReceiptsMonthly',
      revenueMonthly: 'revenueMonthly',
      cashflowMonthly: 'cashflowMonthly',
      debtorAging: 'debtors',
      ledgerSnapshot: 'ledgerSnapshot',
      paymentQueue: 'paymentQueue',
      activityToday: 'activityToday',
      deadlines: 'deadlines',
    },
    /** Call again with `?revenueMonths=6` or `12` to switch the revenue chart window. */
    revenueChartOptions: { allowedMonths: [6, 12], activeMonths: revenueWindow },
  };

  const operationsDashboard = await buildOperationsDashboard(now, monthSpecs);

  const kpis = {
    currency: 'ZAR',
    periodLabel: monthLabel,
    monthKey: `${y}-${String(m + 1).padStart(2, '0')}`,
    headline,
    receiptsMtd,
    openInvoicesCount: invOpenStats.openInvoicesCount,
    dueThisWeekCount: invOpenStats.dueThisWeekCount,
    dueThisWeekAmount: invOpenStats.dueThisWeekAmount,
    overdueInvoicesCount: invOpenStats.overdueInvoicesCount,
    overdueAmount: invOpenStats.overdueAmount,
    incomeMtd: round2(collectionsMtd),
    priorIncomeMtd: round2(collectionsPriorMtd),
    incomeVsPriorComparablePct: collectionsChangeVsPriorMtd,
    expenseMtd: round2(expenseMtd),
    priorExpenseMtd: round2(expensePriorMtd),
    expenseVsPriorComparablePct: expenseChangeVsPriorMtd,
    refundsMtd: round2(refundsMtd),
    priorRefundsMtd: round2(refundsPriorMtd),
    netMtd,
    debtorsTotal: aging.totalBalance,
    debtorsCurrentPct: aging.currentPct,
    invoicesDue: dueSoonInvoiceCount,
    invoicesDueAndRecentCount: invoiceRows.length,
    supplierPayablesTotal: payables.total,
    supplierScheduledPaymentsCount: payables.scheduledPaymentsCount,
    postedLinesThisMonth: postedLinesMtd,
    postedLinesVsPriorPct: postedChangeVsPriorMonth,
    postedLinesOnTrack,
    bookingsNote,
    activity,
  };

  const role = dashboardRoleFromRequest(req);
  const rawData = {
    /** Finance control centre layout + headline; pair with `sectionKeys` for charts/tables. */
    controlCentre,
    /** Operations dashboard cards (check-ins/outs today, stock alerts, occupancy, movements). */
    operationsDashboard,
    /** Flat KPIs (includes headline + tile numbers). */
    kpis,
    period: {
      monthKey: `${y}-${String(m + 1).padStart(2, '0')}`,
      label: monthLabel,
      monthStart: monthStart.toISOString(),
      monthEnd: monthEnd.toISOString(),
      mtdStart: mtdStart.toISOString(),
      mtdEnd: mtdEnd.toISOString(),
      isFullMonth,
    },
    currency: 'ZAR',
    ledgerActivity: {
      postedLinesThisMonth: postedLinesMtd,
      postedLinesVsComparable: {
        priorValue: isFullMonth ? postedLinesFullPrior : postedLinesPriorMtd,
        changePct: postedChangeVsPriorMonth,
        note: isFullMonth
          ? 'Compared to full prior calendar month.'
          : 'Compared to same day-range in prior month (MTD-style).',
      },
    },
    collections: {
      mtd: round2(collectionsMtd),
      priorComparable: round2(collectionsPriorMtd),
      fullPriorMonth: round2(collectionsFullPriorMonth),
      changePctVsPriorComparable: collectionsChangeVsPriorMtd,
    },
    debtors: aging,
    supplierPayables: payables,
    revenueReceiptsMonthly: {
      windowMonths: revenueWindow,
      months: monthlyReceipts,
      averagePerMonth: avgPerMonth,
      windowTotalNetReceipts: round2(thisWindowSum),
      priorYearSameMonthsTotal: round2(priorYearWindowSum),
      yoyChangePct,
    },
    revenueMonthly: {
      windowMonths: revenueWindow,
      months: monthlyReceipts.map((r) => ({
        key: r.key,
        label: r.label,
        revenue: round2(r.grossIncome || 0),
        expenses: round2(r.expenses || 0),
        net: round2((Number(r.grossIncome) || 0) - (Number(r.expenses) || 0)),
      })),
    },
    cashflowMonthly: {
      windowMonths: revenueWindow,
      months: monthlyReceipts.map((r) => ({
        key: r.key,
        label: r.label,
        cashIn: round2(r.cashIn || 0),
        cashOut: round2((Number(r.refunds) || 0) + (Number(r.expenses) || 0)),
        netCashFlow: round2((Number(r.cashIn) || 0) - ((Number(r.refunds) || 0) + (Number(r.expenses) || 0))),
      })),
    },
    ledgerSnapshot: {
      monthKey: `${y}-${String(m + 1).padStart(2, '0')}`,
      bnbRevenue: bookingTotal,
      eventHire: eventTotal,
      otherIncome: round2(Math.max(0, incomeFullMonth - bookingTotal - eventTotal)),
      totalExpenses: round2(expenseFullMonth),
      refunds: round2(refundsFullMonth),
      netProfit: netProfitMonth,
      netRevenue: netRevenueMonth,
    },
    invoicesDueAndRecent: invoiceRows,
    /** Invoices + payroll row, sorted by due date — “Due & recent” table. */
    paymentQueue,
    activityToday: activity,
    deadlines,
  };

  const data = shapeDashboardPayloadForRole(rawData, role);

  res.json({
    success: true,
    meta: dashboardMeta(role, data),
    data,
  });
});

module.exports = { getDashboard };
