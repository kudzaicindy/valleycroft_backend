const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const {
  getEmployees,
  updateEmployee,
  assignTask,
  getTasksForEmployee,
  getAllWorkLogs,
  getMyWorkLogs,
  createWorkLog,
} = require('../controllers/staffController');

const router = express.Router();

router.get('/employees', protect, authorize('admin', 'ceo'), getEmployees);
router.put('/employees/:id', protect, authorize('admin'), updateEmployee);
router.post('/tasks', protect, authorize('admin'), assignTask);
router.get('/tasks/:employeeId', protect, getTasksForEmployee);
router.get('/worklogs', protect, authorize('admin', 'ceo'), getAllWorkLogs);
router.get('/worklogs/me', protect, authorize('employee'), getMyWorkLogs);
router.post('/worklogs', protect, authorize('employee'), createWorkLog);

module.exports = router;
