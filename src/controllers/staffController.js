const User = require('../models/User');
const WorkLog = require('../models/WorkLog');
const { asyncHandler, getPagination } = require('../utils/helpers');
const logAudit = require('../utils/audit');
// GET /employees — list all employees
const getEmployees = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const { skip, limit: lim } = getPagination(page, limit);
  const [data, total] = await Promise.all([
    User.find({ role: 'employee', isActive: true })
      .select('name email phone idNumber dateJoined dateLeft')
      .sort({ dateJoined: -1 })
      .skip(skip)
      .limit(lim)
      .lean(),
    User.countDocuments({ role: 'employee', isActive: true }),
  ]);
  res.json({ success: true, data, meta: { page: parseInt(page, 10), limit: lim, total } });
});

// PUT /employees/:id — update profile / set date left
const updateEmployee = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ success: false, message: 'Employee not found' });
  const before = user.toObject();
  const { dateLeft, ...rest } = req.body;
  if (dateLeft !== undefined) user.dateLeft = dateLeft;
  Object.assign(user, rest);
  await user.save();
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'update',
    entity: 'User',
    entityId: user._id,
    before,
    after: user.toObject(),
    req,
  });
  res.json({ success: true, data: user });
});

// POST /tasks — assign task to employee. Accepts { employeeId, tasks } or { employeeId, title, dueDate }.
const assignTask = asyncHandler(async (req, res) => {
  const { employeeId, tasks, title, dueDate } = req.body;
  const taskList = tasks != null
    ? (Array.isArray(tasks) ? tasks : [tasks])
    : (title ? [title] : []);
  const log = await WorkLog.create({
    employee: employeeId,
    tasksAssigned: taskList,
    workDone: '',
    period: 'daily',
    dueDate: dueDate ? new Date(dueDate) : undefined,
  });
  res.status(201).json({ success: true, data: log });
});

// GET /tasks/:employeeId — get tasks for employee (employee can only fetch own). Returns work logs that have tasksAssigned (assignable tasks).
const getTasksForEmployee = asyncHandler(async (req, res) => {
  const { employeeId } = req.params;
  if (req.user.role === 'employee' && req.user._id.toString() !== employeeId) {
    return res.status(403).json({ message: 'Access denied' });
  }
  const logs = await WorkLog.find({
    employee: employeeId,
    $expr: { $gt: [ { $size: { $ifNull: [ '$tasksAssigned', [] ] } }, 0 ] },
  })
    .sort({ date: -1 })
    .limit(50)
    .lean()
    .select('_id date workDate tasksAssigned workDone period');
  res.json({ success: true, data: logs });
});

// GET /worklogs — admin/ceo view all
const getAllWorkLogs = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const { skip, limit: lim } = getPagination(page, limit);
  const [data, total] = await Promise.all([
    WorkLog.find()
      .populate('employee', 'name email')
      .sort({ date: -1 })
      .skip(skip)
      .limit(lim)
      .lean(),
    WorkLog.countDocuments(),
  ]);
  res.json({ success: true, data, meta: { page: parseInt(page, 10), limit: lim, total } });
});

// GET /worklogs/me — employee views own. Returns workDate, hoursWorked, startTime/endTime, workDone, etc.
const getMyWorkLogs = asyncHandler(async (req, res) => {
  const data = await WorkLog.find({ employee: req.user._id })
    .sort({ date: -1, createdAt: -1 })
    .lean();
  // Normalize for frontend: ensure workDate, hoursWorked, startTime, endTime, workDone are present
  const normalized = data.map((log) => ({
    ...log,
    workDate: log.workDate || log.date,
    work_date: log.workDate || log.date,
    date: log.date,
    hoursWorked: log.hoursWorked,
    hours_worked: log.hoursWorked,
    hours: log.hoursWorked,
    startTime: log.startTime,
    start_time: log.startTime,
    endTime: log.endTime,
    end_time: log.endTime,
    workDone: log.workDone,
    work_done: log.workDone,
    createdAt: log.createdAt,
    created_at: log.createdAt,
  }));
  res.json({ success: true, data: normalized });
});

// POST /worklogs — employee submit work log. Accepts workDone, period, workDate, taskId, hoursWorked, startTime, endTime (or title as alias for workDone).
const createWorkLog = asyncHandler(async (req, res) => {
  const { workDone, work_done, title, period, workDate, taskId, hoursWorked, startTime, endTime, tasksAssigned } = req.body;
  const workDateObj = workDate ? new Date(workDate) : new Date();
  const payload = {
    employee: req.user._id,
    workDone: workDone || work_done || title || '',
    period: period || 'daily',
    date: workDateObj,
    workDate: workDateObj,
    hoursWorked: hoursWorked != null ? Number(hoursWorked) : undefined,
    startTime: startTime || undefined,
    endTime: endTime || undefined,
    taskId: taskId || undefined,
    tasksAssigned: tasksAssigned ? (Array.isArray(tasksAssigned) ? tasksAssigned : [tasksAssigned]) : undefined,
    photos: req.files?.map((f) => f.location || f.path) || [],
  };
  const workLog = await WorkLog.create(payload);
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'create',
    entity: 'WorkLog',
    entityId: workLog._id,
    after: workLog.toObject(),
    req,
  });
  res.status(201).json({ success: true, data: workLog });
});

module.exports = {
  getEmployees,
  updateEmployee,
  assignTask,
  getTasksForEmployee,
  getAllWorkLogs,
  getMyWorkLogs,
  createWorkLog,
};
