const mongoose = require('mongoose');

const transactionLineSchema = new mongoose.Schema(
  {
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
    accountCode: { type: String, trim: true },
    accountName: { type: String, trim: true },
    debit: { type: Number, default: 0, min: 0 },
    credit: { type: Number, default: 0, min: 0 },
    description: String,
  },
  { _id: true }
);

transactionLineSchema.pre('validate', function (next) {
  const d = Number(this.debit) || 0;
  const c = Number(this.credit) || 0;
  if (d > 0 && c > 0) {
    return next(new Error('A transaction line cannot have both debit and credit'));
  }
  next();
});

const transactionSchema = new mongoose.Schema({
  type: { type: String, enum: ['income', 'expense'], required: true },
  category: String, // booking|salary|supplies|utilities|refund|supplier
  description: String,
  amount: { type: Number, required: true },
  date: { type: Date, default: Date.now },
  reference: String,
  booking: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
  guestBooking: { type: mongoose.Schema.Types.ObjectId, ref: 'GuestBooking' },
  /** manual = cash-style journal; booking_confirm_* uses accrual Dr AR / Cr revenue */
  source: {
    type: String,
    enum: ['manual', 'guest_booking_confirm', 'booking_confirm'],
    default: 'manual',
  },
  /** cash: Dr Bank; accrual_ar: Dr Accounts Receivable (on booking confirmation) */
  revenueRecognition: {
    type: String,
    enum: ['cash', 'accrual_ar'],
    default: 'cash',
  },
  /** When set, accrual journals debit this child A/R code instead of 1010 */
  receivableAccountCode: { type: String, trim: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  /** Posted double-entry journal (see /api/accounting); voided when transaction is updated/deleted */
  journalEntryId: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry' },
  /** Snapshot of GL lines at post time (same economic meaning as linked journal entry). */
  lines: { type: [transactionLineSchema], default: [] },
}, { timestamps: true });

transactionSchema.index({ date: -1 });
transactionSchema.index({ type: 1, date: -1 });

module.exports = mongoose.model('Transaction', transactionSchema);
