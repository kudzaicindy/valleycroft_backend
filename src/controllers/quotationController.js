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

/** Read PNG IHDR width/height without extra deps. */
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
      margins: { top: 24, bottom: 28, left: 36, right: 36 },
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
    const gap = 8;

    function ensureSpace(minHeight = 20) {
      if (doc.y + minHeight > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
      }
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
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(ink).text(String(value || '—'), x, y + 9, {
        width,
      });
    }

    // ── Header: wide wordmark (logo is ~801x272), not a square box ──
    const logoFile = resolveMailLogoFile();
    const headerTop = doc.y;
    const logoMaxW = Math.min(260, contentWidth * 0.55);
    const logoMaxH = 78;
    let headerBottom = headerTop;

    if (logoFile) {
      try {
        const natural = readPngSize(logoFile) || { width: 801, height: 272 };
        const scale = Math.min(logoMaxW / natural.width, logoMaxH / natural.height);
        const drawW = Math.round(natural.width * scale);
        const drawH = Math.round(natural.height * scale);
        const logoX = left + (contentWidth - drawW) / 2;
        doc.image(logoFile, logoX, headerTop, { width: drawW, height: drawH });
        headerBottom = headerTop + drawH;
      } catch (err) {
        console.warn('[quotation pdf] logo embed failed:', err?.message || err);
      }
    }

    doc.font('Helvetica').fontSize(9.5).fillColor(muted).text(
      'Agro-Tourism Event Quotation',
      left,
      headerBottom + 3,
      { width: contentWidth, align: 'center' }
    );
    doc.y = headerBottom + 16;

    // Quote number banner
    ensureSpace(28);
    const bannerY = doc.y;
    doc.roundedRect(left, bannerY, contentWidth, 26, 5).fill(brand);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#ffffff').text(
      `Quotation ${quotation.quotationNumber || '—'}`,
      left + 10,
      bannerY + 7,
      { width: contentWidth * 0.55 }
    );
    doc.font('Helvetica').fontSize(8.5).fillColor('rgba(255,255,255,0.92)').text(
      `Valid until ${formatPdfDate(quotation.validUntil)}`,
      left + contentWidth * 0.55,
      bannerY + 8,
      { width: contentWidth * 0.45 - 10, align: 'right' }
    );
    doc.y = bannerY + 34;

    // ── Client / Event panels ────────────────────────────────
    ensureSpace(100);
    const panelsTop = doc.y;
    const panelW = (contentWidth - gap) / 2;
    const panelH = 98;
    drawPanel(left, panelsTop, panelW, panelH);
    drawPanel(left + panelW + gap, panelsTop, panelW, panelH);

    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(brand).text('Client', left + 10, panelsTop + 8);
    kv(left + 10, panelsTop + 22, 'Name', quotation.clientName, panelW - 20);
    kv(left + 10, panelsTop + 44, 'Email', quotation.clientEmail, panelW - 20);
    kv(left + 10, panelsTop + 66, 'Phone', quotation.clientPhone, panelW - 20);

    const eventX = left + panelW + gap + 10;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(brand).text('Event', eventX, panelsTop + 8);
    kv(eventX, panelsTop + 22, 'Type', quotation.eventType || quotation.eventTitle, panelW - 20);
    kv(eventX, panelsTop + 44, 'Date', formatPdfDate(quotation.eventDate), (panelW - 24) / 2);
    kv(
      eventX + (panelW - 20) * 0.52,
      panelsTop + 44,
      'Guests',
      quotation.guestCount != null && quotation.guestCount !== '' ? String(quotation.guestCount) : '—',
      (panelW - 20) * 0.48
    );
    kv(eventX, panelsTop + 66, 'Venue', quotation.venue, panelW - 20);
    doc.y = panelsTop + panelH + 10;

    // ── Line items ──────────────────────────────────────────
    sectionTitle('Line items');
    const items = Array.isArray(quotation.lineItems) ? quotation.lineItems : [];
    const colDesc = left + 6;
    const colQty = left + contentWidth * 0.54;
    const colUnit = left + contentWidth * 0.64;
    const colAmt = left + contentWidth * 0.78;
    const amtW = right - colAmt - 6;
    const unitW = colAmt - colUnit - 5;
    const descW = colQty - colDesc - 5;

    ensureSpace(20);
    const headY = doc.y;
    doc.roundedRect(left, headY, contentWidth, 18, 4).fill(brandSoft);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(brand);
    doc.text('Description', colDesc, headY + 5, { width: descW });
    doc.text('Qty', colQty, headY + 5, { width: 36, align: 'right' });
    doc.text('Unit price', colUnit, headY + 5, { width: unitW, align: 'right' });
    doc.text('Amount', colAmt, headY + 5, { width: amtW, align: 'right' });
    doc.y = headY + 20;

    if (!items.length) {
      ensureSpace(18);
      doc.font('Helvetica').fontSize(9).fillColor(muted).text('No line items', left + 6, doc.y + 3);
      doc.y += 18;
    } else {
      items.forEach((item, idx) => {
        const desc = String(item.description || 'Item');
        const qty = Number(item.qty) || 0;
        const unit = Number(item.unitPrice) || 0;
        const total = Number(item.total != null ? item.total : qty * unit) || 0;
        const descHeight = Math.max(
          11,
          doc.heightOfString(desc, { width: descW, font: 'Helvetica', fontSize: 9 })
        );
        const rowH = Math.max(18, descHeight + 6);
        ensureSpace(rowH + 2);
        const rowY = doc.y;
        if (idx % 2 === 1) {
          doc.rect(left, rowY, contentWidth, rowH).fill('#fafaf8');
        }
        doc.font('Helvetica').fontSize(9).fillColor(ink).text(desc, colDesc, rowY + 4, { width: descW });
        doc.text(String(qty), colQty, rowY + 4, { width: 36, align: 'right' });
        doc.text(formatMoney(unit), colUnit, rowY + 4, { width: unitW, align: 'right' });
        doc.font('Helvetica-Bold').text(formatMoney(total), colAmt, rowY + 4, { width: amtW, align: 'right' });
        doc.strokeColor(line).lineWidth(0.5).moveTo(left, rowY + rowH).lineTo(right, rowY + rowH).stroke();
        doc.y = rowY + rowH;
      });
    }

    doc.y += 6;

    // ── Totals ──────────────────────────────────────────────
    const hasTax = Number(quotation.tax) > 0;
    const totalsH = hasTax ? 58 : 44;
    ensureSpace(totalsH + 6);
    const totalsW = Math.min(200, contentWidth * 0.4);
    const totalsX = right - totalsW;
    const totalsTop = doc.y;
    drawPanel(totalsX, totalsTop, totalsW, totalsH);
    doc.font('Helvetica').fontSize(8.5).fillColor(muted).text('Subtotal', totalsX + 10, totalsTop + 10);
    doc.font('Helvetica').fontSize(8.5).fillColor(ink).text(formatMoney(quotation.subtotal), totalsX + 10, totalsTop + 10, {
      width: totalsW - 20,
      align: 'right',
    });
    if (hasTax) {
      doc.font('Helvetica').fontSize(8.5).fillColor(muted).text('Other charges', totalsX + 10, totalsTop + 24);
      doc.font('Helvetica').fontSize(8.5).fillColor(ink).text(formatMoney(quotation.tax), totalsX + 10, totalsTop + 24, {
        width: totalsW - 20,
        align: 'right',
      });
    }
    const totalY = hasTax ? totalsTop + 40 : totalsTop + 26;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(brand).text('Total', totalsX + 10, totalY);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(brand).text(formatMoney(quotation.total), totalsX + 10, totalY, {
      width: totalsW - 20,
      align: 'right',
    });
    doc.y = totalsTop + totalsH + 10;

    // ── Notes & terms ───────────────────────────────────────
    const notes = String(quotation.notes || '').trim();
    const terms = String(quotation.terms || '').trim();
    if (notes || terms) {
      sectionTitle('Notes & terms');
      if (notes) {
        ensureSpace(30);
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(ink).text('Notes', left, doc.y);
        doc.moveDown(0.15);
        doc.font('Helvetica').fontSize(8.5).fillColor(ink).text(notes, left, doc.y, { width: contentWidth, lineGap: 1 });
        doc.moveDown(0.35);
      }
      if (terms) {
        ensureSpace(30);
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(ink).text('Terms', left, doc.y);
        doc.moveDown(0.15);
        doc.font('Helvetica').fontSize(8.5).fillColor(ink).text(terms, left, doc.y, { width: contentWidth, lineGap: 1 });
        doc.moveDown(0.25);
      }
    }

    // ── Banking details (bottom) ────────────────────────────
    const bank = mailTemplates.bookingBankDetails();
    sectionTitle('Banking details');
    ensureSpace(88);
    const bankPanelH = 86;
    const bankTop = doc.y;
    drawPanel(left, bankTop, contentWidth, bankPanelH);
    const bankColW = (contentWidth - 30) / 2;
    kv(left + 10, bankTop + 12, 'Bank', bank.bankName, bankColW);
    kv(left + 10 + bankColW + 10, bankTop + 12, 'Branch code', bank.branchCode, bankColW);
    kv(left + 10, bankTop + 48, 'Account number', bank.accountNumber, bankColW);
    kv(left + 10 + bankColW + 10, bankTop + 48, 'Account name', bank.accountName, bankColW);
    doc.y = bankTop + bankPanelH + 8;

    // Footer directly under content — never pinned to page bottom
    ensureSpace(22);
    const footY = doc.y + 4;
    doc.strokeColor(line).lineWidth(0.7).moveTo(left, footY).lineTo(right, footY).stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor(muted).text(
      `ValleyCroft Farm · Quotation ${quotation.quotationNumber || ''} · Prepared ${formatPdfDate(quotation.createdAt || new Date())}`,
      left,
      footY + 5,
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
