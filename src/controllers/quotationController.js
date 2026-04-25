const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const { marked } = require('marked');
const Quotation = require('../models/Quotation');
const { asyncHandler, getPagination } = require('../utils/helpers');
const logAudit = require('../utils/audit');

const QUOTATION_UPDATE_FIELDS = [
  'quotationNumber',
  'clientName',
  'clientEmail',
  'clientPhone',
  'eventTitle',
  'eventType',
  'eventDate',
  'venue',
  'guestCount',
  'validUntil',
  'currency',
  'lineItems',
  'tax',
  'notes',
  'terms',
  'status',
];

function pickQuotationPayload(body = {}) {
  const normalized = { ...body };

  // Frontend aliases
  if (normalized.guests !== undefined && normalized.guestCount === undefined) {
    normalized.guestCount = normalized.guests;
  }
  if (normalized.quotationDate !== undefined && normalized.eventTitle === undefined && normalized.eventDate === undefined) {
    // Keep quotationDate as metadata in notes if provided without event mapping.
    const qd = String(normalized.quotationDate).trim();
    if (qd) {
      const notePrefix = `Quotation date: ${qd}`;
      normalized.notes = normalized.notes ? `${notePrefix}\n${normalized.notes}` : notePrefix;
    }
  }
  if (Array.isArray(normalized.lineItems)) {
    normalized.lineItems = normalized.lineItems.map((item) => {
      const qty = item.qty ?? item.quantity;
      return {
        description: item.description,
        qty,
        unitPrice: item.unitPrice,
        total: item.total,
      };
    });
  }

  const out = {};
  for (const key of QUOTATION_UPDATE_FIELDS) {
    if (normalized[key] !== undefined) out[key] = normalized[key];
  }
  return out;
}

function formatMoney(n, currency = 'ZAR') {
  const v = Number(n) || 0;
  const localized = new Intl.NumberFormat('en-ZA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v);
  return `${currency} ${localized}`;
}

function getMailFrom() {
  if (process.env.MAIL_FROM) return process.env.MAIL_FROM;
  return process.env.GMAIL_USER || process.env.SMTP_USER || '';
}

function mailConfigured() {
  const appPassword =
    process.env.GMAIL_APP_PASSWORD ||
    process.env.GMAIL_PASSWORD ||
    process.env.GOOGLE_APP_PASSWORD ||
    '';
  return !!(
    (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) ||
    (process.env.GMAIL_USER && String(appPassword).trim())
  );
}

function getTransporter() {
  const appPassword =
    process.env.GMAIL_APP_PASSWORD ||
    process.env.GMAIL_PASSWORD ||
    process.env.GOOGLE_APP_PASSWORD ||
    '';
  if (process.env.GMAIL_USER && String(appPassword).trim()) {
    return nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: {
        user: process.env.GMAIL_USER.trim(),
        pass: String(appPassword).replace(/\s+/g, ''),
      },
    });
  }
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

function buildQuotationPdfBuffer(quotation) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const itemLines =
      Array.isArray(quotation.lineItems) && quotation.lineItems.length
        ? quotation.lineItems
            .map(
              (item, idx) =>
                `${idx + 1}. **${item.description || 'Item'}** — qty ${Number(item.qty) || 0}, unit ${formatMoney(
                  item.unitPrice,
                  quotation.currency
                )}, total ${formatMoney(item.total, quotation.currency)}`
            )
            .join('\n')
        : '- No line items';

    const left = doc.page.margins.left;
    const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const right = left + contentWidth;

    function ensureSpace(minHeight = 24) {
      if (doc.y + minHeight > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
      }
    }

    function h2(title) {
      ensureSpace(22);
      doc.font('Helvetica-Bold').fontSize(16).fillColor('#111827').text(title, left, doc.y, { width: contentWidth });
      doc.moveDown(0.3);
      doc.strokeColor('#e5e7eb').lineWidth(1).moveTo(left, doc.y).lineTo(right, doc.y).stroke();
      doc.moveDown(0.6);
    }

    function bullet(label, value) {
      ensureSpace(16);
      doc.font('Helvetica').fontSize(11).fillColor('#111827').text('•', left, doc.y, { continued: true });
      doc.text(`  ${label}: `, { continued: true });
      doc.font('Helvetica-Bold').text(String(value || '—'));
    }

    const brandGreen = '#1f5f1f';

    function drawCard(x, y, w, h) {
      doc.roundedRect(x, y, w, h, 8).fillAndStroke('#ffffff', '#e5e7eb');
    }

    function labelValue(x, y, label, value) {
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#111827').text(`${label}:`, x, y, { continued: true });
      doc.font('Helvetica').text(` ${value || '—'}`);
    }

    // Brand header
    doc.font('Helvetica-Bold').fontSize(28).fillColor(brandGreen).text('ValleyCroft', left, doc.y, { width: contentWidth });
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#111827').text('Agro-Tourism Event Quotation', left, doc.y + 2, {
      width: contentWidth,
    });
    doc.moveDown(0.8);

    // Green quotation pill
    ensureSpace(38);
    const pillY = doc.y;
    doc.roundedRect(left, pillY, contentWidth, 34, 8).fill(brandGreen);
    doc.fillColor('white').font('Helvetica-Bold').fontSize(13).text(
      `Quotation: ${quotation.quotationNumber || '—'}`,
      left + 12,
      pillY + 10,
      { width: contentWidth - 24 }
    );
    doc.fillColor('black');
    doc.y = pillY + 48;

    // Two detail cards
    ensureSpace(190);
    const cardsTop = doc.y;
    const gap = 12;
    const cardW = (contentWidth - gap) / 2;
    const cardH = 168;

    drawCard(left, cardsTop, cardW, cardH);
    drawCard(left + cardW + gap, cardsTop, cardW, cardH);

    doc.font('Helvetica-Bold').fontSize(14).fillColor('#111827').text('Client Details', left + 12, cardsTop + 12);
    labelValue(left + 12, cardsTop + 40, 'Client', quotation.clientName || '—');
    labelValue(left + 12, cardsTop + 62, 'Email', quotation.clientEmail || '—');
    labelValue(left + 12, cardsTop + 84, 'Phone', quotation.clientPhone || '—');

    doc.font('Helvetica-Bold').fontSize(14).fillColor('#111827').text('Event Details', left + cardW + gap + 12, cardsTop + 12);
    labelValue(left + cardW + gap + 12, cardsTop + 40, 'Event', quotation.eventType || '—');
    labelValue(
      left + cardW + gap + 12,
      cardsTop + 62,
      'Date',
      quotation.eventDate ? new Date(quotation.eventDate).toISOString().slice(0, 10) : '—'
    );
    labelValue(left + cardW + gap + 12, cardsTop + 84, 'Venue', quotation.venue || '—');
    labelValue(left + cardW + gap + 12, cardsTop + 106, 'Guests', Number(quotation.guestCount) || '—');
    labelValue(left + cardW + gap + 12, cardsTop + 128, 'Quoted on', new Date(quotation.createdAt || Date.now()).toISOString().slice(0, 10));
    labelValue(
      left + cardW + gap + 12,
      cardsTop + 150,
      'Valid until',
      quotation.validUntil ? new Date(quotation.validUntil).toISOString().slice(0, 10) : '—'
    );
    doc.y = cardsTop + cardH + 18;

    h2('Line Items');
    ensureSpace(30);
    const headerY = doc.y;
    const colDesc = left + 6;
    const colQty = left + contentWidth * 0.52;
    const colUnit = left + contentWidth * 0.62;
    const colAmt = left + contentWidth * 0.8;
    const amtWidth = right - colAmt - 6;

    doc.rect(left, headerY, contentWidth, 24).fill('#f3f4f6');
    doc.fillColor('#111827').font('Helvetica-Bold').fontSize(11);
    doc.text('Description', colDesc, headerY + 7);
    doc.text('Qty', colQty, headerY + 7);
    doc.text('Unit Price', colUnit, headerY + 7);
    doc.text('Amount', colAmt, headerY + 7, { width: amtWidth, align: 'right' });
    doc.y = headerY + 24;

    const items = Array.isArray(quotation.lineItems) ? quotation.lineItems : [];
    if (!items.length) {
      doc.font('Helvetica').fontSize(10).fillColor('#111827').text('No line items', left + 6, doc.y + 7);
      doc.y += 22;
    } else {
      items.forEach((item) => {
        ensureSpace(24);
        const rowY = doc.y;
        doc.strokeColor('#e5e7eb').lineWidth(1).moveTo(left, rowY).lineTo(right, rowY).stroke();
        doc.font('Helvetica').fontSize(10).fillColor('#111827');
        doc.text(item.description || 'Item', colDesc, rowY + 7, { width: contentWidth * 0.5 });
        doc.text(String(Number(item.qty) || 0), colQty, rowY + 7);
        doc.text(formatMoney(item.unitPrice, quotation.currency), colUnit, rowY + 7, {
          width: colAmt - colUnit - 8,
          align: 'right',
        });
        doc.text(formatMoney(item.total, quotation.currency), colAmt, rowY + 7, {
          width: amtWidth,
          align: 'right',
        });
        doc.y = rowY + 24;
      });
      doc.strokeColor('#e5e7eb').lineWidth(1).moveTo(left, doc.y).lineTo(right, doc.y).stroke();
    }
    doc.moveDown(0.8);

    h2('Totals');
    bullet('Subtotal', formatMoney(quotation.subtotal, quotation.currency));
    bullet('Other charges', formatMoney(quotation.tax, quotation.currency));
    bullet('Total', formatMoney(quotation.total, quotation.currency));
    doc.moveDown(0.4);

    // Notes + Terms cards side-by-side
    ensureSpace(150);
    const bottomTop = doc.y;
    drawCard(left, bottomTop, cardW, 126);
    drawCard(left + cardW + gap, bottomTop, cardW, 126);
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#111827').text('Notes', left + 12, bottomTop + 10);
    doc.font('Helvetica').fontSize(10).fillColor('#111827').text(quotation.notes || '—', left + 12, bottomTop + 34, {
      width: cardW - 24,
    });
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#111827').text('Terms', left + cardW + gap + 12, bottomTop + 10);
    doc.font('Helvetica').fontSize(10).fillColor('#111827').text(quotation.terms || '—', left + cardW + gap + 12, bottomTop + 34, {
      width: cardW - 24,
    });
    doc.y = bottomTop + 136;
    doc.end();
  });
}

const list = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const { skip, limit: lim } = getPagination(page, limit);
  const [data, total] = await Promise.all([
    Quotation.find().sort({ createdAt: -1 }).skip(skip).limit(lim).lean(),
    Quotation.countDocuments(),
  ]);
  res.json({ success: true, data, meta: { page: parseInt(page, 10), limit: lim, total } });
});

const create = asyncHandler(async (req, res) => {
  const payload = pickQuotationPayload(req.body);
  const quotation = await Quotation.create({ ...payload, createdBy: req.user._id });
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'create',
    entity: 'Quotation',
    entityId: quotation._id,
    after: quotation.toObject(),
    req,
  });
  res.status(201).json({ success: true, data: quotation });
});

const update = asyncHandler(async (req, res) => {
  const quotation = await Quotation.findById(req.params.id);
  if (!quotation) return res.status(404).json({ success: false, message: 'Quotation not found' });
  const before = quotation.toObject();
  Object.assign(quotation, pickQuotationPayload(req.body));
  await quotation.save();
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'update',
    entity: 'Quotation',
    entityId: quotation._id,
    before,
    after: quotation.toObject(),
    req,
  });
  res.json({ success: true, data: quotation });
});

const remove = asyncHandler(async (req, res) => {
  const quotation = await Quotation.findById(req.params.id);
  if (!quotation) return res.status(404).json({ success: false, message: 'Quotation not found' });
  const before = quotation.toObject();
  await quotation.deleteOne();
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'delete',
    entity: 'Quotation',
    entityId: req.params.id,
    before,
    req,
  });
  res.json({ success: true, message: 'Quotation removed' });
});

const getPdf = asyncHandler(async (req, res) => {
  const quotation = await Quotation.findById(req.params.id).lean();
  if (!quotation) return res.status(404).json({ success: false, message: 'Quotation not found' });
  const pdfBuffer = await buildQuotationPdfBuffer(quotation);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${quotation.quotationNumber || quotation._id}.pdf"`);
  res.send(pdfBuffer);
});

const sendEmail = asyncHandler(async (req, res) => {
  const quotation = await Quotation.findById(req.params.id);
  if (!quotation) return res.status(404).json({ success: false, message: 'Quotation not found' });
  const to = String(req.body.to || quotation.clientEmail || '').trim();
  if (!to) return res.status(400).json({ success: false, message: 'Recipient email is required' });
  if (!mailConfigured()) {
    return res.status(400).json({ success: false, message: 'Mail is not configured on the server' });
  }
  const pdfBuffer = await buildQuotationPdfBuffer(quotation.toObject());
  const subject = req.body.subject || `Quotation ${quotation.quotationNumber}`;
  const text = req.body.message || `Dear ${quotation.clientName || 'Client'},\n\nPlease find your quotation attached.`;
  const transporter = getTransporter();
  const info = await transporter.sendMail({
    from: getMailFrom(),
    to,
    subject,
    text,
    attachments: [
      {
        filename: `${quotation.quotationNumber || quotation._id}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ],
  });
  if (quotation.status === 'draft') {
    quotation.status = 'sent';
    await quotation.save();
  }
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'update',
    entity: 'Quotation',
    entityId: quotation._id,
    after: { sentTo: to, messageId: info.messageId },
    req,
  });
  res.json({ success: true, data: { to, messageId: info.messageId } });
});

module.exports = {
  list,
  create,
  update,
  remove,
  getPdf,
  sendEmail,
  buildQuotationPdfBuffer,
  mailConfigured,
  getTransporter,
  getMailFrom,
};
