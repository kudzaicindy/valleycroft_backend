const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const quotationController = require('../controllers/quotationController');

const router = express.Router();
router.use(protect);

router.get('/', authorize('admin', 'ceo', 'finance'), quotationController.list);
router.post('/', authorize('admin', 'ceo'), quotationController.create);
router.put('/:id', authorize('admin', 'ceo'), quotationController.update);
router.delete('/:id', authorize('admin', 'ceo'), quotationController.remove);
router.get('/:id/pdf', authorize('admin', 'ceo', 'finance'), quotationController.getPdf);
router.post('/:id/send-email', authorize('admin', 'ceo'), quotationController.sendEmail);

module.exports = router;
