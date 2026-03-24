const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const { list, getByEntity, getByUser } = require('../controllers/auditController');

const router = express.Router();
router.use(protect);

router.get('/', authorize('admin', 'ceo', 'finance'), list);
router.get('/entity/:name', authorize('admin', 'ceo', 'finance'), getByEntity);
router.get('/user/:id', authorize('admin', 'ceo'), getByUser);

module.exports = router;
