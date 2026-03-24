const mongoose = require('mongoose');

const equipmentSchema = new mongoose.Schema({
  name: { type: String, required: true },
  category: String, // appliance|furniture|machinery
  serialNumber: String,
  condition: {
    type: String,
    enum: ['good', 'fair', 'needs repair', 'out of service'],
  },
  purchaseDate: Date,
  lastServiced: Date,
  notes: String,
}, { timestamps: true });

module.exports = mongoose.model('Equipment', equipmentSchema);
