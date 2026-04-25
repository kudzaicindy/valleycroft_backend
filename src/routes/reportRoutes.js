const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const {
  getWeekly,
  getMonthly,
  getQuarterly,
  getAnnual,
  exportReport,
  getAiSummary,
  getAiSummaryPdf,
} = require('../controllers/reportController');

const router = express.Router();
router.use(protect);

router.get('/weekly', authorize('admin', 'finance', 'ceo'), getWeekly);
router.get('/monthly', authorize('admin', 'finance', 'ceo'), getMonthly);
router.get('/quarterly', authorize('admin', 'finance', 'ceo'), getQuarterly);
router.get('/annual', authorize('admin', 'finance', 'ceo'), getAnnual);
router.get('/export/:type', authorize('admin', 'finance', 'ceo'), exportReport);
router.post('/ai-summary', authorize('admin', 'finance', 'ceo'), getAiSummary);
router.get('/ai-summary/pdf', authorize('admin', 'finance', 'ceo'), getAiSummaryPdf);

module.exports = router;
