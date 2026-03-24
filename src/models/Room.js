const mongoose = require('mongoose');

const roomSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: String,
  type: { type: String, enum: ['bnb', 'event-space'], required: true },
  capacity: Number,
  pricePerNight: Number,
  amenities: [String],
  images: [String],
  isAvailable: { type: Boolean, default: true },
  order: Number,
}, { timestamps: true });

module.exports = mongoose.model('Room', roomSchema);
