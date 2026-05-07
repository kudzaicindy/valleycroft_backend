/**
 * Check whether outbound mail can authenticate (does not send an email).
 * Usage: npm run mail:verify
 * Optional: set VERIFY_MAIL_TO=you@example.com to send one test message after verify.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const nodemailer = require('nodemailer');

function gmailAppPasswordRaw() {
  return (
    process.env.GMAIL_APP_PASSWORD ||
    process.env.GMAIL_PASSWORD ||
    process.env.GOOGLE_APP_PASSWORD ||
    ''
  );
}

function gmailAppPasswordConfigured() {
  return !!(process.env.GMAIL_USER?.trim() && gmailAppPasswordRaw().trim());
}

function gmailOAuthConfigured() {
  return !!(
    process.env.GMAIL_USER &&
    process.env.GMAIL_CLIENT_ID &&
    process.env.GMAIL_CLIENT_SECRET &&
    process.env.GMAIL_REFRESH_TOKEN
  );
}

function smtpConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function isPlaceholderRefreshToken(rt) {
  const s = (rt || '').trim();
  if (!s) return true;
  if (/^the-refresh-token-from-oauth-playground$/i.test(s)) return true;
  if (/oauth.playground/i.test(s) && s.length < 40) return true;
  return s.length < 20;
}

async function main() {
  if (gmailAppPasswordConfigured()) {
    console.log('Transport: Gmail App Password → smtp.gmail.com:587');
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: {
        user: process.env.GMAIL_USER.trim(),
        pass: gmailAppPasswordRaw().replace(/\s+/g, ''),
      },
    });
    try {
      await transporter.verify();
      console.log('Verify: OK (Gmail accepted user + app password).\n');
    } catch (err) {
      console.error('Verify: FAILED —', err.message);
      console.error(
        '\n  Check: 2-Step Verification on, App Password created, GMAIL_USER matches that Google account.\n',
      );
      process.exitCode = 1;
      return;
    }
    const testTo = (process.env.VERIFY_MAIL_TO || '').trim();
    if (testTo) {
      const from = process.env.MAIL_FROM || process.env.GMAIL_USER;
      await transporter.sendMail({
        from,
        to: testTo,
        subject: 'Valley Croft Accommodation — mail test',
        text: 'If you receive this, Gmail App Password SMTP is working.',
      });
      console.log(`Test email sent to ${testTo}`);
    } else {
      console.log('Tip: VERIFY_MAIL_TO=you@email.com npm run mail:verify  → sends one test email.');
    }
    return;
  }

  if (gmailOAuthConfigured()) {
    const rt = process.env.GMAIL_REFRESH_TOKEN.trim();
    const useSmtpOAuth = String(process.env.GMAIL_USE_SMTP || '').trim().toLowerCase() === 'true';

    if (isPlaceholderRefreshToken(rt)) {
      console.log(
        '\nProblem: GMAIL_REFRESH_TOKEN still looks like a placeholder.\n' +
          'Get a real refresh token: OAuth Playground → Exchange tokens → copy Refresh token.\n',
      );
    }

    if (!useSmtpOAuth) {
      const { verifyGmailApiConnection, sendGmailMessage } = require('../src/services/gmailHttpMail');
      console.log('Transport: Gmail OAuth → Gmail API (HTTPS only; works when SMTP ports are blocked)');
      try {
        await verifyGmailApiConnection();
        console.log('Verify: OK (Gmail API profile reachable).\n');
      } catch (err) {
        console.error('Verify: FAILED');
        console.error('  ', err.message);
        if (String(err.message).includes('invalid_grant')) {
          console.error(
            '\n  invalid_grant usually means: wrong/expired refresh token, or token was issued for a different client id/secret.\n' +
              '  Fix: generate a new refresh token in OAuth Playground using THIS client id + secret.\n',
          );
        }
        if (String(err.code || err.response?.status) === '403' || String(err.message).includes('accessNotConfigured')) {
          console.error(
            '\n  Enable "Gmail API" for your Google Cloud project and ensure OAuth scopes include gmail.send or mail.google.com.\n',
          );
        }
        process.exitCode = 1;
        return;
      }

      const testTo = (process.env.VERIFY_MAIL_TO || '').trim();
      if (testTo) {
        const from = process.env.MAIL_FROM || process.env.GMAIL_USER;
        await sendGmailMessage({
          from,
          to: testTo,
          subject: 'Valley Croft Accommodation — mail test',
          text: 'If you receive this, Gmail API mail is working.',
        });
        console.log(`Test email sent to ${testTo}`);
      } else {
        console.log('Tip: VERIFY_MAIL_TO=you@email.com npm run mail:verify  → sends one test email.');
      }
      return;
    }

    console.log('Transport: Gmail OAuth → smtp.gmail.com:587 (STARTTLS) [GMAIL_USE_SMTP=true]');
    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: {
        type: 'OAuth2',
        user: process.env.GMAIL_USER.trim(),
        clientId: process.env.GMAIL_CLIENT_ID.trim(),
        clientSecret: process.env.GMAIL_CLIENT_SECRET.trim(),
        refreshToken: rt,
      },
    });
    try {
      await transporter.verify();
      console.log('Verify: OK (Google accepted your OAuth credentials via SMTP).\n');
    } catch (err) {
      console.error('Verify: FAILED');
      console.error('  ', err.message);
      if (String(err.message).includes('invalid_grant')) {
        console.error(
          '\n  invalid_grant usually means: wrong/expired refresh token, or token was issued for a different client id/secret.\n' +
            '  Fix: generate a new refresh token in OAuth Playground using THIS client id + secret.\n',
        );
      }
      if (String(err.message).includes('invalid_client')) {
        console.error(
          '\n  invalid_client: check GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in Google Cloud → Credentials.\n',
        );
      }
      process.exitCode = 1;
      return;
    }

    const testTo = (process.env.VERIFY_MAIL_TO || '').trim();
    if (testTo) {
      const from = process.env.MAIL_FROM || process.env.GMAIL_USER;
      await transporter.sendMail({
        from,
        to: testTo,
        subject: 'Valley Croft Accommodation — mail test',
        text: 'If you receive this, SMTP + OAuth are working.',
      });
      console.log(`Test email sent to ${testTo}`);
    } else {
      console.log('Tip: VERIFY_MAIL_TO=you@email.com npm run mail:verify  → sends one test email.');
    }
    return;
  }

  if (smtpConfigured()) {
    console.log('Transport: SMTP', process.env.SMTP_HOST);
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    try {
      await transporter.verify();
      console.log('Verify: OK\n');
    } catch (err) {
      console.error('Verify: FAILED —', err.message);
      process.exitCode = 1;
    }
    return;
  }

  console.log(
    'No mail transport: set GMAIL_USER + GMAIL_APP_PASSWORD, or Gmail OAuth (GMAIL_*), or SMTP_* in .env',
  );
  process.exitCode = 1;
}

main();
