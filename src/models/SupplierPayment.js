const mongoose = require('mongoose');

const supplierPaymentSchema = new mongoose.Schema({
  supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
  amount: Number,
  date: Date,
  description: String,
  invoiceNumber: String,
  paymentMethod: { type: String, enum: ['cash', 'EFT', 'card'] },
  attachmentUrl: String, // S3 URL
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

module.exports = mongoose.model('SupplierPayment', supplierPaymentSchema);
