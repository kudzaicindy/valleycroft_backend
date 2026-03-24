const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  role: String,
  action: {
    type: String,
    enum: ['create', 'update', 'delete', 'login', 'logout', 'export'],
    required: true,
  },
  entity: String, // e.g. 'Booking', 'Transaction', 'Refund'
  entityId: mongoose.Schema.Types.ObjectId,
  before: mongoose.Schema.Types.Mixed,
  after: mongoose.Schema.Types.Mixed,
  ip: String,
  userAgent: String,
  timestamp: { type: Date, default: Date.now },
}, { timestamps: false });

auditLogSchema.index({ userId: 1, timestamp: -1 });
auditLogSchema.index({ entity: 1, timestamp: -1 });
auditLogSchema.index({ timestamp: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
