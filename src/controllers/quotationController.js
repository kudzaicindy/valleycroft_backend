const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const Quotation = require('../models/Quotation');
const { asyncHandler, getPagination } = require('../utils/helpers');
const logAudit = require('../utils/audit');
const invoiceNotify = require('../services/invoiceNotifyService');
const mailTemplates = require('../services/mailTemplates');

const MAIL_LOGO_CID = 'valleycroft-logo';
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

  // Coerce date strings from the admin form
  for (const key of ['eventDate', 'validUntil']) {
    if (normalized[key] !== undefined && normalized[key] !== null && normalized[key] !== '') {
      const d = new Date(normalized[key]);
      if (!Number.isNaN(d.getTime())) normalized[key] = d;
    }
  }

  if (normalized.venue !== undefined) {
    normalized.venue = String(normalized.venue || '').trim();
  }

  const out = {};
  for (const key of QUOTATION_UPDATE_FIELDS) {
    if (normalized[key] !== undefined) out[key] = normalized[key];
  }
  return out;
}

function formatMoney(n) {
  const v = Number(n) || 0;
  const localized = new Intl.NumberFormat('en-ZA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v);
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

function getMailFrom() {
  if (process.env.MAIL_FROM) return process.env.MAIL_FROM;
  return process.env.GMAIL_USER || process.env.SMTP_USER || '';
}

function mailConfigured() {
  return invoiceNotify.mailConfigured();
}

function buildQuotationPdfBuffer(quotation) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 36,
      info: {
        Title: `Quotation ${quotation.quotationNumber || ''}`.trim(),
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
    const gap = 10;

    function ensureSpace(minHeight = 24) {
      if (doc.y + minHeight > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
      }
    }

    function sectionTitle(title) {
      ensureSpace(26);
      const titleY = doc.y;
      doc.font('Helvetica-Bold').fontSize(10).fillColor(brand).text(String(title).toUpperCase(), left, titleY, {
        width: contentWidth,
        characterSpacing: 0.5,
      });
      const y = titleY + 14;
      doc.strokeColor(brand).lineWidth(1.25).moveTo(left, y).lineTo(left + 36, y).stroke();
      doc.strokeColor(line).lineWidth(0.8).moveTo(left + 42, y).lineTo(right, y).stroke();
      doc.y = y + 8;
    }

    function drawPanel(x, y, w, h) {
      doc.save();
      doc.roundedRect(x, y, w, h, 8).fillAndStroke('#ffffff', line);
      doc.restore();
    }

    function kv(x, y, label, value, width) {
      doc.font('Helvetica').fontSize(7.5).fillColor(muted).text(String(label).toUpperCase(), x, y, {
        width,
        characterSpacing: 0.3,
      });
      doc.font('Helvetica-Bold').fontSize(10).fillColor(ink).text(String(value || '—'), x, y + 10, {
        width,
      });
    }

    // ── Header (centered logo + subtitle) ───────────────────
    const logoFile = resolveMailLogoFile();
    const headerTop = doc.y;
    const logoSize = 96;
    let headerBottom = headerTop;

    if (logoFile) {
      try {
        const logoX = left + (contentWidth - logoSize) / 2;
        doc.image(logoFile, logoX, headerTop, { fit: [logoSize, logoSize], align: 'center', valign: 'center' });
        headerBottom = headerTop + logoSize;
      } catch (err) {
        console.warn('[quotation pdf] logo embed failed:', err?.message || err);
      }
    }

    doc.font('Helvetica').fontSize(10).fillColor(muted).text(
      'Agro-Tourism Event Quotation',
      left,
      headerBottom + 4,
      { width: contentWidth, align: 'center' }
    );
    doc.y = headerBottom + 20;

    // Quote number banner
    ensureSpace(34);
    const bannerY = doc.y;
    doc.roundedRect(left, bannerY, contentWidth, 30, 6).fill(brand);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#ffffff').text(
      `Quotation ${quotation.quotationNumber || '—'}`,
      left + 12,
      bannerY + 9,
      { width: contentWidth * 0.55 }
    );
    doc.font('Helvetica').fontSize(9).fillColor('rgba(255,255,255,0.92)').text(
      `Valid until ${formatPdfDate(quotation.validUntil)}`,
      left + contentWidth * 0.55,
      bannerY + 10,
      { width: contentWidth * 0.45 - 12, align: 'right' }
    );
    doc.y = bannerY + 40;

    // ── Client / Event panels ────────────────────────────────
    ensureSpace(118);
    const panelsTop = doc.y;
    const panelW = (contentWidth - gap) / 2;
    const panelH = 112;
    drawPanel(left, panelsTop, panelW, panelH);
    drawPanel(left + panelW + gap, panelsTop, panelW, panelH);

    doc.font('Helvetica-Bold').fontSize(10).fillColor(brand).text('Client', left + 12, panelsTop + 10);
    kv(left + 12, panelsTop + 26, 'Name', quotation.clientName, panelW - 24);
    kv(left + 12, panelsTop + 52, 'Email', quotation.clientEmail, panelW - 24);
    kv(left + 12, panelsTop + 78, 'Phone', quotation.clientPhone, panelW - 24);

    const eventX = left + panelW + gap + 12;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(brand).text('Event', eventX, panelsTop + 10);
    kv(eventX, panelsTop + 26, 'Type', quotation.eventType || quotation.eventTitle, panelW - 24);
    kv(eventX, panelsTop + 52, 'Date', formatPdfDate(quotation.eventDate), (panelW - 28) / 2);
    kv(
      eventX + (panelW - 24) * 0.52,
      panelsTop + 52,
      'Guests',
      quotation.guestCount != null && quotation.guestCount !== '' ? String(quotation.guestCount) : '—',
      (panelW - 24) * 0.48
    );
    kv(eventX, panelsTop + 78, 'Venue', quotation.venue, panelW - 24);
    doc.y = panelsTop + panelH + 12;

    // ── Line items ──────────────────────────────────────────
    sectionTitle('Line items');
    const items = Array.isArray(quotation.lineItems) ? quotation.lineItems : [];
    const colDesc = left + 8;
    const colQty = left + contentWidth * 0.54;
    const colUnit = left + contentWidth * 0.64;
    const colAmt = left + contentWidth * 0.78;
    const amtW = right - colAmt - 8;
    const unitW = colAmt - colUnit - 6;
    const descW = colQty - colDesc - 6;

    ensureSpace(22);
    const headY = doc.y;
    doc.roundedRect(left, headY, contentWidth, 22, 4).fill(brandSoft);
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(brand);
    doc.text('Description', colDesc, headY + 6, { width: descW });
    doc.text('Qty', colQty, headY + 6, { width: 36, align: 'right' });
    doc.text('Unit price', colUnit, headY + 6, { width: unitW, align: 'right' });
    doc.text('Amount', colAmt, headY + 6, { width: amtW, align: 'right' });
    doc.y = headY + 24;

    if (!items.length) {
      ensureSpace(22);
      doc.font('Helvetica').fontSize(9).fillColor(muted).text('No line items', left + 8, doc.y + 4);
      doc.y += 22;
    } else {
      items.forEach((item, idx) => {
        const desc = String(item.description || 'Item');
        const qty = Number(item.qty) || 0;
        const unit = Number(item.unitPrice) || 0;
        const total = Number(item.total != null ? item.total : qty * unit) || 0;
        const descHeight = Math.max(
          12,
          doc.heightOfString(desc, { width: descW, font: 'Helvetica', fontSize: 9.5 })
        );
        const rowH = Math.max(22, descHeight + 8);
        ensureSpace(rowH + 2);
        const rowY = doc.y;
        if (idx % 2 === 1) {
          doc.rect(left, rowY, contentWidth, rowH).fill('#fafaf8');
        }
        doc.font('Helvetica').fontSize(9.5).fillColor(ink).text(desc, colDesc, rowY + 5, { width: descW });
        doc.text(String(qty), colQty, rowY + 5, { width: 36, align: 'right' });
        doc.text(formatMoney(unit), colUnit, rowY + 5, { width: unitW, align: 'right' });
        doc.font('Helvetica-Bold').text(formatMoney(total), colAmt, rowY + 5, { width: amtW, align: 'right' });
        doc.strokeColor(line).lineWidth(0.6).moveTo(left, rowY + rowH).lineTo(right, rowY + rowH).stroke();
        doc.y = rowY + rowH;
      });
    }

    doc.y += 8;

    // ── Totals ──────────────────────────────────────────────
    const hasTax = Number(quotation.tax) > 0;
    const totalsH = hasTax ? 68 : 52;
    ensureSpace(totalsH + 8);
    const totalsW = Math.min(220, contentWidth * 0.42);
    const totalsX = right - totalsW;
    const totalsTop = doc.y;
    drawPanel(totalsX, totalsTop, totalsW, totalsH);
    doc.font('Helvetica').fontSize(9).fillColor(muted).text('Subtotal', totalsX + 12, totalsTop + 12);
    doc.font('Helvetica').fontSize(9).fillColor(ink).text(formatMoney(quotation.subtotal), totalsX + 12, totalsTop + 12, {
      width: totalsW - 24,
      align: 'right',
    });
    if (hasTax) {
      doc.font('Helvetica').fontSize(9).fillColor(muted).text('Other charges', totalsX + 12, totalsTop + 28);
      doc.font('Helvetica').fontSize(9).fillColor(ink).text(formatMoney(quotation.tax), totalsX + 12, totalsTop + 28, {
        width: totalsW - 24,
        align: 'right',
      });
    }
    const totalY = hasTax ? totalsTop + 46 : totalsTop + 30;
    doc.font('Helvetica-Bold').fontSize(11).fillColor(brand).text('Total', totalsX + 12, totalY);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(brand).text(formatMoney(quotation.total), totalsX + 12, totalY, {
      width: totalsW - 24,
      align: 'right',
    });
    doc.y = totalsTop + totalsH + 12;

    // ── Notes & terms ───────────────────────────────────────
    const notes = String(quotation.notes || '').trim();
    const terms = String(quotation.terms || '').trim();
    if (notes || terms) {
      sectionTitle('Notes & terms');
      if (notes) {
        ensureSpace(36);
        doc.font('Helvetica-Bold').fontSize(9).fillColor(ink).text('Notes', left, doc.y);
        doc.moveDown(0.2);
        doc.font('Helvetica').fontSize(9).fillColor(ink).text(notes, left, doc.y, { width: contentWidth, lineGap: 1.5 });
        doc.moveDown(0.45);
      }
      if (terms) {
        ensureSpace(36);
        doc.font('Helvetica-Bold').fontSize(9).fillColor(ink).text('Terms', left, doc.y);
        doc.moveDown(0.2);
        doc.font('Helvetica').fontSize(9).fillColor(ink).text(terms, left, doc.y, { width: contentWidth, lineGap: 1.5 });
        doc.moveDown(0.35);
      }
    }

    // Footer — sit under content (not pinned to page bottom)
    ensureSpace(28);
    doc.y += 6;
    const footY = doc.y;
    doc.strokeColor(line).lineWidth(0.8).moveTo(left, footY).lineTo(right, footY).stroke();
    doc.font('Helvetica').fontSize(8).fillColor(muted).text(
      `ValleyCroft Farm · Quotation ${quotation.quotationNumber || ''} · Prepared ${formatPdfDate(quotation.createdAt || new Date())}`,
      left,
      footY + 6,
      { width: contentWidth, align: 'center' }
    );

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
  const to = String(req.body.to || req.body.email || quotation.clientEmail || '').trim();
  if (!to) return res.status(400).json({ success: false, message: 'Recipient email is required' });
  if (!mailConfigured()) {
    return res.status(400).json({ success: false, message: 'Mail is not configured on the server' });
  }
  const pdfBuffer = await buildQuotationPdfBuffer(quotation.toObject());
  const subject = req.body.subject || `Quotation ${quotation.quotationNumber}`;
  const message =
    req.body.message ||
    `Dear ${quotation.clientName || 'Client'},\n\nPlease find your quotation attached.`;

  const logoFile = resolveMailLogoFile();
  const logoCid = logoFile ? MAIL_LOGO_CID : undefined;
  const { html, text } = mailTemplates.quotationSentGuest(quotation.toObject(), {
    message,
    logoCid,
  });

  const attachments = [
    {
      filename: `${quotation.quotationNumber || quotation._id}.pdf`,
      content: pdfBuffer,
      contentType: 'application/pdf',
    },
  ];
  if (logoFile) {
    attachments.push({
      filename: 'valleycroft-logo.png',
      path: logoFile,
      cid: logoCid,
      contentDisposition: 'inline',
      contentType: 'image/png',
    });
  }

  const info = await invoiceNotify.sendViaMailTransport({
    from: getMailFrom(),
    to,
    subject,
    text,
    html,
    attachments,
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
  getMailFrom,
};
