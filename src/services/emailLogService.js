const Email = require('../models/Email');

const PREVIEW_MAX = 3500;

/**
 * Persist outbound email attempt. Never throws (logging must not break sends).
 * @param {Record<string, unknown>} doc
 */
async function logOutboundEmail(doc) {
  try {
    const textPreview =
      doc.textPreview != null ? String(doc.textPreview).slice(0, PREVIEW_MAX) : undefined;
    await Email.create({ ...doc, textPreview });
  } catch (err) {
    console.error('[email-log] persist failed:', err.message);
  }
}

module.exports = { logOutboundEmail };
