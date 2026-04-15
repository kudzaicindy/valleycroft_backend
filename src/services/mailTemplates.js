/**
 * Branded HTML + plain-text bodies for booking lifecycle emails.
 * Tables + inline styles for broad client support.
 */

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

const DEFAULT_CANCELLATION_POLICY =
  'Your deposit is due as soon as your booking is confirmed. From the time you receive this confirmation email, you have 48 hours to cancel at no charge. If you cancel after those 48 hours, only 50% of what you have paid or owe will be refunded (as applicable).';

/** Full policy text for guest emails; override with MAIL_CANCELLATION_POLICY in .env */
function cancellationPolicyText() {
  const custom = (process.env.MAIL_CANCELLATION_POLICY || '').trim();
  return custom || DEFAULT_CANCELLATION_POLICY;
}

/** Pending-request email (before confirmation): no “this confirmation” yet */
const PENDING_REQUEST_CANCELLATION_POLICY =
  'When we confirm your booking, your deposit will be due at that time. From the moment you receive our confirmation email, you will have 48 hours to cancel free of charge; after that 48-hour period, only a 50% refund applies.';

function cancellationPolicyPendingGuestText() {
  const custom = (process.env.MAIL_CANCELLATION_POLICY_PENDING || '').trim();
  return custom || PENDING_REQUEST_CANCELLATION_POLICY;
}

function cancellationPolicyPendingGuestHtml() {
  const t = cancellationPolicyPendingGuestText();
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

/** Short line for admin notification emails */
function cancellationPolicySummary() {
  return 'Deposit due upon confirmation; free cancellation within 48h after confirmation email, then 50% refund only.';
}

function cancellationPolicyGuestHtml() {
  const t = cancellationPolicyText();
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

function cancellationPolicyGuestText() {
  return `Deposit & cancellation:\n${cancellationPolicyText()}`;
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
  const cap = invoiceNumericTotal(payload);
  const d = coerceNumber(payload.deposit);
  if (!Number.isFinite(d) || d < 0) return 0;
  return Math.min(d, cap);
}

function invoiceBalanceAmount(payload) {
  const fromPayload = coerceNumber(payload.balanceDue);
  if (Number.isFinite(fromPayload) && fromPayload >= 0) return fromPayload;
  return Math.max(0, invoiceNumericTotal(payload) - invoiceDepositAmount(payload));
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
    detailRow('Deposit (est.)', formatMoney(payload.deposit)),
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
    detailRow('Deposit (est.)', formatMoney(payload.deposit)),
  ];
  const { html: tableHtml, text: tableText } = buildDetailTable(rows);
  const a = accent();

  const blocksHtml = `<p style="margin:0 0 16px;font-size:17px;line-height:1.55;color:#243830;">Thank you for choosing <strong style="color:#1a2e26;">${escapeHtml(bizName())}</strong>. We have received your request and will confirm availability as soon as we can.</p>
<p style="margin:0 0 20px;padding:14px 18px;background:#fff9f0;border-radius:10px;border:1px solid #f0e6d8;font-size:15px;color:#5c5348;line-height:1.5;">Your booking is still <strong style="color:${a};">pending</strong> until you receive a confirmation from us. <strong>When we confirm, your deposit will be due at that time.</strong> Questions? Simply reply to this email.</p>
${tableHtml}
${cancellationPolicyPendingGuestHtml()}`;
  const blocksText = `Thank you for choosing ${bizName()}. We have received your request and will confirm availability shortly.\n\nYour booking is pending until we send a confirmation.\n\n${tableText}\n\nDeposit & cancellation:\n${cancellationPolicyPendingGuestText()}`;

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
  const dep = invoiceDepositAmount(payload);
  const bal = invoiceBalanceAmount(payload);

  const ref = payload.trackingCode ? detailRow('Booking ref', payload.trackingCode) : null;
  const rows = [
    ...(ref ? [ref] : []),
    detailRow('Invoice', payload.invoiceNumber),
    detailMoneyRow('Total for stay', grandTotal),
    detailMoneyRow('Deposit (due upon confirmation)', dep),
    detailMoneyRow('Balance after deposit', bal),
  ];
  if (payload.dueDate) {
    rows.push(detailRow('Balance due by', formatDate(payload.dueDate)));
  }
  const { html: metaHtml, text: metaText } = buildDetailTable(rows);

  const itemsHtml = lineItemsHtml(payload.lineItems);
  const itemsText = lineItemsText(payload.lineItems) || '  (see total)';

  const notesBlock = payload.notes
    ? `<p style="margin:20px 0 0;padding:16px 18px;background:#faf8f5;border-radius:12px;font-size:14px;line-height:1.55;color:#3a3a3a;border:1px solid #ebe6df;"><span style="font-size:11px;font-weight:700;color:${accent()};letter-spacing:0.06em;text-transform:uppercase;display:block;margin-bottom:6px;">Note</span>${escapeHtml(payload.notes)}</p>`
    : '';
  const notesText = payload.notes ? `\nNote: ${payload.notes}` : '';

  const site = (process.env.FRONTEND_URL || '').replace(/\/$/, '');
  const cta =
    site
      ? { href: site, label: 'Visit our website' }
      : undefined;

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
      <p style="margin:14px 0 0;font-size:15px;line-height:1.45;color:#243830;font-family:system-ui,-apple-system,sans-serif;"><strong style="color:#1a2e26;">Deposit (due upon confirmation):</strong> ${formatMoneyHtml(dep)}</p>
      <p style="margin:8px 0 0;font-size:15px;line-height:1.45;color:#243830;font-family:system-ui,-apple-system,sans-serif;"><strong style="color:#1a2e26;">Balance after deposit:</strong> ${formatMoneyHtml(bal)}</p>
    </td>
  </tr>
</table>`;

  const blocksHtml = `<p style="margin:0 0 18px;font-size:17px;line-height:1.55;color:#243830;">Wonderful news — your stay is <strong style="color:${a};">confirmed</strong>. Your <strong>deposit is due upon confirmation</strong>; please pay the deposit below. The remaining balance is due as agreed or by the date shown.</p>
${metaHtml}
<h2 style="margin:32px 0 12px;font-family:Georgia,serif;font-size:20px;font-weight:600;color:#1a2e26;letter-spacing:-0.02em;">Invoice details</h2>
${itemsHtml}
${totalBanner}
${notesBlock}
${cancellationPolicyGuestHtml()}`;

  const blocksText = `Wonderful news — your stay is confirmed. Your deposit is due upon confirmation.

${metaText}

Invoice lines:
${itemsText}

Total for stay: ${formatMoney(grandTotal)}
Deposit (due upon confirmation): ${formatMoney(dep)}
Balance after deposit: ${formatMoney(bal)}${notesText}

${cancellationPolicyGuestText()}`;

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
  cancellationPolicyText,
  invoiceGrandTotal: invoiceNumericTotal,
  formatMoney,
  formatDate,
  escapeHtml,
};
