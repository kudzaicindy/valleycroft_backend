const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
require('dotenv').config();

const connectDB = require('./src/config/db');
const app = express();
const PORT = process.env.PORT || 5000;

connectDB();

app.use(helmet());
app.use(compression());
// Allow frontend origin(s): set FRONTEND_URL in .env (comma-separated)
const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map((o) => o.trim()).filter(Boolean)
  : ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175', 'http://localhost:5176'];
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
app.use('/api/debtors', require('./src/routes/debtorRoutes'));
app.use('/api/suppliers', require('./src/routes/supplierRoutes'));
app.use('/api/invoices', require('./src/routes/invoiceRoutes'));
app.use('/api/refunds', require('./src/routes/refundRoutes'));
app.use('/api/audit', require('./src/routes/auditRoutes'));
app.use('/api/accounting', require('./src/routes/accountingRoutes'));

// Health check — critical for Render keepalive
app.get('/api/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
