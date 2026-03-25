/**
 * Optional email (SMTP) and WhatsApp Cloud API delivery after an invoice is created.
 * Misconfiguration or provider errors are logged; they do not fail booking confirmation.
 */
const nodemailer = require('nodemailer');

function mailConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function whatsappConfigured() {
  return !!(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

function getTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

/** E.164-like digits only; common ZA: leading 0 → 27 */
function normalizeWhatsAppPhone(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('0')) digits = `27${digits.slice(1)}`;
  if (digits.length < 10 || digits.length > 15) return null;
  return digits;
}

function buildEmailLines(payload) {
  const lines = (payload.lineItems || [])
    .map((li) => `  • ${li.description}: ${formatMoney(li.total != null ? li.total : (li.qty || 1) * (li.unitPrice || 0))}`)
    .join('\n');
  return lines || '  (see total below)';
}

function formatMoney(n) {
  const v = Number(n) || 0;
  return `R ${v.toFixed(2)}`;
}

function buildPlainBody(payload) {
  const biz = process.env.BUSINESS_NAME || 'Valleyroad';
  const ref = payload.trackingCode ? `Booking ref: ${payload.trackingCode}\n` : '';
  return [
    `Hi ${payload.guestName},`,
    '',
    `Thank you for your booking. Your invoice ${payload.invoiceNumber} is ready.`,
    '',
    ref,
    buildEmailLines(payload),
    '',
    `Total: ${formatMoney(payload.total)}`,
    payload.notes ? `\n${payload.notes}` : '',
    payload.dueDate ? `\nDue date: ${new Date(payload.dueDate).toISOString().slice(0, 10)}` : '',
    payload.frontendUrl ? `\nMore info: ${payload.frontendUrl}` : '',
    '',
    `— ${biz}`,
  ].join('\n');
}

function buildHtmlBody(payload) {
  const biz = process.env.BUSINESS_NAME || 'Valleyroad';
  const ref = payload.trackingCode
    ? `<p><strong>Booking ref:</strong> ${escapeHtml(payload.trackingCode)}</p>`
    : '';
  const items = (payload.lineItems || [])
    .map(
      (li) =>
        `<tr><td>${escapeHtml(li.description || '')}</td><td style="text-align:right">${formatMoney(
          li.total != null ? li.total : (li.qty || 1) * (li.unitPrice || 0),
        )}</td></tr>`,
    )
    .join('');
  return `<p>Hi ${escapeHtml(payload.guestName)},</p>
<p>Thank you for your booking. Invoice <strong>${escapeHtml(payload.invoiceNumber)}</strong> is attached below.</p>
${ref}
<table style="border-collapse:collapse;width:100%;max-width:480px">${items}</table>
<p><strong>Total:</strong> ${formatMoney(payload.total)}</p>
${payload.notes ? `<p>${escapeHtml(payload.notes)}</p>` : ''}
${payload.dueDate ? `<p><strong>Due:</strong> ${escapeHtml(new Date(payload.dueDate).toISOString().slice(0, 10))}</p>` : ''}
${payload.frontendUrl ? `<p><a href="${escapeHtml(payload.frontendUrl)}">Visit our site</a></p>` : ''}
<p>— ${escapeHtml(biz)}</p>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function deliverInvoiceEmail(payload) {
  const to = (payload.email || '').trim();
  if (!to || !mailConfigured()) {
    return { skipped: true, reason: !to ? 'no_email' : 'smtp_not_configured' };
  }
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  const subject = `${process.env.BUSINESS_NAME || 'Booking'} — Invoice ${payload.invoiceNumber}`;
  const transporter = getTransporter();
  await transporter.sendMail({
    from,
    to,
    subject,
    text: buildPlainBody(payload),
    html: buildHtmlBody(payload),
  });
  return { sent: true, channel: 'email' };
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
 * }} payload
 */
function scheduleInvoiceDelivery(payload) {
  const frontendUrl = process.env.FRONTEND_URL;
  const full = { ...payload, frontendUrl };
  setImmediate(() => {
    deliverInvoiceEmail(full).catch((err) => {
      console.error('[invoice-notify] email failed:', err.message);
    });
    deliverInvoiceWhatsApp(full).catch((err) => {
      console.error('[invoice-notify] whatsapp failed:', err.message);
    });
  });
}

module.exports = {
  scheduleInvoiceDelivery,
  mailConfigured,
  whatsappConfigured,
  normalizeWhatsAppPhone,
};
