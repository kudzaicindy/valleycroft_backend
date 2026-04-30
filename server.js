const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
require('dotenv').config();

const connectDB = require('./src/config/db');
const { redirectPreservePath } = require('./src/utils/canonicalApiRedirect');
const { verifyMailConnection } = require('./src/services/invoiceNotifyService');
const app = express();
const PORT = process.env.PORT || 5000;

connectDB();

app.use(helmet());
app.use(compression());
// Allow frontend origin(s): set FRONTEND_URL in .env (comma-separated)
const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map((o) => o.trim()).filter(Boolean)
  : [
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:5175',
    'http://localhost:5176',
    'https://valleycroft.vercel.app',
  ];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // same-origin or non-browser
    if (allowedOrigins.includes(origin)) return cb(null, origin);
    return cb(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Ensure CORS preflight requests don't fall through to a 404.
// Express otherwise returns 404 for OPTIONS when there is no explicit handler for that path.
app.options('*', (req, res) => res.sendStatus(204));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Public routes (no auth)
app.use('/api/rooms', require('./src/routes/roomRoutes'));
app.use('/api/guest-bookings', require('./src/routes/guestBookingRoutes'));

// Protected routes
app.use('/api/auth', require('./src/routes/authRoutes'));
app.use('/api/bookings', require('./src/routes/bookingRoutes'));
app.use('/api/finance', require('./src/routes/financeRoutes'));
app.use('/api/statements', require('./src/routes/statementsRoutes'));
app.use('/api/staff', require('./src/routes/staffRoutes'));
app.use('/api/inventory', require('./src/routes/inventoryRoutes'));
app.use('/api/reports', require('./src/routes/reportRoutes'));
app.use('/api/ceo', require('./src/routes/ceoRoutes'));
app.use('/api/debtors', require('./src/routes/debtorRoutes'));
app.use('/api/suppliers', require('./src/routes/supplierRoutes'));
app.use('/api/invoices', require('./src/routes/invoiceRoutes'));
app.use('/api/quotations', require('./src/routes/quotationRoutes'));
app.use('/api/enquiries', require('./src/routes/enquiryRoutes'));
app.use('/api/refunds', require('./src/routes/refundRoutes'));
app.use('/api/audit', require('./src/routes/auditRoutes'));
app.use('/api/emails', require('./src/routes/emailRoutes'));
app.use('/api/accounting', require('./src/routes/accountingRoutes'));
app.use('/api/accounting/v3', require('./src/routes/financialGlV3Routes'));

// Admin namespace — non-finance mounts stay here. Finance dashboards must use canonical paths below (never /api/admin/finance|debtors|…).
app.use('/api/admin/auth', require('./src/routes/authRoutes'));
app.use('/api/admin/bookings', require('./src/routes/bookingRoutes'));
app.use('/api/admin/guest-bookings', require('./src/routes/guestBookingRoutes'));
app.use('/api/admin/rooms', require('./src/routes/roomRoutes'));
app.use('/api/admin/staff', require('./src/routes/staffRoutes'));
app.use('/api/admin/inventory', require('./src/routes/inventoryRoutes'));
app.use('/api/admin/reports', require('./src/routes/reportRoutes'));
app.use('/api/admin/audit', require('./src/routes/auditRoutes'));
app.use('/api/admin/emails', require('./src/routes/emailRoutes'));
app.use('/api/admin/enquiries', require('./src/routes/enquiryRoutes'));

/** Finance & ledger UIs: redirect /api/admin/* → canonical APIs (308, path + query preserved). */
app.use('/api/admin/accounting/v3', redirectPreservePath('/api/admin/accounting/v3', '/api/accounting/v3'));
app.use('/api/admin/accounting', redirectPreservePath('/api/admin/accounting', '/api/accounting'));
app.use('/api/admin/finance', redirectPreservePath('/api/admin/finance', '/api/finance'));
app.use('/api/admin/statements', redirectPreservePath('/api/admin/statements', '/api/statements'));
app.use('/api/admin/dashboard', redirectPreservePath('/api/admin/dashboard', '/api/finance/dashboard'));
app.use('/api/admin/transactions', redirectPreservePath('/api/admin/transactions', '/api/finance/transactions'));
app.use('/api/admin/salary', redirectPreservePath('/api/admin/salary', '/api/finance/salary'));
app.use('/api/admin/cashflow', redirectPreservePath('/api/admin/cashflow', '/api/finance/cashflow'));
app.use('/api/admin/cash-flow', redirectPreservePath('/api/admin/cash-flow', '/api/finance/cash-flow'));
app.use('/api/admin/income-statement', redirectPreservePath('/api/admin/income-statement', '/api/finance/income-statement'));
app.use('/api/admin/balance-sheet', redirectPreservePath('/api/admin/balance-sheet', '/api/finance/balance-sheet'));
app.use('/api/admin/pl', redirectPreservePath('/api/admin/pl', '/api/finance/pl'));
app.use('/api/admin/debtors', redirectPreservePath('/api/admin/debtors', '/api/finance/debtors'));
app.use('/api/admin/suppliers', redirectPreservePath('/api/admin/suppliers', '/api/finance/suppliers'));
app.use('/api/admin/invoices', redirectPreservePath('/api/admin/invoices', '/api/finance/invoices'));
app.use('/api/admin/quotations', redirectPreservePath('/api/admin/quotations', '/api/quotations'));
app.use('/api/admin/refunds', redirectPreservePath('/api/admin/refunds', '/api/finance/refunds'));

// Health check — critical for Render keepalive
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// Global error handler (helps Render return useful JSON for 500s)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('API error:', err?.message || err);
  res.status(500).json({
    success: false,
    message: err?.message || 'Internal Server Error',
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  setImmediate(async () => {
    const result = await verifyMailConnection();
    if (result.skipped) {
      console.log('[mail] startup check skipped:', result.reason, result.summary);
      return;
    }
    if (result.ok) {
      console.log('[mail] startup check ok:', result.summary);
      return;
    }
    console.error('[mail] startup check failed:', result.summary, result.error || 'unknown_error');
  });
});
