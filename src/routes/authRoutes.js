const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const { login, register, getMe, changePassword } = require('../controllers/authController');

const router = express.Router();

router.post('/login', login);
router.post('/register', protect, authorize('admin'), register);
router.get('/me', protect, getMe);
router.put('/change-password', protect, changePassword);

module.exports = router;
