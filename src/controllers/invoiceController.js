const Invoice = require('../models/Invoice');
const Booking = require('../models/Booking');
const GuestBooking = require('../models/GuestBooking');
const PDFDocument = require('pdfkit');
const { asyncHandler, getPagination } = require('../utils/helpers');
const logAudit = require('../utils/audit');
const { sendInvoiceDeliveryNow, normalizeWhatsAppPhone } = require('../services/invoiceNotifyService');

function formatMoney(n) {
  const v = Number(n) || 0;
  return `R ${v.toFixed(2)}`;
}

async function loadInvoiceContacts(invoice) {
  const relatedId = invoice.relatedTo;
  if (!relatedId) return {};
  const [guestBooking, booking] = await Promise.all([
    GuestBooking.findById(relatedId).populate('roomId', 'name type').lean(),
    Booking.findById(relatedId).populate('roomId', 'name type').lean(),
  ]);
  const rel = guestBooking || booking;
  if (!rel) return {};
  return {
    guestName: rel.guestName || null,
    guestEmail: rel.guestEmail || null,
    guestPhone: rel.guestPhone || null,
    roomName: rel.roomId?.name || null,
    roomType: rel.roomId?.type || null,
    trackingCode: rel.trackingCode || null,
  };
}

async function enrichInvoices(rows) {
  const out = [];
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const details = await loadInvoiceContacts(row);
    out.push({ ...row, ...details });
  }
  return out;
}
const INVOICE_UPDATE_FIELDS = [
  'type',
  'relatedTo',
  'issueDate',
  'dueDate',
  'lineItems',
  'subtotal',
  'tax',
  'total',
  'status',
  'notes',
];

function pickInvoiceUpdates(body = {}) {
  const out = {};
  for (const key of INVOICE_UPDATE_FIELDS) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
}

const list = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const { skip, limit: lim } = getPagination(page, limit);
  const [data, total] = await Promise.all([
    Invoice.find().sort({ issueDate: -1 }).skip(skip).limit(lim).lean(),
    Invoice.countDocuments(),
  ]);
  res.json({ success: true, data: await enrichInvoices(data), meta: { page: parseInt(page, 10), limit: lim, total } });
});

const create = asyncHandler(async (req, res) => {
  const invoice = await Invoice.create({ ...req.body, createdBy: req.user._id });
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'create',
    entity: 'Invoice',
    entityId: invoice._id,
    after: invoice.toObject(),
    req,
  });
  res.status(201).json({ success: true, data: invoice });
});

const update = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findById(req.params.id);
  if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });
  const before = invoice.toObject();
  Object.assign(invoice, pickInvoiceUpdates(req.body));
  await invoice.save();
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'update',
    entity: 'Invoice',
    entityId: invoice._id,
    before,
    after: invoice.toObject(),
    req,
  });
  res.json({ success: true, data: invoice });
});

const getPdf = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findById(req.params.id).lean();
  if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });
  const details = await loadInvoiceContacts(invoice);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${(invoice.invoiceNumber || String(invoice._id)).replace(/[^\w\-]/g, '_')}.pdf"`
  );
  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);
  doc.fontSize(18).text(`Invoice ${invoice.invoiceNumber || ''}`, { align: 'left' });
  doc.moveDown(0.5);
  doc.fontSize(11).text(`Guest: ${details.guestName || '—'}`);
  doc.text(`Room: ${details.roomName || '—'} (${details.roomType || '—'})`);
  doc.text(`Issue Date: ${invoice.issueDate ? new Date(invoice.issueDate).toISOString().slice(0, 10) : '—'}`);
  doc.text(`Due Date: ${invoice.dueDate ? new Date(invoice.dueDate).toISOString().slice(0, 10) : '—'}`);
  doc.text(`Status: ${invoice.status || '—'}`);
  doc.moveDown(1);
  doc.fontSize(12).text('Line items');
  doc.moveDown(0.3);
  if (Array.isArray(invoice.lineItems) && invoice.lineItems.length) {
    invoice.lineItems.forEach((it, i) => {
      doc
        .fontSize(10)
        .text(
          `${i + 1}. ${it.description || 'Item'} | qty ${Number(it.qty) || 0} | unit ${formatMoney(it.unitPrice)} | total ${formatMoney(it.total)}`
        );
    });
  } else {
    doc.fontSize(10).text('No line items');
  }
  doc.moveDown(1);
  doc.fontSize(11).text(`Subtotal: ${formatMoney(invoice.subtotal)}`);
  doc.text(`Tax: ${formatMoney(invoice.tax)}`);
  doc.text(`Total: ${formatMoney(invoice.total)}`);
  doc.moveDown(0.7);
  doc.fontSize(10).text(`Notes: ${invoice.notes || '—'}`);
  doc.end();
});

const sendInvoice = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findById(req.params.id).lean();
  if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });
  const details = await loadInvoiceContacts(invoice);
  const channels = Array.isArray(req.body.channels) ? req.body.channels : ['email', 'whatsapp'];
  const payload = {
    guestName: req.body.guestName || details.guestName || 'Guest',
    email: req.body.email || details.guestEmail || '',
    phone: req.body.phone || details.guestPhone || '',
    invoiceNumber: invoice.invoiceNumber,
    total: invoice.total,
    notes: invoice.notes,
    dueDate: invoice.dueDate,
    lineItems: invoice.lineItems || [],
    trackingCode: details.trackingCode || undefined,
  };
  const results = await sendInvoiceDeliveryNow(payload, { channels });
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'update',
    entity: 'Invoice',
    entityId: invoice._id,
    after: { delivery: results, channels },
    req,
  });
  res.json({ success: true, data: { invoiceId: invoice._id, channels, results } });
});

const getWhatsAppShareLink = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findById(req.params.id).lean();
  if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });
  const details = await loadInvoiceContacts(invoice);
  const rawPhone = String(req.query.phone || details.guestPhone || '').trim();
  const phone = normalizeWhatsAppPhone(rawPhone) || null;
  const text = encodeURIComponent(
    `Hi ${details.guestName || 'Guest'}, invoice ${invoice.invoiceNumber} is ready. Total ${formatMoney(invoice.total)}.`
  );
  const link = phone ? `https://wa.me/${phone}?text=${text}` : `https://wa.me/?text=${text}`;
  res.json({ success: true, data: { phone, link } });
});

module.exports = { list, create, update, getPdf, sendInvoice, getWhatsAppShareLink };
