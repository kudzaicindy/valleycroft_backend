const mongoose = require('mongoose');

const reportSchema = new mongoose.Schema(
  {
    reportType: {
      type: String,
      required: true,
      enum: ['weekly', 'monthly', 'quarterly', 'annual', 'export', 'ai-summary', 'ai-summary-pdf'],
    },
    period: { type: String, default: null },
    format: { type: String, enum: ['json', 'pdf'], default: 'json' },
    generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    role: { type: String, default: null },
    sourcePath: { type: String, default: null },
    dateRange: {
      start: { type: Date, default: null },
      end: { type: Date, default: null },
    },
    data: { type: mongoose.Schema.Types.Mixed, default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true, collection: 'reports' }
);

module.exports = mongoose.model('Report', reportSchema);
