/**
 * PayFast (South Africa) — hosted checkout + ITN (Instant Transaction Notification).
 * @see https://developers.payfast.co.za/docs
 */
const crypto = require('crypto');

const SANDBOX_PROCESS_URL = 'https://sandbox.payfast.co.za/eng/process';
const LIVE_PROCESS_URL = 'https://www.payfast.co.za/eng/process';

function envBool(name, defaultValue = false) {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  if (!v) return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(v);
}

function payfastConfigured() {
  return !!(process.env.PAYFAST_MERCHANT_ID?.trim() && process.env.PAYFAST_MERCHANT_KEY?.trim());
}

function isSandbox() {
  return envBool('PAYFAST_SANDBOX', true);
}

function processUrl() {
  return isSandbox() ? SANDBOX_PROCESS_URL : LIVE_PROCESS_URL;
}

function merchantId() {
  return String(process.env.PAYFAST_MERCHANT_ID || '').trim();
}

function merchantKey() {
  return String(process.env.PAYFAST_MERCHANT_KEY || '').trim();
}

function passphrase() {
  return String(process.env.PAYFAST_PASSPHRASE || '').trim();
}

function apiPublicBase() {
  const raw =
    process.env.PAYFAST_NOTIFY_BASE_URL?.trim() ||
    process.env.API_PUBLIC_URL?.trim() ||
    process.env.BACKEND_URL?.trim() ||
    '';
  return raw.replace(/\/$/, '');
}

function frontendBase() {
  const raw = process.env.FRONTEND_URL || 'http://localhost:5173';
  return String(raw).split(',')[0].trim().replace(/\/$/, '');
}

/** Public guest site for Pay Now + PayFast return/cancel (not local dev FRONTEND_URL). */
function payNowSiteBase() {
  const raw =
    process.env.PAYNOW_SITE_URL?.trim() ||
    process.env.PAYFAST_SITE_URL?.trim() ||
    'https://www.valleycroftfarm.com';
  let base = String(raw).split(',')[0].trim().replace(/\/$/, '');
  if (base.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(base)) {
    base = `https://${base.slice('http://'.length)}`;
  } else if (!/^https?:\/\//i.test(base)) {
    base = `https://${base}`;
  }
  return base;
}

function notifyUrl() {
  if (process.env.PAYFAST_NOTIFY_URL?.trim()) {
    return process.env.PAYFAST_NOTIFY_URL.trim();
  }
  const base = apiPublicBase();
  return base ? `${base}/api/payfast/itn` : '';
}

function returnUrl() {
  if (process.env.PAYFAST_RETURN_URL?.trim()) {
    return process.env.PAYFAST_RETURN_URL.trim();
  }
  return `${payNowSiteBase()}/payment/success`;
}

function cancelUrl() {
  if (process.env.PAYFAST_CANCEL_URL?.trim()) {
    return process.env.PAYFAST_CANCEL_URL.trim();
  }
  return `${payNowSiteBase()}/payment/cancelled`;
}

/** PayFast expects amount as decimal string with 2 places. */
function formatAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new Error('Invalid PayFast amount');
  return n.toFixed(2);
}

function encodePayfastValue(value) {
  return encodeURIComponent(String(value).trim()).replace(/%20/g, '+');
}

/**
 * @param {Record<string, string|number|boolean|undefined|null>} data
 * @param {string} [passPhrase]
 */
function generateSignature(data, passPhrase) {
  const keys = Object.keys(data)
    .filter((k) => k !== 'signature')
    .sort();
  let paramString = '';
  for (const key of keys) {
    const val = data[key];
    if (val === '' || val === undefined || val === null) continue;
    paramString += `${key}=${encodePayfastValue(val)}&`;
  }
  paramString = paramString.slice(0, -1);
  const phrase = passPhrase ?? passphrase();
  if (phrase) {
    paramString += `&passphrase=${encodePayfastValue(phrase)}`;
  }
  return crypto.createHash('md5').update(paramString).digest('hex');
}

function splitGuestName(fullName) {
  const parts = String(fullName || 'Guest').trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { name_first: parts[0] || 'Guest', name_last: 'Guest' };
  return { name_first: parts[0], name_last: parts.slice(1).join(' ') };
}

/**
 * Build signed fields for PayFast hosted checkout (POST to processUrl).
 * @param {{
 *   mPaymentId: string,
 *   amount: number,
 *   itemName: string,
 *   itemDescription?: string,
 *   guestName: string,
 *   guestEmail: string,
 *   guestPhone?: string,
 * }} opts
 */
function buildCheckoutFields(opts) {
  if (!payfastConfigured()) {
    throw new Error('PayFast is not configured (PAYFAST_MERCHANT_ID, PAYFAST_MERCHANT_KEY)');
  }
  const notify = notifyUrl();
  if (!notify) {
    throw new Error(
      'PayFast notify URL missing. Set PAYFAST_NOTIFY_URL or API_PUBLIC_URL (public HTTPS backend base).',
    );
  }

  const { name_first, name_last } = splitGuestName(opts.guestName);
  const fields = {
    merchant_id: merchantId(),
    merchant_key: merchantKey(),
    return_url: returnUrl(),
    cancel_url: cancelUrl(),
    notify_url: notify,
    name_first,
    name_last,
    email_address: String(opts.guestEmail || '').trim().toLowerCase(),
    m_payment_id: String(opts.mPaymentId),
    amount: formatAmount(opts.amount),
    item_name: String(opts.itemName || 'Valley Croft booking').slice(0, 127),
  };
  if (opts.itemDescription) {
    fields.item_description = String(opts.itemDescription).slice(0, 255);
  }
  if (opts.guestPhone) {
    fields.cell_number = String(opts.guestPhone).replace(/\s+/g, '');
  }
  fields.signature = generateSignature(fields);
  return fields;
}

/**
 * Verify ITN POST body from PayFast.
 * @param {Record<string, string>} postData
 */
function verifyItnSignature(postData) {
  const received = String(postData.signature || '').trim();
  if (!received) return false;
  const expected = generateSignature(postData);
  return received.toLowerCase() === expected.toLowerCase();
}

function guestPayNowPageUrl(guestEmail, trackingCode) {
  if (!guestEmail || !trackingCode) return null;
  const base = payNowSiteBase();
  const q = new URLSearchParams({
    email: String(guestEmail).trim().toLowerCase(),
    ref: String(trackingCode).trim(),
  });
  return `${base}/pay?${q.toString()}`;
}

module.exports = {
  payfastConfigured,
  isSandbox,
  processUrl,
  merchantId,
  formatAmount,
  generateSignature,
  buildCheckoutFields,
  verifyItnSignature,
  notifyUrl,
  returnUrl,
  cancelUrl,
  payNowSiteBase,
  guestPayNowPageUrl,
};
