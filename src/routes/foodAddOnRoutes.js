const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const controller = require('../controllers/foodAddOnController');

const router = express.Router();

router.get('/', controller.getPublicCatalogue);
router.get('/manage', protect, authorize('admin'), controller.getAdminCatalogue);
router.put('/:addOnId', protect, authorize('admin'), controller.updateFoodAddOn);

module.exports = router;
