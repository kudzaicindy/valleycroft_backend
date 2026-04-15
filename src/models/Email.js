const mongoose = require('mongoose');

/**
 * Audit trail for transactional outbound mail (booking lifecycle, invoices).
 */
const emailSchema = new mongoose.Schema(
  {
    direction: { type: String, enum: ['outbound'], default: 'outbound' },
    templateKey: { type: String, required: true, index: true },
    status: { type: String, enum: ['sent', 'failed', 'skipped'], required: true, index: true },
    skipReason: String,
    from: String,
    to: String,
    subject: String,
    messageId: String,
    errorMessage: String,
    /** Plain-text excerpt for support (full body not stored by default) */
    textPreview: { type: String, maxlength: 4000 },
    relatedModel: { type: String, enum: ['GuestBooking', 'Booking'] },
    relatedId: { type: mongoose.Schema.Types.ObjectId, index: true },
  },
  { timestamps: true },
);

emailSchema.index({ createdAt: -1 });
emailSchema.index({ relatedModel: 1, relatedId: 1 });

module.exports = mongoose.model('Email', emailSchema);
