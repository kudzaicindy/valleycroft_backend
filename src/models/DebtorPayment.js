const mongoose = require('mongoose');

const debtorPaymentSchema = new mongoose.Schema(
  {
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

module.exports = mongoose.model('DebtorPayment', debtorPaymentSchema);
