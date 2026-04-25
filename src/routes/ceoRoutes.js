const express = require('express');
const { protect } = require('../middleware/auth');
const reportRoutes = require('./reportRoutes');

const router = express.Router();
router.use(protect);

/** Executive reports — same handlers as `/api/reports/*` (admin, finance, ceo). */
router.use('/reports', reportRoutes);

module.exports = router;
