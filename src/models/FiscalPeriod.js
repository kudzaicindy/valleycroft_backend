const mongoose = require('mongoose');

const fiscalPeriodSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    isClosed: { type: Boolean, default: false },
  },
  { timestamps: true }
);

fiscalPeriodSchema.index({ startDate: 1, endDate: 1 });

module.exports = mongoose.model('FiscalPeriod', fiscalPeriodSchema);
