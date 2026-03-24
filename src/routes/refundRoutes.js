const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const { list, create, update } = require('../controllers/refundController');

const router = express.Router();
router.use(protect);

router.get('/', authorize('finance', 'admin', 'ceo'), list);
router.post('/', authorize('finance', 'admin'), create);
router.put('/:id', authorize('finance', 'admin'), update);

module.exports = router;
