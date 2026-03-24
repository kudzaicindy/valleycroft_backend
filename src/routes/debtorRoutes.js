const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const debtorController = require('../controllers/debtorController');

const router = express.Router();
router.use(protect);

router.get('/', authorize('finance', 'admin', 'ceo'), debtorController.list);
router.post('/', authorize('finance', 'admin'), debtorController.create);
router.put('/:id', authorize('finance', 'admin'), debtorController.update);
router.delete('/:id', authorize('finance', 'admin'), debtorController.remove);

module.exports = router;
