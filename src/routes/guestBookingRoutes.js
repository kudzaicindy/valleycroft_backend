const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const {
  createGuestBooking,
  trackBooking,
  getAllGuestBookings,
  updateGuestBooking,
} = require('../controllers/guestBookingController');

const router = express.Router();

// Public
router.post('/', createGuestBooking);
router.get('/track', trackBooking);

// Admin, CEO, Finance (read)
router.get('/', protect, authorize('admin', 'ceo', 'finance'), getAllGuestBookings);
router.put('/:id', protect, authorize('admin'), updateGuestBooking);

module.exports = router;
