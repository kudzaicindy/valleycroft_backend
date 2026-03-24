const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const supplierController = require('../controllers/supplierController');

const router = express.Router();
router.use(protect);

router.get('/', authorize('finance', 'admin', 'ceo'), supplierController.list);
router.post('/', authorize('finance', 'admin'), supplierController.create);
router.post('/payments', authorize('finance', 'admin'), supplierController.createPayment);
router.put('/:id', authorize('finance', 'admin'), supplierController.update);
router.get('/:id/payments', authorize('finance', 'admin', 'ceo'), supplierController.getPayments);

module.exports = router;
