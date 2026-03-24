const mongoose = require('mongoose');

const refundSchema = new mongoose.Schema({
  guestName: String,
  guestEmail: String,
  bookingRef: mongoose.Schema.Types.ObjectId, // Booking or GuestBooking
  amount: Number,
  reason: String,
  status: {
    type: String,
    enum: ['pending', 'approved', 'processed', 'rejected'],
    default: 'pending',
  },
  processedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  processedOn: Date,
  notes: String,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

module.exports = mongoose.model('Refund', refundSchema);
