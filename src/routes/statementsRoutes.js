/**
 * Consolidated financial statement endpoints (transaction basis + general ledger).
 * Ledger-based P&amp;L / BS / cash flow remain under /api/accounting (see GET /catalog below).
 */
const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const financeStatements = require('../controllers/financeStatements');
const { listGeneralLedger, listAccountTransactions } = require('../controllers/accountingLedgerController');
const { resolvePeriodDates } = require('../utils/accountingPeriod');
const incomeStatementService = require('../services/incomeStatementService');
const balanceSheetService = require('../services/balanceSheetService');
const cashFlowService = require('../services/cashFlowService');

const router = express.Router();
router.use(protect);

/** Same roles as /api/finance for each statement type */
router.get('/income-statement', authorize('finance', 'ceo'), financeStatements.getIncomeStatement);
router.get('/income-statement/transactions', authorize('finance', 'admin', 'ceo'), financeStatements.getIncomeStatementTransactions);
router.get('/cash-flow', authorize('finance', 'admin', 'ceo'), financeStatements.getCashFlow);
router.get('/cashflow', authorize('finance', 'admin', 'ceo'), financeStatements.getCashFlow);
router.get('/cash-flow/transactions', authorize('finance', 'admin', 'ceo'), financeStatements.getCashFlowTransactions);
router.get('/cashflow/transactions', authorize('finance', 'admin', 'ceo'), financeStatements.getCashFlowTransactions);
router.get('/balance-sheet', authorize('finance', 'ceo'), financeStatements.getBalanceSheet);
router.get('/balance-sheet/transactions', authorize('finance', 'admin', 'ceo'), financeStatements.getBalanceSheetTransactions);
router.get('/pl', authorize('finance', 'ceo'), financeStatements.getPL);

/** General ledger (journal lines) — finance, admin, ceo */
router.get('/ledger', authorize('finance', 'admin', 'ceo'), listGeneralLedger);
router.get('/accounts/:accountCode/transactions', authorize('finance', 'admin', 'ceo'), listAccountTransactions);

// ─── Ledger-basis reports (same as /api/accounting/*) ───────────────────────

router.get('/ledger-basis/income-statement', authorize('finance', 'admin', 'ceo'), async (req, res) => {
  try {
    const dates = resolvePeriodDates(req.query);
    if (!dates) {
      return res.status(400).json({
        success: false,
        error: 'Provide startDate & endDate, or year, or month (e.g. month=2026-03)',
      });
    }
    const result = await incomeStatementService.generate(dates.startDate, dates.endDate);
    res.json({ success: true, data: result, basis: 'ledger' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/ledger-basis/cash-flow', authorize('finance', 'admin', 'ceo'), async (req, res) => {
  try {
    const dates = resolvePeriodDates(req.query);
    if (!dates) {
      return res.status(400).json({
        success: false,
        error: 'Provide startDate & endDate, or year, or month',
      });
    }
    const result = await cashFlowService.generate(dates.startDate, dates.endDate);
    res.json({ success: true, data: result, basis: 'ledger' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/ledger-basis/cashflow', authorize('finance', 'admin', 'ceo'), async (req, res) => {
  try {
    const dates = resolvePeriodDates(req.query);
    if (!dates) {
      return res.status(400).json({
        success: false,
        error: 'Provide startDate & endDate, or year, or month',
      });
    }
    const result = await cashFlowService.generate(dates.startDate, dates.endDate);
    res.json({ success: true, data: result, basis: 'ledger' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/ledger-basis/balance-sheet', authorize('finance', 'admin', 'ceo'), async (req, res) => {
  try {
    const { asOfDate, periodStartDate } = req.query;
    if (!asOfDate) {
      return res.status(400).json({ success: false, error: 'asOfDate is required (YYYY-MM-DD)' });
    }
    const result = await balanceSheetService.generate(asOfDate, periodStartDate || null);
    res.json({ success: true, data: result, basis: 'ledger' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/statements/catalog — discover all statement URLs (no heavy computation)
 */
router.get('/catalog', authorize('finance', 'admin', 'ceo'), (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    success: true,
    data: {
      description: 'Transaction-based statements use Transaction + related data. Ledger-basis uses posted journals.',
      transactionBasis: {
        incomeStatement: `${base}/api/statements/income-statement?start=YYYY-MM-DD&end=YYYY-MM-DD`,
        incomeStatementTransactions: `${base}/api/statements/income-statement/transactions?start=YYYY-MM-DD&end=YYYY-MM-DD`,
        cashFlow: `${base}/api/statements/cash-flow?start=YYYY-MM-DD&end=YYYY-MM-DD`,
        cashFlowTransactions: `${base}/api/statements/cash-flow/transactions?start=YYYY-MM-DD&end=YYYY-MM-DD&transactionType=booking_payment`,
        balanceSheet: `${base}/api/statements/balance-sheet?asAt=YYYY-MM-DD`,
        balanceSheetTransactions: `${base}/api/statements/balance-sheet/transactions?asAt=YYYY-MM-DD&accountType=asset`,
        pl: `${base}/api/statements/pl?start=YYYY-MM-DD&end=YYYY-MM-DD`,
      },
      generalLedger: {
        journalLines: `${base}/api/statements/ledger?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&status=POSTED`,
        trialBalance: `${base}/api/accounting/trial-balance?asOfDate=YYYY-MM-DD`,
      },
      ledgerBasisReports: {
        incomeStatement: `${base}/api/statements/ledger-basis/income-statement?year=2026`,
        cashFlow: `${base}/api/statements/ledger-basis/cash-flow?year=2026`,
        balanceSheet: `${base}/api/statements/ledger-basis/balance-sheet?asOfDate=YYYY-MM-DD`,
        alternatePrefix: `${base}/api/accounting/* (same services)`,
      },
    },
  });
});

module.exports = router;
