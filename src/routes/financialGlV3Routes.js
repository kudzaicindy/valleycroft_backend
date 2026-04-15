const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const financialGlV3Controller = require('../controllers/financialGlV3Controller');

const router = express.Router();
router.use(protect);
router.use(authorize('finance', 'admin', 'ceo'));

router.post('/journal', financialGlV3Controller.postJournalV3);
router.post('/journal/:id/void', financialGlV3Controller.voidJournalV3);
router.get('/journal', financialGlV3Controller.listJournalEntriesV3);
router.get('/journal/:id', financialGlV3Controller.getJournalWithLinesV3);

router.get('/income-statement', financialGlV3Controller.getIncomeStatementV3);
router.get('/cash-flow', financialGlV3Controller.getCashFlowV3);
router.get('/balance-sheet', financialGlV3Controller.getBalanceSheetV3);

module.exports = router;
