/**
 * Creates guest-type Invoice documents when a booking is confirmed (after debtor + journal).
 */
const Invoice = require('../models/Invoice');
const Debtor = require('../models/Debtor');
const Room = require('../models/Room');

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function formatMoney(n) {
  const v = Number(n) || 0;
  return `R ${v.toFixed(2)}`;
}

async function guestLinePayload(gb) {
  const total = Number(gb.totalAmount) || 0;
  const deposit = Math.min(Number(gb.deposit) || 0, total);
  let label = 'Accommodation';
  if (gb.roomId) {
    const room = await Room.findById(gb.roomId).select('name').lean();
    if (room?.name) label = room.name;
  }
  if (gb.checkIn && gb.checkOut) {
    const ci = new Date(gb.checkIn).toISOString().slice(0, 10);
    const co = new Date(gb.checkOut).toISOString().slice(0, 10);
    label += ` (${ci} – ${co})`;
  }
  const balanceDue = total - deposit;
  return {
    lineItems: [{ description: label, qty: 1, unitPrice: total, total }],
    subtotal: total,
    tax: 0,
    total,
    deposit,
    balanceDue,
    notes: `Booking ref: ${gb.trackingCode}. Deposit received: ${formatMoney(deposit)}. Balance due: ${formatMoney(balanceDue)}.`,
  };
}

async function internalLinePayload(b) {
  const total = Number(b.amount) || 0;
  const deposit = Math.min(Number(b.deposit) || 0, total);
  let label = b.type === 'event' ? 'Event booking' : 'Stay';
  if (b.type === 'bnb' && b.roomId) {
    const room = await Room.findById(b.roomId).select('name').lean();
    if (room?.name) label = room.name;
  }
  if (b.type === 'event' && b.eventDate) {
    label += ` — ${new Date(b.eventDate).toISOString().slice(0, 10)}`;
  } else if (b.checkIn && b.checkOut) {
    const ci = new Date(b.checkIn).toISOString().slice(0, 10);
    const co = new Date(b.checkOut).toISOString().slice(0, 10);
    label += ` (${ci} – ${co})`;
  }
  const balanceDue = total - deposit;
  return {
    lineItems: [{ description: label, qty: 1, unitPrice: total, total }],
    subtotal: total,
    tax: 0,
    total,
    deposit,
    balanceDue,
    notes: `Deposit received: ${formatMoney(deposit)}. Balance due: ${formatMoney(balanceDue)}.`,
  };
}

/**
 * @param {import('mongoose').Document} gb
 * @param {import('mongoose').Document} debtor
 */
async function createInvoiceForConfirmedGuestBooking(gb, debtor, userId) {
  const payload = await guestLinePayload(gb);
  const issueDate = new Date();
  const invoice = await Invoice.create({
    type: 'guest',
    relatedTo: gb._id,
    issueDate,
    dueDate: addDays(issueDate, 14),
    lineItems: payload.lineItems,
    subtotal: payload.subtotal,
    tax: payload.tax,
    total: payload.total,
    status: 'sent',
    notes: payload.notes,
    createdBy: userId,
  });
  await Debtor.findByIdAndUpdate(debtor._id, { invoiceRef: invoice._id });
  return invoice;
}

/**
 * @param {import('mongoose').Document} b
 * @param {import('mongoose').Document} debtor
 */
async function createInvoiceForConfirmedInternalBooking(b, debtor, userId) {
  const payload = await internalLinePayload(b);
  const issueDate = new Date();
  const invoice = await Invoice.create({
    type: 'guest',
    relatedTo: b._id,
    issueDate,
    dueDate: addDays(issueDate, 14),
    lineItems: payload.lineItems,
    subtotal: payload.subtotal,
    tax: payload.tax,
    total: payload.total,
    status: 'sent',
    notes: payload.notes,
    createdBy: userId,
  });
  await Debtor.findByIdAndUpdate(debtor._id, { invoiceRef: invoice._id });
  return invoice;
}

module.exports = {
  createInvoiceForConfirmedGuestBooking,
  createInvoiceForConfirmedInternalBooking,
  formatMoney,
};
