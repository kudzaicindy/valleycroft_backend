const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { asyncHandler } = require('../utils/helpers');
const logAudit = require('../utils/audit');

const signToken = (user) =>
  jwt.sign({ _id: user._id, role: user.role }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });

// POST /login
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!process.env.JWT_SECRET) {
    return res.status(500).json({
      success: false,
      message: 'Server misconfiguration: JWT_SECRET is not set.',
    });
  }
  const user = await User.findOne({ email, isActive: true }).select('+password');
  if (!user || !(await user.matchPassword(password))) {
    return res.status(401).json({ success: false, message: 'Invalid email or password' });
  }
  const token = signToken(user);
  await logAudit({
    userId: user._id,
    role: user.role,
    action: 'login',
    entity: 'User',
    entityId: user._id,
    req,
  });
  res.json({
    success: true,
    data: {
      token,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    },
  });
});

// POST /register — Admin only
const register = asyncHandler(async (req, res) => {
  const user = await User.create(req.body);
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'create',
    entity: 'User',
    entityId: user._id,
    after: { ...user.toObject(), password: '[REDACTED]' },
    req,
  });
  res.status(201).json({
    success: true,
    data: {
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
    },
  });
});

// GET /me
const getMe = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id)
    .lean()
    .select('name email role phone idNumber dateJoined dateLeft isActive');
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  res.json({ success: true, data: user });
});

// PUT /change-password
const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const user = await User.findById(req.user._id).select('+password');
  if (!user || !(await user.matchPassword(currentPassword))) {
    return res.status(401).json({ success: false, message: 'Current password is incorrect' });
  }
  user.password = newPassword;
  await user.save();
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'update',
    entity: 'User',
    entityId: user._id,
    req,
  });
  res.json({ success: true, message: 'Password updated' });
});

module.exports = { login, register, getMe, changePassword };
