const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const {
  getStock,
  createStock,
  updateStock,
  deleteStock,
  getEquipment,
  createEquipment,
  updateEquipment,
} = require('../controllers/inventoryController');

const router = express.Router();
router.use(protect);

router.get('/stock', authorize('admin', 'ceo'), getStock);
router.post('/stock', authorize('admin'), createStock);
router.put('/stock/:id', authorize('admin'), updateStock);
router.delete('/stock/:id', authorize('admin'), deleteStock);
router.get('/equipment', authorize('admin', 'ceo'), getEquipment);
router.post('/equipment', authorize('admin'), createEquipment);
router.put('/equipment/:id', authorize('admin'), updateEquipment);

module.exports = router;
