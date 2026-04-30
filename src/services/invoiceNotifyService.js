/**
 * Optional email (SMTP / Gmail app password / Gmail OAuth) and WhatsApp for bookings & invoices.
 * Misconfiguration or provider errors are logged; they do not fail API responses.
 */
const nodemailer = require('nodemailer');
const mailTemplates = require('./mailTemplates');
const { logOutboundEmail } = require('./emailLogService');

function smtpConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function gmailAppPasswordRaw() {
  return (
    process.env.GMAIL_APP_PASSWORD ||
    process.env.GMAIL_PASSWORD ||
    process.env.GOOGLE_APP_PASSWORD ||
    ''
  );
}

/** Gmail SMTP with App Password (2FA required; not your normal Google sign-in password). */
function gmailAppPasswordConfigured() {
  return !!(process.env.GMAIL_USER?.trim() && gmailAppPasswordRaw().trim());
}

/** Gmail via OAuth2 (needs one-time consent → GMAIL_REFRESH_TOKEN). */
function gmailOAuthConfigured() {
  return !!(
    process.env.GMAIL_USER &&
    process.env.GMAIL_CLIENT_ID &&
    process.env.GMAIL_CLIENT_SECRET &&
    process.env.GMAIL_REFRESH_TOKEN
  );
}

function mailConfigured() {
  return smtpConfigured() || gmailAppPasswordConfigured() || gmailOAuthConfigured();
}

function whatsappConfigured() {
  return !!(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

/** Comma-separated admin inboxes for new guest booking alerts */
function adminBookingNotifyEmails() {
  const raw = process.env.BOOKING_ADMIN_EMAIL || process.env.BOOKING_NOTIFY_EMAIL || '';
  return raw
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
}

function adminBookingNotifyConfigured() {
  return adminBookingNotifyEmails().length > 0;
}

function getMailFrom() {
  if (process.env.MAIL_FROM) return process.env.MAIL_FROM;
  if (gmailAppPasswordConfigured() || gmailOAuthConfigured()) return process.env.GMAIL_USER.trim();
  return process.env.SMTP_USER;
}

function gmailAppPasswordPlain() {
  return gmailAppPasswordRaw().replace(/\s+/g, '');
}

function getTransporter() {
  if (gmailAppPasswordConfigured()) {
    const gmailMode = String(process.env.GMAIL_SMTP_MODE || 'auto').trim().toLowerCase();
    const use465 = gmailMode === '465';
    return nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: use465 ? 465 : 587,
      secure: use465,
      connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 30000),
      greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS || 20000),
      socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 60000),
      auth: {
        user: process.env.GMAIL_USER.trim(),
        pass: gmailAppPasswordPlain(),
      },
    });
  }
  if (gmailOAuthConfigured()) {
    return nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 30000),
      greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS || 20000),
      socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 60000),
      auth: {
        type: 'OAuth2',
        user: process.env.GMAIL_USER.trim(),
        clientId: process.env.GMAIL_CLIENT_ID.trim(),
        clientSecret: process.env.GMAIL_CLIENT_SECRET.trim(),
        refreshToken: process.env.GMAIL_REFRESH_TOKEN.trim(),
      },
    });
  }
  if (smtpConfigured()) {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 30000),
      greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS || 20000),
      socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 60000),
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  throw new Error('No mail transport configured');
}

function isConnectivityError(err) {
  const msg = String(err?.message || '').toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('network')
  );
}

function gmailAppPasswordFallbackTransporters() {
  if (!gmailAppPasswordConfigured()) return [];
  const gmailMode = String(process.env.GMAIL_SMTP_MODE || 'auto').trim().toLowerCase();
  const user = process.env.GMAIL_USER.trim();
  const pass = gmailAppPasswordPlain();
  const base = {
    host: 'smtp.gmail.com',
    auth: { user, pass },
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 30000),
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS || 20000),
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 60000),
  };
  const candidates = [
    {
      label: 'gmail_app_password_587',
      transporter: nodemailer.createTransport({ ...base, port: 587, secure: false }),
    },
    {
      label: 'gmail_app_password_465',
      transporter: nodemailer.createTransport({ ...base, port: 465, secure: true }),
    },
  ];
  if (gmailMode === '587') return candidates.filter((c) => c.label.endsWith('_587'));
  if (gmailMode === '465') return candidates.filter((c) => c.label.endsWith('_465'));
  return candidates;
}

async function verifyWithFallback() {
  const candidates = gmailAppPasswordFallbackTransporters();
  if (!candidates.length) {
    const transporter = getTransporter();
    await transporter.verify();
    return { ok: true, mode: 'single' };
  }
  let lastErr = null;
  for (const c of candidates) {
    try {
      await c.transporter.verify();
      return { ok: true, mode: c.label };
    } catch (err) {
      lastErr = err;
      if (!isConnectivityError(err)) break;
    }
  }
  throw lastErr || new Error('Mail verify failed');
}

function mailTransportSummary() {
  if (gmailAppPasswordConfigured()) {
    return {
      provider: 'gmail_app_password',
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      user: process.env.GMAIL_USER ? process.env.GMAIL_USER.trim() : '',
    };
  }
  if (gmailOAuthConfigured()) {
    return {
      provider: 'gmail_oauth2',
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      user: process.env.GMAIL_USER ? process.env.GMAIL_USER.trim() : '',
    };
  }
  if (smtpConfigured()) {
    return {
      provider: 'smtp',
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      user: process.env.SMTP_USER || '',
    };
  }
  return {
    provider: 'none',
    host: null,
    port: null,
    secure: null,
    user: '',
  };
}

async function verifyMailConnection() {
  if (!mailConfigured()) {
    return { ok: false, skipped: true, reason: 'mail_not_configured', summary: mailTransportSummary() };
  }
  const summary = mailTransportSummary();
  try {
    const verified = await verifyWithFallback();
    return { ok: true, skipped: false, summary: { ...summary, mode: verified.mode } };
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      summary,
      error: err?.message || String(err),
    };
  }
}

/** E.164-like digits only; common ZA: leading 0 → 27 */
function normalizeWhatsAppPhone(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('0')) digits = `27${digits.slice(1)}`;
  if (digits.length < 10 || digits.length > 15) return null;
  return digits;
}

function formatMoney(n) {
  const v = Number(n) || 0;
  return `R ${v.toFixed(2)}`;
}

/**
 * @param {{
 *   to: string,
 *   subject: string,
 *   html: string,
 *   text: string,
 *   templateKey: string,
 *   relatedModel?: 'GuestBooking'|'Booking',
 *   relatedId?: import('mongoose').Types.ObjectId,
 * }} opts
 */
async function sendMail({ to, subject, html, text, templateKey, relatedModel, relatedId }) {
  const from = getMailFrom() || '';
  const base = { templateKey, subject, from, textPreview: text || '' };

  if (!to || !mailConfigured()) {
    const skipReason = !to ? 'no_recipient' : 'mail_not_configured';
    await logOutboundEmail({
      ...base,
      status: 'skipped',
      skipReason,
      to: to || '',
      relatedModel,
      relatedId,
    });
    return { skipped: true, reason: skipReason };
  }

  try {
    let info;
    const candidates = gmailAppPasswordFallbackTransporters();
    if (candidates.length) {
      let lastErr = null;
      for (const c of candidates) {
        try {
          info = await c.transporter.sendMail({ from, to, subject, text, html });
          break;
        } catch (err) {
          lastErr = err;
          if (!isConnectivityError(err)) throw err;
        }
      }
      if (!info && lastErr) throw lastErr;
    } else {
      const transporter = getTransporter();
      info = await transporter.sendMail({ from, to, subject, text, html });
    }
    await logOutboundEmail({
      ...base,
      status: 'sent',
      to,
      messageId: info.messageId,
      relatedModel,
      relatedId,
    });
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    await logOutboundEmail({
      ...base,
      status: 'failed',
      to,
      errorMessage: err.message,
      relatedModel,
      relatedId,
    });
    throw err;
  }
}

async function deliverInvoiceEmail(payload) {
  const to = (payload.email || '').trim();
  const { html, text } = mailTemplates.bookingConfirmedInvoiceGuest(payload);
  const biz = mailTemplates.bizName();
  const subject = `${biz} — Booking confirmed · Invoice ${payload.invoiceNumber}`;
  const result = await sendMail({
    to,
    subject,
    html,
    text,
    templateKey: 'booking_confirmed_invoice',
    relatedModel: payload.relatedModel,
    relatedId: payload.relatedId,
  });
  if (result.skipped) return { ...result, channel: 'email' };
  return { sent: true, channel: 'email' };
}

async function deliverNewBookingAdminEmail(payload) {
  const recipients = adminBookingNotifyEmails();
  const { html, text } = mailTemplates.newBookingRequestAdmin(payload);
  const biz = mailTemplates.bizName();
  const subject = `${biz} — New booking request · ${payload.trackingCode || 'ref pending'}`;
  const relatedId = payload.guestBookingId;

  if (!recipients.length) {
    await logOutboundEmail({
      templateKey: 'guest_booking_request_admin',
      status: 'skipped',
      skipReason: 'admin_email_not_configured',
      from: getMailFrom() || '',
      to: '',
      subject,
      textPreview: text,
      relatedModel: 'GuestBooking',
      relatedId,
    });
    return { skipped: true, reason: 'admin_email_not_configured' };
  }
  if (!mailConfigured()) {
    await logOutboundEmail({
      templateKey: 'guest_booking_request_admin',
      status: 'skipped',
      skipReason: 'mail_not_configured',
      from: '',
      to: recipients.join(', '),
      subject,
      textPreview: text,
      relatedModel: 'GuestBooking',
      relatedId,
    });
    return { skipped: true, reason: 'mail_not_configured' };
  }

  for (const to of recipients) {
    await sendMail({
      to,
      subject,
      html,
      text,
      templateKey: 'guest_booking_request_admin',
      relatedModel: 'GuestBooking',
      relatedId,
    });
  }
  return { sent: true, channel: 'email', toCount: recipients.length };
}

async function deliverBookingRequestGuestEmail(payload) {
  const to = (payload.guestEmail || '').trim();
  const { html, text } = mailTemplates.bookingRequestReceivedGuest(payload);
  const biz = mailTemplates.bizName();
  const subject = `${biz} — We received your booking request`;
  return sendMail({
    to,
    subject,
    html,
    text,
    templateKey: 'guest_booking_request_guest',
    relatedModel: 'GuestBooking',
    relatedId: payload.guestBookingId,
  });
}

async function deliverInternalBookingCreatedAdminEmail(payload) {
  const recipients = adminBookingNotifyEmails();
  const { html, text } = mailTemplates.newInternalBookingAdmin(payload);
  const biz = mailTemplates.bizName();
  const subject = `${biz} — New staff booking · ${payload.status || 'pending'}`;
  const relatedId = payload.relatedId;

  if (!recipients.length) {
    await logOutboundEmail({
      templateKey: 'internal_booking_created_admin',
      status: 'skipped',
      skipReason: 'admin_email_not_configured',
      from: getMailFrom() || '',
      to: '',
      subject,
      textPreview: text,
      relatedModel: 'Booking',
      relatedId,
    });
    return { skipped: true, reason: 'admin_email_not_configured' };
  }
  if (!mailConfigured()) {
    await logOutboundEmail({
      templateKey: 'internal_booking_created_admin',
      status: 'skipped',
      skipReason: 'mail_not_configured',
      from: '',
      to: recipients.join(', '),
      subject,
      textPreview: text,
      relatedModel: 'Booking',
      relatedId,
    });
    return { skipped: true, reason: 'mail_not_configured' };
  }

  for (const to of recipients) {
    await sendMail({
      to,
      subject,
      html,
      text,
      templateKey: 'internal_booking_created_admin',
      relatedModel: 'Booking',
      relatedId,
    });
  }
  return { sent: true, channel: 'email', toCount: recipients.length };
}

async function graphSendMessage(messageBody) {
  const v = process.env.WHATSAPP_API_VERSION || 'v21.0';
  const id = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const url = `https://graph.facebook.com/${v}/${id}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    ...messageBody,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

async function deliverInvoiceWhatsApp(payload) {
  const raw = payload.phone;
  const to = normalizeWhatsAppPhone(raw);
  if (!to || !whatsappConfigured()) {
    return { skipped: true, reason: !to ? 'no_phone' : 'whatsapp_not_configured' };
  }

  const templateName = process.env.WHATSAPP_TEMPLATE_NAME;
  const templateLang = process.env.WHATSAPP_TEMPLATE_LANG || 'en_US';

  if (templateName) {
    const parameters = [
      payload.guestName,
      payload.invoiceNumber,
      formatMoney(payload.total),
      payload.notes ? String(payload.notes).slice(0, 80) : '—',
    ].map((text) => ({ type: 'text', text: String(text).slice(0, 1024) }));

    await graphSendMessage({
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: templateLang },
        components: [{ type: 'body', parameters }],
      },
    });
    return { sent: true, channel: 'whatsapp_template' };
  }

  const text = [
    `Hi ${payload.guestName}, your invoice ${payload.invoiceNumber} is ready.`,
    `Total: ${formatMoney(payload.total)}.`,
    payload.trackingCode ? `Ref: ${payload.trackingCode}.` : '',
    payload.notes ? String(payload.notes).slice(0, 500) : '',
  ]
    .filter(Boolean)
    .join(' ');

  await graphSendMessage({
    to,
    type: 'text',
    text: { preview_url: false, body: text.slice(0, 4096) },
  });
  return { sent: true, channel: 'whatsapp_text' };
}

/**
 * @param {{
 *   guestName: string,
 *   email?: string,
 *   phone?: string,
 *   invoiceNumber: string,
 *   total: number,
 *   notes?: string,
 *   dueDate?: Date,
 *   lineItems?: Array<{ description?: string, qty?: number, unitPrice?: number, total?: number }>,
 *   trackingCode?: string,
 *   relatedModel?: 'GuestBooking'|'Booking',
 *   relatedId?: import('mongoose').Types.ObjectId,
 * }} payload
 */
function scheduleInvoiceDelivery(payload) {
  const full = { ...payload };
  setImmediate(() => {
    deliverInvoiceEmail(full).catch((err) => {
      console.error('[invoice-notify] invoice email failed:', err.message);
    });
    deliverInvoiceWhatsApp(full).catch((err) => {
      console.error('[invoice-notify] whatsapp failed:', err.message);
    });
  });
}

/**
 * Send invoice notifications immediately to selected channels.
 * @param {object} payload
 * @param {{ channels?: Array<'email'|'whatsapp'> }} [opts]
 */
async function sendInvoiceDeliveryNow(payload, opts = {}) {
  const requested = Array.isArray(opts.channels) && opts.channels.length ? opts.channels : ['email', 'whatsapp'];
  const channels = [...new Set(requested.map((c) => String(c).toLowerCase()))].filter((c) =>
    ['email', 'whatsapp'].includes(c)
  );
  const results = {};
  if (channels.includes('email')) {
    try {
      results.email = await deliverInvoiceEmail(payload);
    } catch (err) {
      results.email = { sent: false, error: err.message };
    }
  }
  if (channels.includes('whatsapp')) {
    try {
      results.whatsapp = await deliverInvoiceWhatsApp(payload);
    } catch (err) {
      results.whatsapp = { sent: false, error: err.message };
    }
  }
  return results;
}

/**
 * After a public guest booking is submitted (pending): notify admins + guest.
 * @param {{
 *   guestName: string,
 *   guestEmail: string,
 *   guestPhone?: string,
 *   roomName?: string,
 *   roomType?: string,
 *   checkIn?: Date,
 *   checkOut?: Date,
 *   nights?: number,
 *   totalAmount?: number,
 *   deposit?: number,
 *   trackingCode: string,
 *   notes?: string,
 *   source?: string,
 *   guestBookingId?: import('mongoose').Types.ObjectId,
 * }} payload
 */
function scheduleNewGuestBookingEmails(payload) {
  setImmediate(() => {
    deliverNewBookingAdminEmail(payload).catch((err) => {
      console.error('[booking-notify] admin email failed:', err.message);
    });
    deliverBookingRequestGuestEmail(payload).catch((err) => {
      console.error('[booking-notify] guest request email failed:', err.message);
    });
  });
}

/**
 * After staff creates an internal Booking (any status): notify admins.
 * @param {Record<string, unknown>} bookingLean - populated room, from withRoomPreview
 */
function scheduleInternalBookingCreatedAdmin(bookingLean) {
  if (!bookingLean || !bookingLean._id) return;
  const payload = {
    guestName: bookingLean.guestName,
    guestEmail: bookingLean.guestEmail,
    guestPhone: bookingLean.guestPhone,
    type: bookingLean.type,
    roomName: bookingLean.roomName,
    roomType: bookingLean.roomType,
    checkIn: bookingLean.checkIn,
    checkOut: bookingLean.checkOut,
    eventDate: bookingLean.eventDate,
    amount: bookingLean.amount,
    deposit: bookingLean.deposit,
    status: bookingLean.status,
    notes: bookingLean.notes,
    bookingMongoId: String(bookingLean._id),
    relatedId: bookingLean._id,
  };
  setImmediate(() => {
    deliverInternalBookingCreatedAdminEmail(payload).catch((err) => {
      console.error('[booking-notify] internal booking admin email failed:', err.message);
    });
  });
}

module.exports = {
  scheduleInvoiceDelivery,
  sendInvoiceDeliveryNow,
  scheduleNewGuestBookingEmails,
  scheduleInternalBookingCreatedAdmin,
  mailConfigured,
  smtpConfigured,
  gmailAppPasswordConfigured,
  gmailOAuthConfigured,
  whatsappConfigured,
  adminBookingNotifyConfigured,
  normalizeWhatsAppPhone,
  verifyMailConnection,
  mailTransportSummary,
};
