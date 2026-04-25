const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const financeController = require('../controllers/financeController');
const financeStatements = require('../controllers/financeStatements');
const financeDashboardController = require('../controllers/financeDashboardController');
const { listLedgerAsTransactions } = require('../controllers/accountingLedgerController');
const debtorRoutes = require('./debtorRoutes');
const supplierRoutes = require('./supplierRoutes');
const invoiceRoutes = require('./invoiceRoutes');
const refundRoutes = require('./refundRoutes');
const expenseRoutes = require('./expenseRoutes');

const router = express.Router();
router.use(protect);

/**
 * Finance hub — same routers as /api/debtors, /api/suppliers, etc., so the UI can use
 * only `/api/finance/...` (avoid /api/admin/debtors/... for finance, admin, and ceo).
 */
router.use('/debtors', debtorRoutes);
router.use('/suppliers', supplierRoutes);
router.use('/invoices', invoiceRoutes);
router.use('/refunds', refundRoutes);
router.use('/expenses', expenseRoutes);

router.get('/dashboard', authorize('finance', 'admin', 'ceo'), financeDashboardController.getDashboard);
router.get('/transactions', authorize('finance', 'admin', 'ceo'), financeController.getTransactions);
router.get('/transactions-ledger-format', authorize('finance', 'admin', 'ceo'), listLedgerAsTransactions);
router.post('/transactions', authorize('finance', 'admin'), financeController.createTransaction);
router.put('/transactions/:id', authorize('finance', 'admin'), financeController.updateTransaction);
router.delete('/transactions/:id', authorize('finance', 'admin'), financeController.deleteTransaction);
router.get('/cashflow', authorize('finance', 'admin', 'ceo'), financeStatements.getCashFlow);
router.get('/cash-flow', authorize('finance', 'admin', 'ceo'), financeStatements.getCashFlow);
router.get('/income-statement', authorize('finance', 'ceo'), financeStatements.getIncomeStatement);
router.get('/balance-sheet', authorize('finance', 'ceo'), financeStatements.getBalanceSheet);
router.get('/pl', authorize('finance', 'ceo'), financeStatements.getPL);
router.get('/salary', authorize('finance', 'admin', 'ceo'), financeController.getSalary);
router.post('/salary', authorize('finance', 'admin'), financeController.createSalary);
router.delete('/salary/:id', authorize('finance', 'admin'), financeController.deleteSalary);
router.get('/salary/employee/:id', authorize('finance', 'admin'), financeController.getSalaryByEmployee);

module.exports = router;
