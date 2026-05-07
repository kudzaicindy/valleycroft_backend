/**
 * Send mail via Gmail REST API (HTTPS only). Works on hosts that block SMTP (e.g. Render Free).
 * Uses the same OAuth credentials as Gmail SMTP: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN.
 * Requires Gmail API enabled in Google Cloud + OAuth scopes including gmail.send or https://mail.google.com/
 */
const nodemailer = require('nodemailer');
const { google } = require('googleapis');

const OAUTH_PLAYGROUND_REDIRECT = 'https://developers.google.com/oauthplayground';

let oauth2Client;
let streamTransport;

function getGmailOAuth2Client() {
  if (!oauth2Client) {
    const clientId = process.env.GMAIL_CLIENT_ID?.trim();
    const clientSecret = process.env.GMAIL_CLIENT_SECRET?.trim();
    const refreshToken = process.env.GMAIL_REFRESH_TOKEN?.trim();
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error('Gmail OAuth env incomplete (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN)');
    }
    oauth2Client = new google.auth.OAuth2(
      clientId,
      clientSecret,
      process.env.GMAIL_OAUTH_REDIRECT_URI?.trim() || OAUTH_PLAYGROUND_REDIRECT
    );
    oauth2Client.setCredentials({ refresh_token: refreshToken });
  }
  return oauth2Client;
}

function getMimeTransport() {
  if (!streamTransport) {
    streamTransport = nodemailer.createTransport({
      streamTransport: true,
      newline: 'unix',
      buffer: true,
    });
  }
  return streamTransport;
}

function bufferToBase64Url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Build RFC 822 message bytes using nodemailer’s MIME builder (attachments, multipart, etc.). */
async function buildRawMimeBuffer(mailOptions) {
  const info = await getMimeTransport().sendMail(mailOptions);
  return info.message;
}

async function verifyGmailApiConnection() {
  const gmail = google.gmail({ version: 'v1', auth: getGmailOAuth2Client() });
  await gmail.users.getProfile({ userId: 'me' });
}

/**
 * @param {import('nodemailer').SendMailOptions} mailOptions
 * @returns {Promise<string>} Gmail API message id
 */
async function sendGmailMessage(mailOptions) {
  const mimeBuf = await buildRawMimeBuffer(mailOptions);
  const raw = bufferToBase64Url(mimeBuf);
  const gmail = google.gmail({ version: 'v1', auth: getGmailOAuth2Client() });
  const res = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });
  return res.data.id ? String(res.data.id) : '';
}

module.exports = {
  verifyGmailApiConnection,
  sendGmailMessage,
};
