const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const ledgerService = require('../services/ledgerService');
const incomeStatementService = require('../services/incomeStatementService');
const {
  getIncomeStatementV3,
  getCashFlowV3,
  getBalanceSheetV3,
  shapeIncomeStatementPresentationV7,
  shapeBalanceSheetPresentationV3,
  accountingDisclosureIncomeStatement,
  accountingDisclosureBalanceSheet,
} = require('../services/financialStatementsV3Service');
const { listGeneralLedger, listAccountTransactions } = require('../controllers/accountingLedgerController');
const { resolvePeriodDates } = require('../utils/accountingPeriod');
const logAudit = require('../utils/audit');
const accountChartController = require('../controllers/accountChartController');
const financeStatements = require('../controllers/financeStatements');

const router = express.Router();
router.use(protect);
router.use(authorize('finance', 'admin', 'ceo'));

// Chart of accounts (static paths before any /:id routes)
router.get('/accounts/next-code', accountChartController.getNextAccountCode);
router.get('/accounts', accountChartController.listAccounts);
router.post('/accounts', accountChartController.createAccount);
router.put('/accounts/:id', accountChartController.updateAccount);

// POST /api/accounting/journal
router.post('/journal', async (req, res) => {
  try {
    const result = await ledgerService.postEntry({
      ...req.body,
      createdBy: req.user._id,
    });
    await logAudit({
      userId: req.user._id,
      role: req.user.role,
      action: 'create',
      entity: 'JournalEntry',
      entityId: result.entryId,
      req,
    });
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/accounting/journal/:id/void
router.post('/journal/:id/void', async (req, res) => {
  try {
    const result = await ledgerService.voidEntry(req.params.id, req.body.reason || 'Voided', req.user._id);
    await logAudit({
      userId: req.user._id,
      role: req.user.role,
      action: 'update',
      entity: 'JournalEntry',
      entityId: req.params.id,
      req,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// GET /api/accounting/ledger?startDate=&endDate=&status=POSTED&page=1&limit=50
router.get('/ledger', listGeneralLedger);
router.get('/accounts/:accountCode/transactions', listAccountTransactions);
// GET /api/accounting/journal-entries (compat alias)
router.get('/journal-entries', listGeneralLedger);

// GET /api/accounting/trial-balance?asOfDate=
router.get('/trial-balance', async (req, res) => {
  try {
    const result = await ledgerService.getTrialBalance(req.query.asOfDate || null);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/accounting/income-statement?startDate=&endDate= | ?year=2026 | ?month=2026-03
router.get('/income-statement', async (req, res) => {
  const dates = resolvePeriodDates(req.query);
  if (!dates) {
    return res.status(400).json({
      success: false,
      error: 'Provide startDate & endDate, or year (e.g. 2026), or month (e.g. 2026-03)',
    });
  }
  return financeStatements.getIncomeStatement(
    { ...req, query: { ...req.query, startDate: dates.startDate, endDate: dates.endDate } },
    res
  );
});

// GET /api/accounting/retained-earnings
router.get('/retained-earnings', async (req, res) => {
  try {
    const dates = resolvePeriodDates(req.query);
    if (!dates) {
      return res.status(400).json({
        success: false,
        error: 'Provide startDate & endDate, or year, or month',
      });
    }
    const result = await incomeStatementService.getRetainedEarningsRollforward(
      dates.startDate,
      dates.endDate
    );
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/accounting/balance-sheet?asOfDate= | asAt=
router.get('/balance-sheet', async (req, res) => {
  const asOfDate = req.query.asOfDate || req.query.asAt;
  if (!asOfDate) {
    return res.status(400).json({ success: false, error: 'asOfDate or asAt is required (YYYY-MM-DD)' });
  }
  return financeStatements.getBalanceSheet({ ...req, query: { ...req.query, asOfDate } }, res);
});

async function getLedgerCashFlow(req, res) {
  const dates = resolvePeriodDates(req.query);
  if (!dates) {
    return res.status(400).json({
      success: false,
      error: 'Provide startDate & endDate, or year, or month',
    });
  }
  return financeStatements.getCashFlow(
    { ...req, query: { ...req.query, startDate: dates.startDate, endDate: dates.endDate } },
    res
  );
}

// GET /api/accounting/cash-flow (preferred)
router.get('/cash-flow', getLedgerCashFlow);
// GET /api/accounting/cashflow (compat alias)
router.get('/cashflow', getLedgerCashFlow);

// GET /api/accounting/financial-statements — all three (v3 basis) + checks
router.get('/financial-statements', async (req, res) => {
  try {
    const dates = resolvePeriodDates(req.query);
    if (!dates) {
      return res.status(400).json({
        success: false,
        error: 'Provide startDate & endDate, or year, or month',
      });
    }
    const { startDate, endDate } = dates;
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setUTCHours(23, 59, 59, 999);

    const [incomeRaw, balanceSheetCore, cashFlow] = await Promise.all([
      getIncomeStatementV3(start, end),
      getBalanceSheetV3(end),
      getCashFlowV3(start, end),
    ]);

    const incomeStatement = {
      accounting: accountingDisclosureIncomeStatement(incomeRaw.period),
      presentation: shapeIncomeStatementPresentationV7(incomeRaw),
      ...incomeRaw,
    };

    const balanceSheet = {
      accounting: accountingDisclosureBalanceSheet(balanceSheetCore.asAt),
      presentation: shapeBalanceSheetPresentationV3(balanceSheetCore),
      ...balanceSheetCore,
    };

    res.json({
      success: true,
      basis: 'double_entry_v3',
      data: {
        period: dates,
        incomeStatement,
        balanceSheet,
        cashFlow,
        checks: {
          balanceSheetEquationHolds: balanceSheetCore.balances,
          cash1001MatchesMovement: cashFlow.cash1001?.matchesNetCashMovement ?? null,
          netProfitBeforeTax: incomeRaw.netProfitBeforeTax,
          netCashFlowAccount1001: cashFlow.netCashMovement,
          changeInAccountsReceivable1010: cashFlow.accounting?.changeInAccountsReceivable1010 ?? null,
        },
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
