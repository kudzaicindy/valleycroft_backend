const mongoose = require('mongoose');

const debtorSchema = new mongoose.Schema({
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

debtorSchema.index({ status: 1 });
debtorSchema.index({ guestBookingRef: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Debtor', debtorSchema);
