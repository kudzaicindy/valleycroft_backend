const mongoose = require('mongoose');

const guestBookingSchema = new mongoose.Schema({
  guestName: { type: String, required: true },
  guestEmail: { type: String, required: true },
  guestPhone: String,
  roomId: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', required: true },
  checkIn: Date,
  checkOut: Date,
  guestCount: { type: Number, min: 0, default: 0 },
  foodAddOns: {
    breakfast: { type: Boolean, default: false },
    picnic: { type: Boolean, default: false },
  },
  /** Snapshot of room + food line items at booking time */
  pricingBreakdown: {
    nights: Number,
    roomTotal: Number,
    foodTotal: Number,
    lineItems: [{
      id: String,
      label: String,
      rateLabel: String,
      unitPrice: Number,
      qty: Number,
      total: Number,
    }],
  },
  /** Room portion (ZAR) — snapshot at booking */
  roomAmount: { type: Number, min: 0 },
  /** Food add-ons portion (ZAR) — snapshot at booking */
  foodAmount: { type: Number, min: 0, default: 0 },
  totalAmount: Number,
  deposit: Number,
  status: { type: String, enum: ['pending', 'confirmed', 'cancelled'], default: 'pending' },
  trackingCode: { type: String, unique: true, required: true },
  source: { type: String, default: 'website' },
  notes: String,
  /** Filled when status → confirmed: revenue transaction + debtor for statements */
  revenueTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' },
  /** Room portion (category booking); mirrors revenueTransactionId for split revenue */
  roomRevenueTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' },
  /** Food add-ons portion (category catering) */
  foodRevenueTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' },
  debtorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Debtor' },
  /** Guest invoice created on confirm */
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
  /** Child GL A/R for this guest (code like 1010-{guestBookingId}) */
  receivableAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account' },
}, { timestamps: true });

guestBookingSchema.index({ guestEmail: 1 });

module.exports = mongoose.model('GuestBooking', guestBookingSchema);
