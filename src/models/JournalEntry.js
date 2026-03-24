const mongoose = require('mongoose');

const journalLineSchema = new mongoose.Schema(
  {
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Account', required: true },
    debit: { type: Number, default: 0, min: 0 },
    credit: { type: Number, default: 0, min: 0 },
    description: String,
  },
  { _id: true }
);

journalLineSchema.pre('validate', function (next) {
  if (this.debit > 0 && this.credit > 0) {
    return next(new Error('A journal line cannot have both debit and credit'));
  }
  next();
});

const journalEntrySchema = new mongoose.Schema(
  {
    entryDate: { type: Date, required: true },
    periodId: { type: mongoose.Schema.Types.ObjectId, ref: 'FiscalPeriod' },
    reference: String,
    description: { type: String, required: true },
    entryType: {
      type: String,
      enum: ['MANUAL', 'AUTO', 'ADJUSTMENT', 'CLOSING'],
      default: 'MANUAL',
    },
    status: {
      type: String,
      enum: ['DRAFT', 'POSTED', 'VOIDED'],
      default: 'POSTED',
    },
    lines: { type: [journalLineSchema], validate: [(v) => v && v.length >= 2, 'At least two lines required'] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    voidedAt: Date,
    voidedReason: String,
  },
  { timestamps: true }
);

journalEntrySchema.pre('save', function (next) {
  if (this.status !== 'POSTED' || !this.lines?.length) return next();
  const d = this.lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const c = this.lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  if (Math.abs(d - c) > 0.01) {
    return next(new Error(`Unbalanced journal entry — debits: ${d.toFixed(2)}, credits: ${c.toFixed(2)}`));
  }
  next();
});

journalEntrySchema.index({ entryDate: 1 });
journalEntrySchema.index({ status: 1, entryDate: -1 });

module.exports = mongoose.model('JournalEntry', journalEntrySchema);
