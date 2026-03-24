const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const {
  getRooms,
  getRoomById,
  getRoomBookings,
  createRoom,
  updateRoom,
  deleteRoom,
} = require('../controllers/roomController');

const router = express.Router();

// Public
router.get('/', getRooms);
router.get('/:id/bookings', getRoomBookings); // must be before /:id
router.get('/:id', getRoomById);

// Admin only
router.post('/', protect, authorize('admin'), createRoom);
router.put('/:id', protect, authorize('admin'), updateRoom);
router.delete('/:id', protect, authorize('admin'), deleteRoom);

module.exports = router;
