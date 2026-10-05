const mongoose = require('mongoose');
const Counter = require('./Counter');

const debtorPaymentSchema = new mongoose.Schema(
  {
    /** Human-friendly receipt code, e.g. RCP-2026-0001 */
    receiptNumber: { type: String, unique: true, sparse: true, index: true },
    debtorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Debtor', required: true, index: true },
    bookingRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
    guestBookingRef: { type: mongoose.Schema.Types.ObjectId, ref: 'GuestBooking' },
    amount: { type: Number, required: true, min: 0.01 },
    paidAt: { type: Date, default: Date.now },
    method: { type: String, trim: true, default: 'cash' },
    reference: { type: String, trim: true },
    note: { type: String, trim: true, default: '' },
    amountOwedBefore: { type: Number, required: true, min: 0 },
    amountPaidBefore: { type: Number, required: true, min: 0 },
    amountPaidAfter: { type: Number, required: true, min: 0 },
    remainingAfter: { type: Number, required: true, min: 0 },
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' },
    financialJournalEntryId: { type: mongoose.Schema.Types.ObjectId, ref: 'FinancialJournalEntry' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true }
);

debtorPaymentSchema.pre('save', async function (next) {
  if (this.isNew && !this.receiptNumber) {
    const year = new Date().getFullYear();
    const counter = await Counter.findOneAndUpdate(
      { _id: `receipt:${year}` },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    ).lean();
    this.receiptNumber = `RCP-${year}-${String(counter.seq).padStart(4, '0')}`;
  }
  next();
});

module.exports = mongoose.model('DebtorPayment', debtorPaymentSchema);
