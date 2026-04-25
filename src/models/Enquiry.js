const mongoose = require('mongoose');

const enquirySchema = new mongoose.Schema(
  {
    guestName: { type: String, required: true, trim: true },
    guestEmail: { type: String, required: true, trim: true, lowercase: true },
    guestPhone: { type: String, trim: true },
    eventTitle: { type: String, trim: true },
    eventType: { type: String, trim: true },
    eventDate: { type: Date },
    venue: { type: String, trim: true },
    guestCount: { type: Number, min: 0, default: 0 },
    subject: { type: String, trim: true },
    message: { type: String, trim: true, required: true },
    status: {
      type: String,
      enum: ['new', 'responded', 'closed'],
      default: 'new',
      index: true,
    },
    adminNotes: { type: String, trim: true },
    responseMessage: { type: String, trim: true },
    respondedAt: { type: Date },
    respondedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    quotationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Quotation' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Enquiry', enquirySchema);
