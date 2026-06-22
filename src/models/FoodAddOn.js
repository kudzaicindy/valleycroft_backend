const mongoose = require('mongoose');

const foodAddOnSchema = new mongoose.Schema(
  {
    addOnId: {
      type: String,
      required: true,
      unique: true,
      enum: ['breakfast', 'picnic'],
      index: true,
    },
    label: { type: String, required: true, trim: true },
    unitPrice: { type: Number, required: true, min: 0 },
    billing: {
      type: String,
      required: true,
      enum: ['per_person_per_morning', 'per_person_once'],
    },
    isActive: { type: Boolean, default: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

module.exports = mongoose.model('FoodAddOn', foodAddOnSchema);
