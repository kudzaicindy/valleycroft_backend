const mongoose = require('mongoose');

const bookingSchema = new mongoose.Schema({
  guestName: { type: String, required: true },
  guestEmail: String,
  guestPhone: String,
  type: { type: String, enum: ['bnb', 'event'], required: true },
  /** Optional link to Room (BnB); used for previews with room name */
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room' },
  checkIn: Date,
  checkOut: Date,
  eventDate: Date,
  amount: Number,
  deposit: Number,
  grossAmount: Number,
  receivedAmount: Number,
  platformCharge: Number,
  externalCharge: Number,
  /** Optional denormalized room name from external platform payloads. */
  roomName: String,
  /** Booking channel/platform for internal captures (direct, airbnb, booking.com, etc.). */
  platform: {
    type: String,
    trim: true,
    lowercase: true,
    default: 'direct',
  },
  /** Raw source tag from upstream system/platform payload. */
  source: { type: String, trim: true, lowercase: true },
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'checked-in', 'checked-out', 'cancelled'],
    default: 'pending',
  },
  notes: String,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  revenueTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' },
  debtorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Debtor' },
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
  receivableAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account' },
}, { timestamps: true });

bookingSchema.index({ checkIn: 1, checkOut: 1 });
bookingSchema.index({ status: 1 });

module.exports = mongoose.model('Booking', bookingSchema);
