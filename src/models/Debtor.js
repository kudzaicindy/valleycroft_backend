const mongoose = require('mongoose');
const Counter = require('./Counter');

const debtorSchema = new mongoose.Schema({
  /** Human-friendly code, e.g. DBT-2026-0001 */
  debtorNumber: { type: String, unique: true, sparse: true, index: true },
  name: { type: String, required: true },
  contactEmail: String,
  contactPhone: String,
  description: String,
  amountOwed: Number,
  amountPaid: { type: Number, default: 0 },
  dueDate: Date,
  status: {
    type: String,
    enum: ['outstanding', 'partial', 'paid', 'written-off'],
    default: 'outstanding',
  },
  bookingRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
  /** Set when debtor is created from a website guest booking confirmation */
  guestBookingRef: { type: mongoose.Schema.Types.ObjectId, ref: 'GuestBooking' },
  invoiceRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
  notes: String,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  /** Child A/R GL used for this debtor when created from a booking */
  receivableAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account' },
}, { timestamps: true });

debtorSchema.virtual('balance').get(function () {
  return (this.amountOwed || 0) - (this.amountPaid || 0);
});
debtorSchema.set('toJSON', { virtuals: true });
debtorSchema.set('toObject', { virtuals: true });

debtorSchema.pre('save', async function (next) {
  if (this.isNew && !this.debtorNumber) {
    const year = new Date().getFullYear();
    const counter = await Counter.findOneAndUpdate(
      { _id: `debtor:${year}` },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    ).lean();
    this.debtorNumber = `DBT-${year}-${String(counter.seq).padStart(4, '0')}`;
  }
  next();
});

debtorSchema.index({ status: 1 });
debtorSchema.index({ guestBookingRef: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Debtor', debtorSchema);
