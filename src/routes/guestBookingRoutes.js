const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const {
  createGuestBooking,
  trackBooking,
  getAllGuestBookings,
  updateGuestBooking,
  deleteGuestBooking,
  getFoodAddOnCatalogue,
  quoteGuestBooking,
  postGuestBookingRevenue,
} = require('../controllers/guestBookingController');

const router = express.Router();

// Public
router.get('/food-add-ons', getFoodAddOnCatalogue);
router.get('/quote', quoteGuestBooking);
router.post('/', createGuestBooking);
router.get('/track', trackBooking);

// Admin, CEO, Finance (read)
router.get('/', protect, authorize('admin', 'ceo', 'finance'), getAllGuestBookings);
router.post('/:id/post-revenue', protect, authorize('admin'), postGuestBookingRevenue);
router.put('/:id', protect, authorize('admin'), updateGuestBooking);
router.delete('/:id', protect, authorize('admin'), deleteGuestBooking);

module.exports = router;
