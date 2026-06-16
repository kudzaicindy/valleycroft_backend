/**
 * Branded HTML + plain-text bodies for booking lifecycle emails.
 * Tables + inline styles for broad client support.
 */

const { guestPayNowPageUrl } = require('./payfastService');

const DEFAULT_BUSINESS_NAME = 'Valley Croft Accommodation';

function bizName() {
  return process.env.BUSINESS_NAME || DEFAULT_BUSINESS_NAME;
}

function accent() {
  return process.env.MAIL_ACCENT_COLOR || '#2a5d4a';
}

function accentSoft() {
  return '#e8f1ed';
}

function muted() {
  return '#5c6d64';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Coerce Mongoose numbers, strings, Decimal128-like objects to a finite number or NaN. */
function coerceNumber(val) {
  if (val == null || val === '') return NaN;
  if (typeof val === 'number') return Number.isFinite(val) ? val : NaN;
  if (typeof val === 'bigint') return Number(val);
  if (typeof val === 'string') {
    const t = val.trim();
    if (t === '') return NaN;
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
  }
  if (typeof val === 'object' && val !== null && typeof val.toString === 'function') {
    const n = Number(String(val.toString()).trim());
    if (Number.isFinite(n)) return n;
  }
  const n = Number(val);
  return Number.isFinite(n) ? n : NaN;
}

function formatMoney(n) {
  const v = coerceNumber(n);
  const x = Number.isFinite(v) ? v : 0;
  return `R ${x.toFixed(2)}`;
}

/** HTML amounts: nbsp after R so Gmail/Outlook don’t break “R” from the figure. */
function formatMoneyHtml(n) {
  const v = coerceNumber(n);
  const x = Number.isFinite(v) ? v : 0;
  return `R&nbsp;${x.toFixed(2)}`;
}

function formatDate(d) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleDateString('en-ZA', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return String(d);
  }
}

function trackingHint(trackingCode, guestEmail) {
  const base = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
  if (base && trackingCode && guestEmail) {
    const path = (process.env.FRONTEND_GUEST_TRACK_PATH || 'track').replace(/^\/+/, '').replace(/\/+$/, '');
    const q = new URLSearchParams({ email: guestEmail, trackingCode }).toString();
    return `${base}/${path}?${q}`;
  }
  return null;
}

/** Days before check-in that guest must cancel by for a refund (override via env). */
function cancellationRefundDaysBeforeCheckIn() {
  const n = Number(process.env.MAIL_CANCELLATION_REFUND_DAYS_BEFORE_CHECKIN);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30;
}

/** Full policy text for guest emails; override with MAIL_CANCELLATION_POLICY in .env */
function cancellationPolicyText() {
  const custom = (process.env.MAIL_CANCELLATION_POLICY || '').trim();
  if (custom) return custom;
  const days = cancellationRefundDaysBeforeCheckIn();
  return `Your deposit is the full amount for your stay and is due as soon as your booking is confirmed. Refunds are only available if you cancel at least ${days} days before your check-in date. Cancellations within ${days} days of check-in are non-refundable.`;
}

/** Confirmation email — includes check-in and refund deadline when dates are known. */
function cancellationPolicyTextForBooking(payload = {}) {
  const custom = (process.env.MAIL_CANCELLATION_POLICY || '').trim();
  const days = cancellationRefundDaysBeforeCheckIn();
  let text =
    custom ||
    `Your deposit is the full amount for your stay and is due as soon as your booking is confirmed. Refunds are only available if you cancel at least ${days} days before your check-in date. Cancellations within ${days} days of check-in are non-refundable.`;

  const checkIn = payload.checkIn ? new Date(payload.checkIn) : null;
  if (checkIn && !Number.isNaN(checkIn.getTime())) {
    const deadline = new Date(checkIn);
    deadline.setDate(deadline.getDate() - days);
    text += `\n\nCheck-in: ${formatDate(checkIn)}.`;
    if (payload.checkOut) {
      text += ` Check-out: ${formatDate(payload.checkOut)}.`;
    }
    text += ` To qualify for a refund, cancel on or before ${formatDate(deadline)}.`;
  }
  return text;
}

/** Pending-request email (before confirmation): no “this confirmation” yet */
function cancellationPolicyPendingGuestText() {
  const custom = (process.env.MAIL_CANCELLATION_POLICY_PENDING || '').trim();
  if (custom) return custom;
  const days = cancellationRefundDaysBeforeCheckIn();
  return `When we confirm your booking, the full amount for your stay will be due at that time. Refunds are only available if you cancel at least ${days} days before your check-in date.`;
}

function cancellationPolicyPendingGuestHtml() {
  const t = cancellationPolicyPendingGuestText();
  const a = accent();
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 0;">
  <tr>
    <td style="padding:20px 22px;background:${accentSoft()};border-radius:12px;border:1px solid #d4e5dc;">
      <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:${a};letter-spacing:0.06em;text-transform:uppercase;">Payment & cancellation</p>
      <p style="margin:0;font-size:14px;line-height:1.6;color:#2a3a33;">${escapeHtml(t).replace(/\n/g, '<br>')}</p>
    </td>
  </tr>
</table>`;
}

/** Short line for admin notification emails */
function cancellationPolicySummary() {
  const days = cancellationRefundDaysBeforeCheckIn();
  return `Full payment due on confirmation; refund only if cancelled ${days}+ days before check-in.`;
}

function cancellationPolicyGuestHtml(payload = {}) {
  const t = cancellationPolicyTextForBooking(payload);
  const a = accent();
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 0;">
  <tr>
    <td style="padding:20px 22px;background:${accentSoft()};border-radius:12px;border:1px solid #d4e5dc;">
      <p style="margin:0 0 8px;font-size:12px;font-weight:600;color:${a};letter-spacing:0.06em;text-transform:uppercase;">Deposit & cancellation</p>
      <p style="margin:0;font-size:14px;line-height:1.6;color:#2a3a33;">${escapeHtml(t).replace(/\n/g, '<br>')}</p>
    </td>
  </tr>
</table>`;
}

function cancellationPolicyGuestText(payload = {}) {
  return `Deposit & cancellation:\n${cancellationPolicyTextForBooking(payload)}`;
}

/** Robust total for invoice emails (Mongoose subdocs, lean objects, plain JSON). */
function invoiceNumericTotal(payload) {
  if (payload == null) return 0;
  const t = coerceNumber(payload.total);
  if (Number.isFinite(t)) return t;
  const items = payload.lineItems;
  if (!Array.isArray(items) || items.length === 0) return 0;
  let sum = 0;
  for (const li of items) {
    if (li == null) continue;
    const lt = coerceNumber(li.total);
    if (Number.isFinite(lt)) {
      sum += lt;
    } else {
      sum += (coerceNumber(li.qty) || 1) * (coerceNumber(li.unitPrice) || 0);
    }
  }
  return Number.isFinite(sum) ? sum : 0;
}

function invoiceDepositAmount(payload) {
  return confirmationDepositDue(payload);
}

/** Amount guest must pay on confirmation — deposit 0 or missing means full stay total. */
function confirmationDepositDue(payload) {
  const total = invoiceNumericTotal(payload);
  if (total <= 0) return 0;
  const d = coerceNumber(payload.deposit);
  if (!Number.isFinite(d) || d <= 0) return total;
  return Math.min(d, total);
}

function guestFacingInvoiceNotes(notes) {
  const n = String(notes || '').trim();
  if (!n) return '';
  if (/^Booking ref:/i.test(n) && /(deposit|balance due|full amount due)/i.test(n)) return '';
  return n;
}

/** Deposit + stay dates summary at top of confirmation email. */
function buildConfirmationDepositSummaryHtml(payload) {
  const depositDue = confirmationDepositDue(payload);
  const rows = [detailMoneyRow('Deposit (full amount due)', depositDue)];
  if (payload.checkIn) rows.push(detailRow('Check-in', formatDate(payload.checkIn)));
  if (payload.checkOut) rows.push(detailRow('Check-out', formatDate(payload.checkOut)));
  const { html } = buildDetailTable(rows);
  return `<h2 style="margin:24px 0 12px;font-family:Georgia,serif;font-size:20px;font-weight:600;color:#1a2e26;letter-spacing:-0.02em;">Your deposit</h2>
<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#243830;">Upon confirmation, your <strong>deposit is the full amount</strong> for your stay (not a partial payment). Please pay by bank transfer using the details below.</p>
${html}`;
}

function buildConfirmationDepositSummaryText(payload) {
  const depositDue = confirmationDepositDue(payload);
  const lines = [`Deposit (full amount due): ${formatMoney(depositDue)}`];
  if (payload.checkIn) lines.push(`Check-in: ${formatDate(payload.checkIn)}`);
  if (payload.checkOut) lines.push(`Check-out: ${formatDate(payload.checkOut)}`);
  return lines.join('\n');
}

function invoiceBalanceAmount(payload) {
  const fromPayload = coerceNumber(payload.balanceDue);
  if (Number.isFinite(fromPayload) && fromPayload >= 0) return fromPayload;
  return Math.max(0, invoiceNumericTotal(payload) - invoiceDepositAmount(payload));
}

/** EFT bank details shown on booking confirmation emails. */
function bookingBankDetails() {
  return {
    accountNumber: (process.env.BOOKING_BANK_ACCOUNT_NUMBER || '63157115148').trim(),
    accountName: (process.env.BOOKING_BANK_ACCOUNT_NAME || 'Ngimu Agriculture').trim(),
    bankName: (process.env.BOOKING_BANK_NAME || 'FNB').trim(),
    branchCode: (process.env.BOOKING_BANK_BRANCH || '250655').trim(),
  };
}

/** Where guests send proof of payment (POP). */
function bookingPopContacts() {
  const email =
    process.env.BOOKING_POP_EMAIL?.trim() ||
    process.env.BOOKING_ADMIN_EMAIL?.trim() ||
    process.env.GMAIL_USER?.trim() ||
    '';
  const raw =
    process.env.BOOKING_POP_WHATSAPP?.trim() ||
    process.env.BUSINESS_WHATSAPP?.trim() ||
    '';
  const whatsappNumbers = raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return { email, whatsappNumbers };
}

function formatWhatsAppDisplay(num) {
  const digits = String(num).replace(/\D/g, '');
  if (!digits) return String(num);
  if (digits.startsWith('27') && digits.length >= 11) {
    return `+${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`.trim();
  }
  if (digits.length === 10 && digits.startsWith('0')) {
    return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
  }
  return num;
}

function whatsappWaMeLink(num) {
  let digits = String(num).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('0')) digits = `27${digits.slice(1)}`;
  if (!digits.startsWith('27') && digits.length <= 10) digits = `27${digits}`;
  return `https://wa.me/${digits}`;
}

function bookingPaymentReference(trackingCode) {
  const ref = String(trackingCode || '').trim();
  return ref || 'your booking reference';
}

/** Plain-text bank + POP block for email / WhatsApp. */
function buildBankPaymentInstructionsText(trackingCode) {
  const bank = bookingBankDetails();
  const pop = bookingPopContacts();
  const payRef = bookingPaymentReference(trackingCode);
  const lines = [
    'How to pay (bank transfer / EFT)',
    'Pay the full amount for your stay.',
    `Account name: ${bank.accountName}`,
    `Bank: ${bank.bankName}`,
    `Branch code: ${bank.branchCode}`,
    `Account number: ${bank.accountNumber}`,
    `Reference: ${payRef}`,
    '',
    'Proof of payment (POP)',
    'After paying, please send your proof of payment so we can confirm receipt.',
  ];
  if (pop.email) lines.push(`Email: ${pop.email}`);
  if (pop.whatsappNumbers.length) {
    lines.push(`WhatsApp: ${pop.whatsappNumbers.map(formatWhatsAppDisplay).join(' or ')}`);
  }
  return lines.join('\n');
}

function buildBankPaymentInstructionsHtml(trackingCode) {
  const bank = bookingBankDetails();
  const pop = bookingPopContacts();
  const payRef = bookingPaymentReference(trackingCode);
  const a = accent();

  const bankRows = [
    detailRow('Account name', bank.accountName),
    detailRow('Bank', bank.bankName),
    detailRow('Branch code', bank.branchCode),
    detailRow('Account number', bank.accountNumber),
    detailRow('Payment reference', payRef),
  ];
  const { html: bankTable } = buildDetailTable(bankRows);

  let popLinesHtml = '';
  if (pop.email) {
    popLinesHtml += `<p style="margin:0 0 10px;font-size:15px;line-height:1.55;color:#243830;"><strong>Email:</strong> <a href="mailto:${escapeHtml(pop.email)}" style="color:${a};">${escapeHtml(pop.email)}</a></p>`;
  }
  for (const num of pop.whatsappNumbers) {
    const wa = whatsappWaMeLink(num);
    const label = formatWhatsAppDisplay(num);
    popLinesHtml += `<p style="margin:0 0 10px;font-size:15px;line-height:1.55;color:#243830;"><strong>WhatsApp:</strong> ${
      wa
        ? `<a href="${escapeHtml(wa)}" style="color:${a};">${escapeHtml(label)}</a>`
        : escapeHtml(label)
    }</p>`;
  }
  if (!pop.email && !pop.whatsappNumbers.length) {
    popLinesHtml =
      '<p style="margin:0;font-size:15px;line-height:1.55;color:#243830;">Reply to this email with your proof of payment attached.</p>';
  }

  return `<h2 style="margin:28px 0 12px;font-family:Georgia,serif;font-size:20px;font-weight:600;color:#1a2e26;letter-spacing:-0.02em;">How to pay</h2>
<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#243830;">Please pay the <strong>full amount</strong> for your stay by <strong>bank transfer / EFT</strong> into the account below. Use your booking reference as the payment reference.</p>
${bankTable}
<h2 style="margin:28px 0 12px;font-family:Georgia,serif;font-size:20px;font-weight:600;color:#1a2e26;letter-spacing:-0.02em;">Proof of payment</h2>
<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#243830;">Once paid, send us your <strong>proof of payment (POP)</strong> — a screenshot or PDF of your bank transfer — so we can confirm receipt:</p>
${popLinesHtml}`;
}

/**
 * @param {{ headline: string, preheader?: string, lead?: string, blocksHtml: string, blocksText: string, cta?: { href: string, label: string } }} opts
 */
function wrapLayout(opts) {
  const name = bizName();
  const a = accent();
  const pre = escapeHtml(opts.preheader || opts.headline);
  const logoUrl = (process.env.MAIL_LOGO_URL || '').trim();
  const logoBlock = logoUrl
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 12px;"><tr><td style="background:#ffffff;padding:12px 16px;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
<img src="${escapeHtml(logoUrl)}" alt="" width="100" style="display:block;max-width:100px;height:auto;margin:0 auto;" />
</td></tr></table>`
    : '';

  let ctaHtml = '';
  if (opts.cta?.href && opts.cta?.label) {
    ctaHtml = `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:32px 0 0;">
        <tr>
          <td style="border-radius:999px;background:${a};box-shadow:0 4px 14px rgba(42,93,74,0.35);">
            <a href="${escapeHtml(opts.cta.href)}" style="display:inline-block;padding:15px 32px;font-family:Georgia,'Times New Roman',serif;font-size:16px;color:#ffffff;text-decoration:none;font-weight:600;letter-spacing:0.02em;">${escapeHtml(opts.cta.label)}</a>
          </td>
        </tr>
      </table>`;
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>${escapeHtml(opts.headline)}</title>
</head>
<body style="margin:0;padding:0;background:#dce5df;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${pre}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#dce5df;padding:40px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;box-shadow:0 8px 40px rgba(26,46,38,0.12);border:1px solid #c9ddd2;">
        <tr>
          <td style="background:linear-gradient(155deg,#1a3d32 0%,#2a5d4a 45%,#356b56 100%);background-color:#1a3d32;padding:36px 40px 32px;text-align:center;">
            ${logoBlock}
            <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:24px;color:#ffffff;font-weight:600;line-height:1.25;letter-spacing:0.02em;text-shadow:0 1px 2px rgba(0,0,0,0.15);">${escapeHtml(name)}</p>
            <p style="margin:10px 0 0;font-size:12px;color:rgba(255,255,255,0.88);letter-spacing:0.18em;text-transform:uppercase;font-family:system-ui,-apple-system,sans-serif;">Hospitality in the valley</p>
          </td>
        </tr>
        <tr>
          <td style="padding:36px 40px 44px;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:16px;line-height:1.6;color:#243830;">
            <h1 style="margin:0 0 14px;font-family:Georgia,serif;font-size:26px;font-weight:600;color:#1a2e26;line-height:1.25;letter-spacing:-0.02em;">${escapeHtml(opts.headline)}</h1>
            ${opts.lead ? `<p style="margin:0 0 22px;color:${muted()};font-size:16px;line-height:1.55;border-left:3px solid ${a};padding-left:14px;">${opts.lead}</p>` : ''}
            ${opts.blocksHtml}
            ${ctaHtml}
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:40px 0 0;">
              <tr>
                <td style="height:1px;background:linear-gradient(90deg,transparent,#d4e5dc,transparent);font-size:0;line-height:0;">&nbsp;</td>
              </tr>
            </table>
            <p style="margin:28px 0 0;font-size:15px;color:${muted()};line-height:1.55;">With warm regards,</p>
            <p style="margin:6px 0 0;font-size:16px;font-weight:600;color:#1a2e26;font-family:Georgia,serif;">${escapeHtml(name)}</p>
          </td>
        </tr>
      </table>
      <p style="margin:24px 24px 0;font-family:system-ui,sans-serif;font-size:11px;line-height:1.5;color:#7a8a82;max-width:520px;">You are receiving this because a booking was requested or updated at ${escapeHtml(name)}. Please do not reply with payment card details by email.</p>
    </td>
  </tr>
</table>
</body>
</html>`;

  const text = [
    `${name}`,
    '',
    opts.headline,
    '',
    opts.lead || '',
    opts.blocksText,
    opts.cta?.href ? `\n${opts.cta.label}: ${opts.cta.href}\n` : '',
    '',
    `— ${name}`,
  ]
    .filter((line) => line !== '')
    .join('\n');

  return { html, text };
}

function detailRow(label, value) {
  const v = value == null || value === '' ? '—' : String(value);
  return {
    html: `<tr>
  <td style="padding:12px 14px 12px 0;border-bottom:1px solid #e8f0ec;font-size:13px;color:${muted()};vertical-align:top;width:38%;font-weight:500;">${escapeHtml(label)}</td>
  <td style="padding:12px 0;border-bottom:1px solid #e8f0ec;font-size:15px;color:#1a2e26;font-weight:600;vertical-align:top;">${escapeHtml(v)}</td>
</tr>`,
    text: `${label}: ${v}`,
  };
}

/** Summary row where the value is a currency amount (HTML uses nbsp; plain text uses formatMoney). */
function detailMoneyRow(label, numericAmount) {
  const textVal = formatMoney(numericAmount);
  return {
    html: `<tr>
  <td style="padding:12px 14px 12px 0;border-bottom:1px solid #e8f0ec;font-size:13px;color:${muted()};vertical-align:top;width:38%;font-weight:500;">${escapeHtml(label)}</td>
  <td style="padding:12px 0;border-bottom:1px solid #e8f0ec;font-size:15px;color:#1a2e26;font-weight:600;vertical-align:top;white-space:nowrap;">${formatMoneyHtml(numericAmount)}</td>
</tr>`,
    text: `${label}: ${textVal}`,
  };
}

function buildDetailTable(rows) {
  const inner = rows.map((r) => r.html).join('');
  // supports detailRow and detailMoneyRow (both expose .html + .text)
  const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:12px 0 0;">
  <tr>
    <td style="padding:4px 0 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${accentSoft()};border-radius:14px;border:1px solid #d4e5dc;overflow:hidden;">
        <tr><td style="padding:18px 22px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${inner}</table>
        </td></tr>
      </table>
    </td>
  </tr>
</table>`;
  const text = rows.map((r) => r.text).join('\n');
  return { html, text };
}

/** Admin: new internal (staff-created) booking record */
function newInternalBookingAdmin(payload) {
  const rows = [
    detailRow('Guest', payload.guestName),
    detailRow('Email', payload.guestEmail || '—'),
    detailRow('Phone', payload.guestPhone || '—'),
    detailRow('Type', payload.type === 'event' ? 'Event' : 'BnB'),
    detailRow('Status', payload.status || '—'),
    detailRow('Room', payload.roomName || '—'),
    detailRow('Check-in', formatDate(payload.checkIn)),
    detailRow('Check-out', formatDate(payload.checkOut)),
    detailRow('Event date', payload.type === 'event' ? formatDate(payload.eventDate) : '—'),
    detailRow('Amount', formatMoney(payload.amount)),
    detailRow('Deposit', formatMoney(payload.deposit)),
    detailRow('Booking ID', payload.bookingMongoId || '—'),
  ];
  if (payload.notes) rows.push(detailRow('Notes', payload.notes));
  rows.push(detailRow('Cancellation policy (for guests)', cancellationPolicySummary()));
  const { html: tableHtml, text: tableText } = buildDetailTable(rows);

  const blocksHtml = `<p style="margin:0 0 18px;font-size:16px;line-height:1.55;color:#243830;">A booking was created from the admin dashboard. Review the details below and update status or contact the guest as needed.</p>${tableHtml}`;
  const blocksText = `A booking was created from the admin dashboard.\n\n${tableText}`;

  return wrapLayout({
    headline: 'New staff booking',
    preheader: `${payload.guestName} · ${payload.status || ''} · ${payload.type || ''}`,
    lead: 'Recorded in your system.',
    blocksHtml,
    blocksText,
  });
}

/** Admin: new website booking request */
function newBookingRequestAdmin(payload) {
  const rows = [
    detailRow('Guest', payload.guestName),
    detailRow('Email', payload.guestEmail),
    detailRow('Phone', payload.guestPhone || '—'),
    detailRow('Room', payload.roomName || '—'),
    detailRow('Check-in', formatDate(payload.checkIn)),
    detailRow('Check-out', formatDate(payload.checkOut)),
    detailRow('Nights', String(payload.nights ?? '—')),
    detailRow('Estimated total', formatMoney(payload.totalAmount)),
    detailRow('Full amount (due on confirm)', formatMoney(confirmationDepositDue({
      total: payload.totalAmount,
      deposit: payload.deposit,
    }) || payload.totalAmount)),
    detailRow('Reference', payload.trackingCode || '—'),
    detailRow('Source', payload.source || 'website'),
  ];
  if (payload.notes) rows.push(detailRow('Guest notes', payload.notes));
  rows.push(detailRow('Cancellation policy (for guests)', cancellationPolicySummary()));
  const { html: tableHtml, text: tableText } = buildDetailTable(rows);

  const blocksHtml = `<p style="margin:0 0 18px;font-size:16px;line-height:1.55;color:#243830;">A new booking request is waiting in your dashboard. Check availability and confirm when you are ready.</p>${tableHtml}`;
  const blocksText = `A new booking request is waiting in your dashboard.\n\n${tableText}`;

  return wrapLayout({
    headline: 'New booking request',
    preheader: `${payload.guestName} · ${payload.roomName || 'Room'} · ${payload.trackingCode || ''}`,
    lead: 'Action may be required to confirm this stay.',
    blocksHtml,
    blocksText,
  });
}

/** Guest: we received your request */
function bookingRequestReceivedGuest(payload) {
  const trackUrl = trackingHint(payload.trackingCode, payload.guestEmail);
  const rows = [
    detailRow('Reference', payload.trackingCode),
    detailRow('Room', payload.roomName || '—'),
    detailRow('Check-in', formatDate(payload.checkIn)),
    detailRow('Check-out', formatDate(payload.checkOut)),
    detailRow('Estimated total', formatMoney(payload.totalAmount)),
    detailRow('Full amount (due on confirm)', formatMoney(confirmationDepositDue({
      total: payload.totalAmount,
      deposit: payload.deposit,
    }) || payload.totalAmount)),
  ];
  const { html: tableHtml, text: tableText } = buildDetailTable(rows);
  const a = accent();

  const blocksHtml = `<p style="margin:0 0 16px;font-size:17px;line-height:1.55;color:#243830;">Thank you for choosing <strong style="color:#1a2e26;">${escapeHtml(bizName())}</strong>. We have received your request and will confirm availability as soon as we can.</p>
<p style="margin:0 0 20px;padding:14px 18px;background:#fff9f0;border-radius:10px;border:1px solid #f0e6d8;font-size:15px;color:#5c5348;line-height:1.5;">Your booking is still <strong style="color:${a};">pending</strong> until you receive a confirmation from us. <strong>When we confirm, the full amount for your stay will be due at that time.</strong> Questions? Simply reply to this email.</p>
${tableHtml}
${cancellationPolicyPendingGuestHtml()}`;
  const blocksText = `Thank you for choosing ${bizName()}. We have received your request and will confirm availability shortly.\n\nYour booking is pending until we send a confirmation.\n\n${tableText}\n\nPayment & cancellation:\n${cancellationPolicyPendingGuestText()}`;

  return wrapLayout({
    headline: "We've received your request",
    preheader: `Ref ${payload.trackingCode} · ${payload.roomName || 'Stay'}`,
    lead: `Hi ${payload.guestName},`,
    blocksHtml,
    blocksText,
    cta: trackUrl ? { href: trackUrl, label: 'Track your booking' } : undefined,
  });
}

function lineItemsHtml(lineItems) {
  const a = accent();
  const head = `<tr style="background:${accentSoft()};">
    <th align="left" style="padding:12px 14px;font-size:11px;font-weight:700;color:${a};letter-spacing:0.08em;text-transform:uppercase;border-bottom:2px solid #c5ddd0;">Description</th>
    <th align="right" style="padding:12px 14px;font-size:11px;font-weight:700;color:${a};letter-spacing:0.08em;text-transform:uppercase;border-bottom:2px solid #c5ddd0;">Amount</th>
  </tr>`;
  const items = (lineItems || [])
    .map(
      (li) =>
        `<tr>
          <td style="padding:14px;border-bottom:1px solid #e8f0ec;font-size:15px;color:#243830;">${escapeHtml(li.description || 'Item')}</td>
          <td style="padding:14px;border-bottom:1px solid #e8f0ec;font-size:15px;text-align:right;white-space:nowrap;font-weight:600;color:#1a2e26;">${formatMoneyHtml(
            li.total != null ? li.total : (coerceNumber(li.qty) || 1) * (coerceNumber(li.unitPrice) || 0),
          )}</td>
        </tr>`,
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 0;border-radius:12px;overflow:hidden;border:1px solid #d4e5dc;">${head}${items}</table>`;
}

function lineItemsText(lineItems) {
  return (lineItems || [])
    .map((li) => {
      const lt = coerceNumber(li.total);
      const amt = Number.isFinite(lt)
        ? lt
        : (coerceNumber(li.qty) || 1) * (coerceNumber(li.unitPrice) || 0);
      return `  • ${li.description || 'Item'}: ${formatMoney(amt)}`;
    })
    .join('\n');
}

/** Guest: booking confirmed + invoice summary */
function bookingConfirmedInvoiceGuest(payload) {
  const grandTotal = invoiceNumericTotal(payload);
  const depositDue = confirmationDepositDue(payload);
  const bal = invoiceBalanceAmount(payload);

  const depositSummaryHtml = buildConfirmationDepositSummaryHtml(payload);
  const depositSummaryText = buildConfirmationDepositSummaryText(payload);
  const bankPaymentHtml = buildBankPaymentInstructionsHtml(payload.trackingCode);
  const bankPaymentText = buildBankPaymentInstructionsText(payload.trackingCode);
  const cancellationHtml = cancellationPolicyGuestHtml(payload);
  const cancellationText = cancellationPolicyGuestText(payload);

  const ref = payload.trackingCode ? detailRow('Booking ref', payload.trackingCode) : null;
  const rows = [
    ...(ref ? [ref] : []),
    detailRow('Invoice', payload.invoiceNumber),
    detailMoneyRow('Total for stay', grandTotal),
    detailMoneyRow('Deposit (full amount due)', depositDue),
  ];
  if (bal > 0.009) {
    rows.push(detailMoneyRow('Balance still due', bal));
  }
  if (payload.dueDate) {
    rows.push(detailRow('Payment due by', formatDate(payload.dueDate)));
  }
  const { html: metaHtml, text: metaText } = buildDetailTable(rows);

  const itemsHtml = lineItemsHtml(payload.lineItems);
  const itemsText = lineItemsText(payload.lineItems) || '  (see total)';

  const guestNotes = guestFacingInvoiceNotes(payload.notes);
  const notesBlock = guestNotes
    ? `<p style="margin:20px 0 0;padding:16px 18px;background:#faf8f5;border-radius:12px;font-size:14px;line-height:1.55;color:#3a3a3a;border:1px solid #ebe6df;"><span style="font-size:11px;font-weight:700;color:${accent()};letter-spacing:0.06em;text-transform:uppercase;display:block;margin-bottom:6px;">Note</span>${escapeHtml(guestNotes)}</p>`
    : '';
  const notesText = guestNotes ? `\nNote: ${guestNotes}` : '';

  const site = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
  const payNowUrl =
    (payload.payNowUrl && String(payload.payNowUrl).trim()) ||
    guestPayNowPageUrl(payload.email, payload.trackingCode) ||
    '';
  const cta = payNowUrl
    ? { href: payNowUrl, label: 'Pay now' }
    : site
      ? { href: site, label: 'Visit our website' }
      : undefined;

  const payNowHtml = payNowUrl
    ? `<p style="margin:20px 0 0;font-size:14px;line-height:1.55;color:#5a6a62;">You can also pay online (card) using the <strong>Pay now</strong> button below, or open: <a href="${escapeHtml(payNowUrl)}" style="color:${accent()};word-break:break-all;">${escapeHtml(payNowUrl)}</a></p>`
    : '';
  const payNowText = payNowUrl ? `\nPay online (optional): ${payNowUrl}\n` : '';

  const a = accent();
  const soft = accentSoft();
  const totalBanner = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 0;border-collapse:separate;border-radius:12px;border:1px solid #c5ddd0;overflow:hidden;">
  <tr>
    <td bgcolor="${soft}" width="100%" style="background-color:${soft};padding:20px 22px;">
      <p style="margin:0;font-size:13px;color:${muted()};font-family:system-ui,-apple-system,sans-serif;">Total for your stay</p>
      <p style="margin:8px 0 0;font-size:28px;line-height:1.15;font-weight:700;color:#1a2e26;font-family:Georgia,'Times New Roman',serif;">${formatMoneyHtml(grandTotal)}</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:16px 0 0;">
        <tr><td style="height:1px;background-color:#c5ddd0;font-size:1px;line-height:1px;">&nbsp;</td></tr>
      </table>
      <p style="margin:14px 0 0;font-size:15px;line-height:1.45;color:#243830;font-family:system-ui,-apple-system,sans-serif;"><strong style="color:#1a2e26;">Deposit (full amount due):</strong> ${formatMoneyHtml(depositDue)}</p>
      ${bal > 0.009 ? `<p style="margin:8px 0 0;font-size:15px;line-height:1.45;color:#243830;font-family:system-ui,-apple-system,sans-serif;"><strong style="color:#1a2e26;">Balance still due:</strong> ${formatMoneyHtml(bal)}</p>` : ''}
    </td>
  </tr>
</table>`;

  const blocksHtml = `<p style="margin:0 0 18px;font-size:17px;line-height:1.55;color:#243830;">Wonderful news — your stay is <strong style="color:${a};">confirmed</strong>. Please read the <strong>deposit, payment, and cancellation</strong> details below.</p>
${depositSummaryHtml}
${bankPaymentHtml}
${cancellationHtml}
<h2 style="margin:32px 0 12px;font-family:Georgia,serif;font-size:20px;font-weight:600;color:#1a2e26;letter-spacing:-0.02em;">Booking summary</h2>
${metaHtml}
<h2 style="margin:32px 0 12px;font-family:Georgia,serif;font-size:20px;font-weight:600;color:#1a2e26;letter-spacing:-0.02em;">Invoice details</h2>
${itemsHtml}
${totalBanner}
${payNowHtml}
${notesBlock}`;

  const blocksText = `Wonderful news — your stay is confirmed.

YOUR DEPOSIT
${depositSummaryText}

${bankPaymentText}

${cancellationText}
${payNowText}

BOOKING SUMMARY
${metaText}

Invoice lines:
${itemsText}

Total for stay: ${formatMoney(grandTotal)}
Deposit (full amount due): ${formatMoney(depositDue)}${bal > 0.009 ? `\nBalance still due: ${formatMoney(bal)}` : ''}${notesText}`;

  return wrapLayout({
    headline: 'Booking confirmed',
    preheader: `Invoice ${payload.invoiceNumber} · ${formatMoney(grandTotal)}`,
    lead: `Hi ${payload.guestName},`,
    blocksHtml,
    blocksText,
    cta,
  });
}

module.exports = {
  bizName,
  newInternalBookingAdmin,
  newBookingRequestAdmin,
  bookingRequestReceivedGuest,
  bookingConfirmedInvoiceGuest,
  buildBankPaymentInstructionsText,
  buildBankPaymentInstructionsHtml,
  buildConfirmationDepositSummaryText,
  bookingBankDetails,
  bookingPopContacts,
  cancellationPolicyText,
  cancellationPolicyTextForBooking,
  confirmationDepositDue,
  invoiceGrandTotal: invoiceNumericTotal,
  formatMoney,
  formatDate,
  escapeHtml,
};
