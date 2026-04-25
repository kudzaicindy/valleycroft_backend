const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const controller = require('../controllers/enquiryController');

const router = express.Router();

// Public guest endpoint
router.post('/', controller.createPublicEnquiry);

// Admin/CEO/Finance management
router.get('/', protect, authorize('admin', 'ceo', 'finance'), controller.listEnquiries);
router.get('/:id', protect, authorize('admin', 'ceo', 'finance'), controller.getEnquiryById);
router.post('/:id/respond', protect, authorize('admin', 'ceo'), controller.respondToEnquiry);
router.patch('/:id/close', protect, authorize('admin', 'ceo'), controller.closeEnquiry);

module.exports = router;
