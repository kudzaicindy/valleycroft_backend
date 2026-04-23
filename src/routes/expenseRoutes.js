const express = require('express');
const { authorize } = require('../middleware/auth');
const expenseController = require('../controllers/expenseController');

const router = express.Router();

router.get('/', authorize('finance', 'admin', 'ceo'), expenseController.list);
router.get('/:id', authorize('finance', 'admin', 'ceo'), expenseController.getById);
router.post('/', authorize('finance', 'admin'), expenseController.create);
router.put('/:id', authorize('finance', 'admin'), expenseController.update);
router.delete('/:id', authorize('finance', 'admin'), expenseController.remove);

module.exports = router;
