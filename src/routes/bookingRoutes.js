const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const {
  list,
  getAvailability,
  getOne,
  create,
  update,
  remove,
} = require('../controllers/bookingController');

const router = express.Router();

router.use(protect);

router.get('/', authorize('admin', 'ceo'), list);
router.get('/availability', authorize('admin', 'ceo'), getAvailability);
router.get('/:id', authorize('admin', 'ceo'), getOne);
router.post('/', authorize('admin'), create);
router.put('/:id', authorize('admin'), update);
router.delete('/:id', authorize('admin'), remove);

module.exports = router;
