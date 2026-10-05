const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const debtorController = require('../controllers/debtorController');

const router = express.Router();
router.use(protect);

router.get('/', authorize('finance', 'admin', 'ceo'), debtorController.list);
router.get('/pending-bookings', authorize('finance', 'admin', 'ceo'), debtorController.pendingBookings);
router.get('/:id/payments', authorize('finance', 'admin', 'ceo'), debtorController.listPayments);
router.get('/:id/payments/:paymentId/pdf', authorize('finance', 'admin', 'ceo'), debtorController.getPaymentPdf);
router.post(
  '/:id/payments/:paymentId/send-email',
  authorize('finance', 'admin'),
  debtorController.sendPaymentReceiptEmail
);
router.post('/:id/payments', authorize('finance', 'admin'), debtorController.recordPayment);
router.post('/', authorize('finance', 'admin'), debtorController.create);
router.put('/:id', authorize('finance', 'admin'), debtorController.update);
router.delete('/:id', authorize('finance', 'admin'), debtorController.remove);

module.exports = router;
