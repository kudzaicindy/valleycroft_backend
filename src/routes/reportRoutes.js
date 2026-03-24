const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const {
  getWeekly,
  getMonthly,
  getQuarterly,
  getAnnual,
  exportReport,
} = require('../controllers/reportController');

const router = express.Router();
router.use(protect);

router.get('/weekly', authorize('admin', 'finance', 'ceo'), getWeekly);
router.get('/monthly', authorize('admin', 'finance', 'ceo'), getMonthly);
router.get('/quarterly', authorize('admin', 'finance', 'ceo'), getQuarterly);
router.get('/annual', authorize('admin', 'finance', 'ceo'), getAnnual);
router.get('/export/:type', authorize('admin', 'finance', 'ceo'), exportReport);

module.exports = router;
