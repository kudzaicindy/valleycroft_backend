const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const { list } = require('../controllers/emailController');

const router = express.Router();
router.use(protect);
router.get('/', authorize('admin', 'ceo', 'finance'), list);

module.exports = router;
