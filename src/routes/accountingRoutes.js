const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const ledgerService = require('../services/ledgerService');
const incomeStatementService = require('../services/incomeStatementService');
const balanceSheetService = require('../services/balanceSheetService');
const cashFlowService = require('../services/cashFlowService');
const { listGeneralLedger } = require('../controllers/accountingLedgerController');
const { resolvePeriodDates } = require('../utils/accountingPeriod');
const logAudit = require('../utils/audit');
const accountChartController = require('../controllers/accountChartController');

const router = express.Router();
router.use(protect);
router.use(authorize('finance', 'admin', 'ceo'));

// Chart of accounts (static paths before any /:id routes)
router.get('/accounts/next-code', accountChartController.getNextAccountCode);
router.get('/accounts', accountChartController.listAccounts);
router.post('/accounts', accountChartController.createAccount);

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
  try {
    const dates = resolvePeriodDates(req.query);
    if (!dates) {
      return res.status(400).json({
        success: false,
        error: 'Provide startDate & endDate, or year (e.g. 2026), or month (e.g. 2026-03)',
      });
    }
    const result = await incomeStatementService.generate(dates.startDate, dates.endDate);
    await logAudit({
      userId: req.user._id,
      role: req.user.role,
      action: 'export',
      entity: 'IncomeStatementLedger',
      req,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
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

// GET /api/accounting/balance-sheet?asOfDate=&periodStartDate=
router.get('/balance-sheet', async (req, res) => {
  try {
    const { asOfDate, periodStartDate } = req.query;
    if (!asOfDate) {
      return res.status(400).json({ success: false, error: 'asOfDate is required (YYYY-MM-DD)' });
    }
    const result = await balanceSheetService.generate(asOfDate, periodStartDate || null);
    if (!result.isBalanced) {
      console.error(`[BalanceSheet] Not balanced at ${asOfDate}. Variance: ${result.variance}`);
    }
    await logAudit({
      userId: req.user._id,
      role: req.user.role,
      action: 'export',
      entity: 'BalanceSheetLedger',
      req,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

async function getLedgerCashFlow(req, res) {
  try {
    const dates = resolvePeriodDates(req.query);
    if (!dates) {
      return res.status(400).json({
        success: false,
        error: 'Provide startDate & endDate, or year, or month',
      });
    }
    const result = await cashFlowService.generate(dates.startDate, dates.endDate);
    if (!result.summary.isReconciled) {
      console.warn('[CashFlow] Closing cash may not match ledger cash accounts');
    }
    await logAudit({
      userId: req.user._id,
      role: req.user.role,
      action: 'export',
      entity: 'CashFlowLedger',
      req,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// GET /api/accounting/cash-flow (preferred)
router.get('/cash-flow', getLedgerCashFlow);
// GET /api/accounting/cashflow (compat alias)
router.get('/cashflow', getLedgerCashFlow);

// GET /api/accounting/financial-statements — all three + checks
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

    const [incomeStatement, balanceSheet, cashFlow] = await Promise.all([
      incomeStatementService.generate(startDate, endDate),
      balanceSheetService.generate(endDate, startDate),
      cashFlowService.generate(startDate, endDate),
    ]);

    res.json({
      success: true,
      data: {
        period: dates,
        incomeStatement,
        balanceSheet,
        cashFlow,
        checks: {
          netIncomeConsistent: incomeStatement.netIncome === cashFlow.operatingActivities.netIncome,
          cashReconciled: cashFlow.summary.isReconciled,
          balanceSheetBalanced: balanceSheet.isBalanced,
        },
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
