/**
 * Payment receipt PDF + helpers for admin download / email.
 */
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const Debtor = require('../models/Debtor');
const DebtorPayment = require('../models/DebtorPayment');
const Counter = require('../models/Counter');
const mailTemplates = require('./mailTemplates');

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
    if (buf.toString('ascii', 1, 4) !== 'PNG') return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  } catch {
    return null;
  }
}

function formatMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 'R 0.00';
  return `R ${v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}`;
}

function formatDate(d) {
  if (!d) return '—';
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-ZA', { year: 'numeric', month: 'short', day: 'numeric' });
}

async function loadPaymentReceiptContext(debtorId, paymentId) {
  const payment = await DebtorPayment.findById(paymentId).lean();
  if (!payment) {
    const err = new Error('Payment not found');
    err.statusCode = 404;
    throw err;
  }
  if (String(payment.debtorId) !== String(debtorId)) {
    const err = new Error('Payment does not belong to this debtor');
    err.statusCode = 404;
    throw err;
  }

  const debtor = await Debtor.findById(debtorId)
    .populate({
      path: 'guestBookingRef',
      select: 'trackingCode guestName checkIn checkOut roomId',
      populate: { path: 'roomId', select: 'name type' },
    })
    .populate({
      path: 'bookingRef',
      select: 'guestName type checkIn checkOut eventDate roomId',
      populate: { path: 'roomId', select: 'name type' },
    })
    .populate('invoiceRef', 'invoiceNumber status total dueDate')
    .lean({ virtuals: true });

  if (!debtor) {
    const err = new Error('Debtor not found');
    err.statusCode = 404;
    throw err;
  }

  return { payment, debtor };
}

function buildReceiptPdfBuffer({ payment, debtor }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const brand = '#1a2e26';
    const ink = '#243830';
    const muted = '#6b7c72';
    const line = '#d4e5dc';
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const contentWidth = right - left;
    const gap = 12;

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

    const logoFile = resolveMailLogoFile();
    const headerTop = doc.y;
    let headerBottom = headerTop;
    if (logoFile) {
      try {
        const natural = readPngSize(logoFile) || { width: 801, height: 272 };
        const scale = Math.min(Math.min(220, contentWidth * 0.5) / natural.width, 64 / natural.height);
        const drawW = Math.round(natural.width * scale);
        const drawH = Math.round(natural.height * scale);
        doc.image(logoFile, left + (contentWidth - drawW) / 2, headerTop, { width: drawW, height: drawH });
        headerBottom = headerTop + drawH;
      } catch (err) {
        console.warn('[receipt pdf] logo embed failed:', err?.message || err);
      }
    }

    doc.font('Helvetica').fontSize(9.5).fillColor(muted).text('Payment receipt', left, headerBottom + 4, {
      width: contentWidth,
      align: 'center',
    });
    doc.y = headerBottom + 18;

    const bannerY = doc.y;
    doc.roundedRect(left, bannerY, contentWidth, 28, 5).fill(brand);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#ffffff').text(
      payment.receiptNumber || `RCP-${String(payment._id).slice(-6).toUpperCase()}`,
      left + 12,
      bannerY + 8,
      { width: contentWidth * 0.55 }
    );
    doc.font('Helvetica').fontSize(8.5).fillColor('rgba(255,255,255,0.92)').text(
      formatDate(payment.paidAt),
      left + contentWidth * 0.55,
      bannerY + 9,
      { width: contentWidth * 0.45 - 12, align: 'right' }
    );
    doc.y = bannerY + 40;

    const panelW = (contentWidth - gap) / 2;
    const panelsTop = doc.y;
    const panelH = 110;
    drawPanel(left, panelsTop, panelW, panelH);
    drawPanel(left + panelW + gap, panelsTop, panelW, panelH);

    kv(left + 10, panelsTop + 14, 'Received from', debtor.name, panelW - 20);
    kv(left + 10, panelsTop + 42, 'Debtor no.', debtor.debtorNumber || '—', panelW - 20);
    kv(left + 10, panelsTop + 70, 'Email', debtor.contactEmail || '—', panelW - 20);

    const roomName =
      debtor.guestBookingRef?.roomId?.name ||
      debtor.bookingRef?.roomId?.name ||
      '—';
    const bookingCode = debtor.guestBookingRef?.trackingCode || '—';
    const invoiceNo = debtor.invoiceRef?.invoiceNumber || '—';
    kv(left + panelW + gap + 10, panelsTop + 14, 'Room / stay', roomName, panelW - 20);
    kv(left + panelW + gap + 10, panelsTop + 42, 'Booking ref', bookingCode, panelW - 20);
    kv(left + panelW + gap + 10, panelsTop + 70, 'Invoice', invoiceNo, panelW - 20);
    doc.y = panelsTop + panelH + 14;

    doc.font('Helvetica-Bold').fontSize(9).fillColor(brand).text('PAYMENT DETAILS', left, doc.y, {
      characterSpacing: 0.4,
    });
    doc.moveDown(0.4);
    const payTop = doc.y;
    const payH = 96;
    drawPanel(left, payTop, contentWidth, payH);
    const col = (contentWidth - 30) / 2;
    kv(left + 10, payTop + 14, 'Amount paid', formatMoney(payment.amount), col);
    kv(left + 10 + col + 10, payTop + 14, 'Method', String(payment.method || '—').toUpperCase(), col);
    kv(left + 10, payTop + 48, 'Payment reference', payment.reference || '—', col);
    kv(left + 10 + col + 10, payTop + 48, 'Balance after', formatMoney(payment.remainingAfter), col);
    doc.y = payTop + payH + 12;

    if (payment.note) {
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(ink).text('Note', left, doc.y);
      doc.moveDown(0.2);
      doc.font('Helvetica').fontSize(8.5).fillColor(ink).text(String(payment.note), left, doc.y, {
        width: contentWidth,
      });
      doc.moveDown(0.6);
    }

    const bank = mailTemplates.bookingBankDetails();
    doc.font('Helvetica-Bold').fontSize(9).fillColor(brand).text('BANKING DETAILS', left, doc.y, {
      characterSpacing: 0.4,
    });
    doc.moveDown(0.35);
    const bankTop = doc.y;
    const bankH = 72;
    drawPanel(left, bankTop, contentWidth, bankH);
    kv(left + 10, bankTop + 12, 'Bank', bank.bankName, col);
    kv(left + 10 + col + 10, bankTop + 12, 'Branch code', bank.branchCode, col);
    kv(left + 10, bankTop + 42, 'Account number', bank.accountNumber, col);
    kv(left + 10 + col + 10, bankTop + 42, 'Account name', bank.accountName, col);
    doc.y = bankTop + bankH + 14;

    doc.strokeColor(line).lineWidth(0.7).moveTo(left, doc.y).lineTo(right, doc.y).stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor(muted).text(
      `ValleyCroft Farm · Receipt ${payment.receiptNumber || ''} · Debtor ${debtor.debtorNumber || ''} · ${formatDate(new Date())}`,
      left,
      doc.y + 6,
      { width: contentWidth, align: 'center' }
    );

    doc.end();
  });
}

/** Assign DBT-YYYY-#### to legacy debtors missing a number (oldest first). */
async function backfillMissingDebtorNumbers() {
  const missing = await Debtor.find({
    $or: [{ debtorNumber: { $exists: false } }, { debtorNumber: null }, { debtorNumber: '' }],
  })
    .sort({ createdAt: 1 })
    .select('_id createdAt')
    .lean();
  if (!missing.length) return { updated: 0 };

  let updated = 0;
  for (const row of missing) {
    const year = row.createdAt ? new Date(row.createdAt).getFullYear() : new Date().getFullYear();
    const counter = await Counter.findOneAndUpdate(
      { _id: `debtor:${year}` },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    ).lean();
    const debtorNumber = `DBT-${year}-${String(counter.seq).padStart(4, '0')}`;
    const result = await Debtor.updateOne(
      {
        _id: row._id,
        $or: [{ debtorNumber: { $exists: false } }, { debtorNumber: null }, { debtorNumber: '' }],
      },
      { $set: { debtorNumber } }
    );
    if (result.modifiedCount) updated += 1;
  }
  return { updated };
}

/** Assign RCP-YYYY-#### to legacy payments missing a receipt number. */
async function backfillMissingReceiptNumbers() {
  const missing = await DebtorPayment.find({
    $or: [{ receiptNumber: { $exists: false } }, { receiptNumber: null }, { receiptNumber: '' }],
  })
    .sort({ createdAt: 1 })
    .select('_id createdAt')
    .lean();
  if (!missing.length) return { updated: 0 };

  let updated = 0;
  for (const row of missing) {
    const year = row.createdAt ? new Date(row.createdAt).getFullYear() : new Date().getFullYear();
    const counter = await Counter.findOneAndUpdate(
      { _id: `receipt:${year}` },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    ).lean();
    const receiptNumber = `RCP-${year}-${String(counter.seq).padStart(4, '0')}`;
    const result = await DebtorPayment.updateOne(
      {
        _id: row._id,
        $or: [{ receiptNumber: { $exists: false } }, { receiptNumber: null }, { receiptNumber: '' }],
      },
      { $set: { receiptNumber } }
    );
    if (result.modifiedCount) updated += 1;
  }
  return { updated };
}

async function ensureHumanFriendlyFinanceNumbers() {
  const debtors = await backfillMissingDebtorNumbers();
  const receipts = await backfillMissingReceiptNumbers();
  return { debtors: debtors.updated, receipts: receipts.updated };
}

module.exports = {
  loadPaymentReceiptContext,
  buildReceiptPdfBuffer,
  resolveMailLogoFile,
  ensureHumanFriendlyFinanceNumbers,
  formatMoney,
  formatDate,
};
