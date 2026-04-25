const mongoose = require('mongoose');
const Counter = require('./Counter');

const quotationLineItemSchema = new mongoose.Schema(
  {
    description: { type: String, required: true, trim: true },
    qty: { type: Number, required: true, min: 0 },
    unitPrice: { type: Number, required: true, min: 0 },
    total: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const quotationSchema = new mongoose.Schema(
  {
    quotationNumber: { type: String, unique: true, index: true },
    clientName: { type: String, required: true, trim: true },
    clientEmail: { type: String, trim: true, lowercase: true },
    clientPhone: { type: String, trim: true },
    eventTitle: { type: String, trim: true },
    eventType: { type: String, trim: true },
    eventDate: Date,
    venue: { type: String, trim: true },
    guestCount: { type: Number, min: 0, default: 0 },
    validUntil: Date,
    currency: { type: String, trim: true, default: 'ZAR' },
    lineItems: { type: [quotationLineItemSchema], default: [] },
    subtotal: { type: Number, default: 0, min: 0 },
    tax: { type: Number, default: 0, min: 0 },
    total: { type: Number, default: 0, min: 0 },
    notes: { type: String, trim: true },
    terms: { type: String, trim: true },
    status: {
      type: String,
      enum: ['draft', 'sent', 'accepted', 'rejected', 'expired'],
      default: 'draft',
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

quotationSchema.pre('validate', function (next) {
  const lineItems = Array.isArray(this.lineItems) ? this.lineItems : [];
  const computedSubtotal = lineItems.reduce((sum, item) => {
    const qty = Number(item.qty) || 0;
    const unitPrice = Number(item.unitPrice) || 0;
    item.total = Number((qty * unitPrice).toFixed(2));
    return sum + item.total;
  }, 0);
  this.subtotal = Number(computedSubtotal.toFixed(2));
  const tax = Number(this.tax) || 0;
  this.tax = Number(tax.toFixed(2));
  this.total = Number((this.subtotal + this.tax).toFixed(2));
  next();
});

quotationSchema.pre('save', async function (next) {
  if (this.isNew && !this.quotationNumber) {
    const year = new Date().getFullYear();
    const counter = await Counter.findOneAndUpdate(
      { _id: `quotation:${year}` },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    ).lean();
    this.quotationNumber = `QTN-${year}-${String(counter.seq).padStart(4, '0')}`;
  }
  next();
});

module.exports = mongoose.model('Quotation', quotationSchema);
