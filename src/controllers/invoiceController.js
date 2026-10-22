const Invoice = require('../models/Invoice');
const Booking = require('../models/Booking');
const GuestBooking = require('../models/GuestBooking');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { asyncHandler, getPagination } = require('../utils/helpers');
const logAudit = require('../utils/audit');
const { sendInvoiceDeliveryNow, normalizeWhatsAppPhone } = require('../services/invoiceNotifyService');
const { guestPayNowPageUrl } = require('../services/payfastService');
const mailTemplates = require('../services/mailTemplates');

const MAIL_LOGO_PATH = path.join(__dirname, '../assets/mail-logo.png');
const FRONTEND_LOGO_CANDIDATES = [
  path.join(__dirname, '../../../valleycroft_frontend/public/Valley Croft Farm.png'),
  path.join(__dirname, '../../../valleycroft_frontend/public/Valley_Croft_Farm-removebg-preview.png'),
];

function resolveMailLogoFile() {
  const fromEnv = String(process.env.MAIL_LOGO_PATH || '').trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  if (fs.existsSync(MAIL_LOGO_PATH)) return MAIL_LOGO_PATH;
  for (const candidate of FRONTEND_LOGO_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function readPngSize(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(24);
    fs.readSync(fd, buf, 0, 24, 0);
    fs.closeSync(fd);
    if (buf[0] !== 0x89 || buf.toString('ascii', 1, 4) !== 'PNG') return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch {
    return null;
  }
}

function formatMoney(n) {
  const v = Number(n);
  const amount = Number.isFinite(v) ? v : 0;
  const localized = new Intl.NumberFormat('en-ZA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
  return `R ${localized}`;
}

function formatPdfDate(value) {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-ZA', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Africa/Johannesburg',
  });
}

function buildInvoicePdfBuffer(invoice, details = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 28, bottom: 28, left: 36, right: 36 },
      info: {
        Title: `Invoice ${invoice.invoiceNumber || ''}`.trim(),
        Author: 'ValleyCroft Farm',
      },
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const contentWidth = right - left;
    const brand = '#1e3d2f';
    const brandSoft = '#e8f0ea';
    const ink = '#1f2937';
    const muted = '#6b7280';
    const line = '#e5e7eb';
    const gap = 8;

    function ensureSpace(minHeight = 20) {
      if (doc.y + minHeight > doc.page.height - doc.page.margins.bottom) doc.addPage();
    }

    function sectionTitle(title) {
      ensureSpace(22);
      const titleY = doc.y;
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(brand).text(String(title).toUpperCase(), left, titleY, {
        width: contentWidth,
        characterSpacing: 0.45,
      });
      const y = titleY + 12;
      doc.strokeColor(brand).lineWidth(1.2).moveTo(left, y).lineTo(left + 32, y).stroke();
      doc.strokeColor(line).lineWidth(0.7).moveTo(left + 38, y).lineTo(right, y).stroke();
      doc.y = y + 6;
    }

    function drawPanel(x, y, w, h) {
      doc.save();
      doc.roundedRect(x, y, w, h, 6).fillAndStroke('#ffffff', line);
      doc.restore();
    }

    function kv(x, y, label, value, width) {
      doc.font('Helvetica').fontSize(7).fillColor(muted).text(String(label).toUpperCase(), x, y, {
        width,
        characterSpacing: 0.25,
      });
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(ink).text(String(value || '—'), x, y + 9, { width });
    }

    const logoFile = resolveMailLogoFile();
    const headerTop = doc.y;
    const logoMaxW = Math.min(240, contentWidth * 0.5);
    const logoMaxH = 72;
    let headerBottom = headerTop;
    if (logoFile) {
      try {
        const natural = readPngSize(logoFile) || { width: 801, height: 272 };
        const scale = Math.min(logoMaxW / natural.width, logoMaxH / natural.height);
        const drawW = Math.round(natural.width * scale);
        const drawH = Math.round(natural.height * scale);
        doc.image(logoFile, left + (contentWidth - drawW) / 2, headerTop, { width: drawW, height: drawH });
        headerBottom = headerTop + drawH;
      } catch (err) {
        console.warn('[invoice pdf] logo embed failed:', err?.message || err);
      }
    }
    doc.font('Helvetica').fontSize(10).fillColor(muted).text('Tax Invoice', left, headerBottom + 2, {
      width: contentWidth,
      align: 'center',
    });
    doc.y = headerBottom + 18;

    const bannerY = doc.y;
    doc.roundedRect(left, bannerY, contentWidth, 28, 5).fill(brand);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#ffffff').text(
      `Invoice ${invoice.invoiceNumber || '—'}`,
      left + 12,
      bannerY + 8,
      { width: contentWidth * 0.55 }
    );
    doc.font('Helvetica').fontSize(9).fillColor('#ffffff').text(
      String(invoice.status || 'draft').toUpperCase(),
      left + contentWidth * 0.55,
      bannerY + 9,
      { width: contentWidth * 0.45 - 12, align: 'right' }
    );
    doc.y = bannerY + 38;

    const panelW = (contentWidth - gap) / 2;
    const panelH = 112;
    const panelsTop = doc.y;
    drawPanel(left, panelsTop, panelW, panelH);
    drawPanel(left + panelW + gap, panelsTop, panelW, panelH);

    doc.font('Helvetica-Bold').fontSize(10).fillColor(brand).text('Bill to', left + 12, panelsTop + 10);
    kv(left + 12, panelsTop + 28, 'Name', details.guestName, panelW - 24);
    kv(left + 12, panelsTop + 54, 'Email', details.guestEmail, panelW - 24);
    kv(left + 12, panelsTop + 80, 'Phone', details.guestPhone, panelW - 24);

    const stayX = left + panelW + gap + 12;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(brand).text('Stay', stayX, panelsTop + 10);
    kv(stayX, panelsTop + 28, 'Room', details.roomName, panelW - 24);
    kv(stayX, panelsTop + 54, 'Check-in', formatPdfDate(details.checkIn), (panelW - 28) / 2);
    kv(stayX + (panelW - 24) * 0.52, panelsTop + 54, 'Check-out', formatPdfDate(details.checkOut), (panelW - 24) * 0.48);
    kv(stayX, panelsTop + 80, 'Issued', formatPdfDate(invoice.issueDate), (panelW - 28) / 2);
    kv(stayX + (panelW - 24) * 0.52, panelsTop + 80, 'Due', formatPdfDate(invoice.dueDate), (panelW - 24) * 0.48);
    doc.y = panelsTop + panelH + 12;

    sectionTitle('Line items');
    const items = Array.isArray(invoice.lineItems) ? invoice.lineItems : [];
    const colDesc = left + 6;
    const colQty = left + contentWidth * 0.54;
    const colUnit = left + contentWidth * 0.66;
    const colAmt = left + contentWidth * 0.82;
    const amtW = right - colAmt - 6;
    const unitW = colAmt - colUnit - 6;
    const descW = colQty - colDesc - 6;

    const headY = doc.y;
    doc.roundedRect(left, headY, contentWidth, 18, 4).fill(brandSoft);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(brand);
    doc.text('Description', colDesc, headY + 5, { width: descW });
    doc.text('Qty', colQty, headY + 5, { width: 36, align: 'right' });
    doc.text('Unit price', colUnit, headY + 5, { width: unitW, align: 'right' });
    doc.text('Amount', colAmt, headY + 5, { width: amtW, align: 'right' });
    doc.y = headY + 20;

    if (!items.length) {
      doc.font('Helvetica').fontSize(9).fillColor(muted).text('No line items', left + 6, doc.y + 4);
      doc.y += 20;
    } else {
      items.forEach((item, idx) => {
        const desc = String(item.description || 'Item');
        const qty = Number(item.qty) || 0;
        const unit = Number(item.unitPrice) || 0;
        const total = Number(item.total != null ? item.total : qty * unit) || 0;
        const descHeight = Math.max(11, doc.heightOfString(desc, { width: descW }));
        const rowH = Math.max(18, descHeight + 6);
        ensureSpace(rowH + 2);
        const rowY = doc.y;
        if (idx % 2 === 1) doc.rect(left, rowY, contentWidth, rowH).fill('#fafaf8');
        doc.font('Helvetica').fontSize(9).fillColor(ink).text(desc, colDesc, rowY + 4, { width: descW });
        doc.text(String(qty), colQty, rowY + 4, { width: 36, align: 'right' });
        doc.text(formatMoney(unit), colUnit, rowY + 4, { width: unitW, align: 'right' });
        doc.font('Helvetica-Bold').text(formatMoney(total), colAmt, rowY + 4, { width: amtW, align: 'right' });
        doc.strokeColor(line).lineWidth(0.5).moveTo(left, rowY + rowH).lineTo(right, rowY + rowH).stroke();
        doc.y = rowY + rowH;
      });
    }

    doc.y += 8;
    const totalsH = 62;
    const totalsW = Math.min(210, contentWidth * 0.42);
    const totalsX = right - totalsW;
    const totalsTop = doc.y;
    drawPanel(totalsX, totalsTop, totalsW, totalsH);
    doc.font('Helvetica').fontSize(9).fillColor(muted).text('Subtotal', totalsX + 12, totalsTop + 10);
    doc.font('Helvetica').fontSize(9).fillColor(ink).text(formatMoney(invoice.subtotal), totalsX + 12, totalsTop + 10, {
      width: totalsW - 24,
      align: 'right',
    });
    doc.font('Helvetica').fontSize(9).fillColor(muted).text('Tax', totalsX + 12, totalsTop + 26);
    doc.font('Helvetica').fontSize(9).fillColor(ink).text(formatMoney(invoice.tax), totalsX + 12, totalsTop + 26, {
      width: totalsW - 24,
      align: 'right',
    });
    doc.font('Helvetica-Bold').fontSize(11).fillColor(brand).text('Total', totalsX + 12, totalsTop + 42);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(brand).text(formatMoney(invoice.total), totalsX + 12, totalsTop + 42, {
      width: totalsW - 24,
      align: 'right',
    });
    doc.y = totalsTop + totalsH + 12;

    const notes = String(invoice.notes || '').trim();
    if (notes) {
      sectionTitle('Notes');
      doc.font('Helvetica').fontSize(9).fillColor(ink).text(notes, left, doc.y, { width: contentWidth, lineGap: 1.5 });
      doc.moveDown(0.6);
    }

    const bank = typeof mailTemplates.bookingBankDetails === 'function'
      ? mailTemplates.bookingBankDetails()
      : { bankName: 'FNB', branchCode: '250655', accountNumber: '63157115148', accountName: 'Ngimu Agriculture' };
    sectionTitle('Banking details');
    const bankTop = doc.y;
    const bankColW = (contentWidth - 24) / 4;
    drawPanel(left, bankTop, contentWidth, 48);
    kv(left + 12, bankTop + 10, 'Bank', bank.bankName || 'FNB', bankColW - 8);
    kv(left + 12 + bankColW, bankTop + 10, 'Branch code', bank.branchCode || '250655', bankColW - 8);
    kv(left + 12 + bankColW * 2, bankTop + 10, 'Account number', bank.accountNumber || '63157115148', bankColW - 8);
    kv(left + 12 + bankColW * 3, bankTop + 10, 'Account name', bank.accountName || 'Ngimu Agriculture', bankColW - 8);
    doc.y = bankTop + 58;

    const footY = doc.y;
    doc.strokeColor(line).lineWidth(0.7).moveTo(left, footY).lineTo(right, footY).stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor(muted).text(
      `ValleyCroft Farm · Invoice ${invoice.invoiceNumber || ''} · ${formatPdfDate(new Date())}`,
      left,
      footY + 6,
      { width: contentWidth, align: 'center' }
    );
    doc.end();
  });
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
    checkIn: rel.checkIn || null,
    checkOut: rel.checkOut || null,
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
  const pdfBuffer = await buildInvoicePdfBuffer(invoice, details);
  const filename = `${(invoice.invoiceNumber || String(invoice._id)).replace(/[^\w\-]/g, '_')}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(pdfBuffer);
});

const sendInvoice = asyncHandler(async (req, res) => {
  const invoice = await Invoice.findById(req.params.id).lean();
  if (!invoice) return res.status(404).json({ success: false, message: 'Invoice not found' });
  const details = await loadInvoiceContacts(invoice);
  const linkedInternalBooking =
    invoice.relatedTo &&
    (await Booking.findById(invoice.relatedTo).select('_id').lean());
  if (linkedInternalBooking) {
    return res.status(400).json({
      success: false,
      message:
        'Invoices for staff/internal bookings are not sent to guests. Admin is notified when the booking is created.',
    });
  }
  const channels = Array.isArray(req.body.channels) ? req.body.channels : ['email', 'whatsapp'];
  const stayTotal = Number(invoice.total) || 0;
  const payload = {
    guestName: req.body.guestName || details.guestName || 'Guest',
    email: req.body.email || details.guestEmail || '',
    phone: req.body.phone || details.guestPhone || '',
    invoiceNumber: invoice.invoiceNumber,
    total: stayTotal,
    deposit: stayTotal,
    balanceDue: 0,
    notes: invoice.notes,
    dueDate: invoice.dueDate,
    lineItems: invoice.lineItems || [],
    trackingCode: details.trackingCode || undefined,
    checkIn: details.checkIn || undefined,
    checkOut: details.checkOut || undefined,
    payNowUrl: guestPayNowPageUrl(
      req.body.email || details.guestEmail,
      details.trackingCode,
    ),
    relatedModel: 'GuestBooking',
    relatedId: invoice.relatedTo,
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
