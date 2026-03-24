const mongoose = require('mongoose');

const workLogSchema = new mongoose.Schema({
  employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  date: { type: Date, default: Date.now },
  workDate: { type: Date }, // explicit work date (defaults to date if not set)
  period: { type: String, enum: ['daily', 'weekly'] },
  tasksAssigned: [String],
  workDone: { type: String, default: '' },
  hoursWorked: { type: Number },
  startTime: { type: String }, // e.g. "09:00"
  endTime: { type: String },   // e.g. "17:00"
  taskId: { type: mongoose.Schema.Types.ObjectId, ref: 'WorkLog' }, // optional link to assigned task entry
  dueDate: { type: Date }, // for task assignments
  photos: [String], // S3 URLs
}, { timestamps: true });

workLogSchema.index({ employee: 1, date: -1 });

module.exports = mongoose.model('WorkLog', workLogSchema);
