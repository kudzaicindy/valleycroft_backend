const mongoose = require('mongoose');

const lineItemSchema = new mongoose.Schema({
  description: String,
  qty: Number,
  unitPrice: Number,
  total: Number,
}, { _id: false });

const invoiceSchema = new mongoose.Schema({
  type: { type: String, enum: ['guest', 'supplier'], required: true },
  relatedTo: mongoose.Schema.Types.ObjectId, // Booking or Supplier
  invoiceNumber: { type: String, unique: true },
  issueDate: Date,
  dueDate: Date,
  lineItems: [lineItemSchema],
  subtotal: Number,
  tax: Number,
  total: Number,
  status: {
    type: String,
    enum: ['draft', 'sent', 'paid', 'void'],
    default: 'draft',
  },
  notes: String,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

invoiceSchema.pre('save', async function (next) {
  if (this.isNew && !this.invoiceNumber) {
    const year = new Date().getFullYear();
    const count = await this.constructor.countDocuments({
      invoiceNumber: new RegExp(`^INV-${year}-`),
    });
    this.invoiceNumber = `INV-${year}-${String(count + 1).padStart(4, '0')}`;
  }
  next();
});

module.exports = mongoose.model('Invoice', invoiceSchema);
