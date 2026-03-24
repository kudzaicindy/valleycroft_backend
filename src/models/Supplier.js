const mongoose = require('mongoose');

const supplierSchema = new mongoose.Schema({
  name: { type: String, required: true },
  contactEmail: String,
  contactPhone: String,
  category: String, // cleaning|food|maintenance|other
  bankDetails: {
    accountName: String,
    bank: String,
    accountNumber: String,
  },
  isActive: { type: Boolean, default: true },
  notes: String,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

module.exports = mongoose.model('Supplier', supplierSchema);
