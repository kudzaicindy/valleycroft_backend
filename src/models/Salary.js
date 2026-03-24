const mongoose = require('mongoose');

const salarySchema = new mongoose.Schema({
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount: Number,
  month: String, // e.g. '2026-03'
  paidOn: Date,
  notes: String,
}, { timestamps: true });

module.exports = mongoose.model('Salary', salarySchema);
