const mongoose = require('mongoose');

const salarySchema = new mongoose.Schema({
  /** Optional link to a staff User; payroll rows may be recorded without a specific employee. */
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  /** Display label when `employee` is not set (e.g. contractor, batch run). */
  payeeName: { type: String, trim: true, default: '' },
  amount: Number,
  month: String, // e.g. '2026-03'
  paidOn: Date,
  notes: String,
  /** Linked expense `Transaction` + v3 journal when `paidOn` is set on create (cash salary paid). */
  expenseTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },
}, { timestamps: true });

module.exports = mongoose.model('Salary', salarySchema);
