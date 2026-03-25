const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const financeController = require('../controllers/financeController');
const financeStatements = require('../controllers/financeStatements');
const financeDashboardController = require('../controllers/financeDashboardController');
const { listLedgerAsTransactions } = require('../controllers/accountingLedgerController');

const router = express.Router();
router.use(protect);

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
router.get('/salary/employee/:id', authorize('finance', 'admin'), financeController.getSalaryByEmployee);

module.exports = router;
