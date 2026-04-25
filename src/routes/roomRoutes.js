const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const {
  getRooms,
  getRoomsManage,
  getRoomsPublicMedia,
  getLandingGallery,
  getRoomById,
  getRoomBySlug,
  getRoomBookings,
  createRoom,
  updateRoom,
  deleteRoom,
  uploadRoomImages,
  removeRoomImages,
} = require('../controllers/roomController');

const router = express.Router();

const roomManage = [protect, authorize('admin', 'ceo')];

// Public — static paths before /:id
router.get('/gallery/landing', getLandingGallery);
router.get('/public/media', getRoomsPublicMedia);
router.get('/manage', ...roomManage, getRoomsManage);
router.get('/by-slug/:slug', getRoomBySlug);
router.get('/', getRooms);
router.get('/:id/bookings', protect, authorize('finance', 'admin', 'ceo'), getRoomBookings);
router.get('/:id', getRoomById);

// Admin / CEO
router.post('/', ...roomManage, createRoom);
router.put('/:id', ...roomManage, updateRoom);
router.delete('/:id', ...roomManage, deleteRoom);
router.post(
  '/:id/images',
  ...roomManage,
  upload.array('images', 15),
  uploadRoomImages
);
router.delete('/:id/images', ...roomManage, removeRoomImages);

module.exports = router;
