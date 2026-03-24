const mongoose = require('mongoose');

const stockSchema = new mongoose.Schema({
  name: { type: String, required: true },
  category: String, // toiletries|cleaning|kitchen
  quantity: { type: Number, default: 0 },
  unit: String, // units|litres|kg
  reorderLevel: Number,
  lastRestocked: Date,
}, { timestamps: true });

module.exports = mongoose.model('Stock', stockSchema);
