const mongoose = require('mongoose');

const payfastPaymentSchema = new mongoose.Schema(
  {
    mPaymentId: { type: String, required: true, unique: true, index: true },
    debtorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Debtor', required: true, index: true },
    guestBookingRef: { type: mongoose.Schema.Types.ObjectId, ref: 'GuestBooking' },
    bookingRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
    amount: { type: Number, required: true, min: 0.01 },
    paymentType: {
      type: String,
      enum: ['balance', 'deposit', 'full', 'custom'],
      default: 'balance',
    },
    status: {
      type: String,
      enum: ['pending', 'complete', 'cancelled', 'failed'],
      default: 'pending',
      index: true,
    },
    payfastPaymentId: { type: String, trim: true },
    pfPaymentStatus: { type: String, trim: true },
    rawItn: { type: mongoose.Schema.Types.Mixed },
    debtorPaymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'DebtorPayment' },
    transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' },
    fulfilledAt: Date,
    failureReason: { type: String, trim: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model('PayfastPayment', payfastPaymentSchema);
