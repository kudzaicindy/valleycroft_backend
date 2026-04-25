const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const { list, create, update, getPdf, sendInvoice, getWhatsAppShareLink } = require('../controllers/invoiceController');

const router = express.Router();
router.use(protect);

router.get('/', authorize('finance', 'admin', 'ceo'), list);
router.post('/', authorize('finance', 'admin'), create);
router.put('/:id', authorize('finance', 'admin'), update);
router.get('/:id/pdf', authorize('finance', 'admin', 'ceo'), getPdf);
router.post('/:id/send', authorize('finance', 'admin', 'ceo'), sendInvoice);
router.get('/:id/whatsapp-link', authorize('finance', 'admin', 'ceo'), getWhatsAppShareLink);

module.exports = router;
