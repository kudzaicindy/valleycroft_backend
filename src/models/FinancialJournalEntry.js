const mongoose = require('mongoose');
const { TRANSACTION_TYPES_V3 } = require('../constants/chartOfAccountsV3');
const { round2 } = require('../utils/math');

const journalEntryLineSchema = new mongoose.Schema(
  {
    accountCode: { type: String, required: true, trim: true },
    accountName: { type: String, required: true },
    accountType: {
      type: String,
      required: true,
      enum: ['asset', 'liability', 'equity', 'revenue', 'expense'],
    },
    debit: { type: Number, default: 0, min: 0 },
    credit: { type: Number, default: 0, min: 0 },
    description: { type: String, default: '' },
  },
  { _id: true }
);

journalEntryLineSchema.pre('validate', function (next) {
  const d = Number(this.debit) || 0;
  const c = Number(this.credit) || 0;
  if (d > 0 && c > 0) {
    return next(new Error('A journal line cannot have both debit and credit'));
  }
  if (d <= 0 && c <= 0) {
    return next(new Error('Each journal line must have either a debit or a credit'));
  }
  next();
});

function generatePublicTransactionId() {
  return `TXN${Date.now()}${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
}

const financialJournalEntrySchema = new mongoose.Schema(
  {
    journalId: { type: String, unique: true, sparse: true },
    /** Human-readable id for exports/UI (e.g. TXN1760601147221AB12CD) */
    publicTransactionId: { type: String, unique: true, sparse: true, trim: true },
    transactionType: {
      type: String,
      required: true,
      enum: TRANSACTION_TYPES_V3,
    },
    date: { type: Date, required: true, default: Date.now },
    description: { type: String, required: true },
    reference: { type: String },
    /** Balanced lines: Dr and Cr in one document (statements unwind this array). */
    entries: { type: [journalEntryLineSchema], default: [] },
    totalDebit: { type: Number, default: 0, min: 0 },
    totalCredit: { type: Number, default: 0, min: 0 },
    /** Provenance (optional), e.g. source payment / manual / booking */
    source: { type: String, trim: true },
    sourceModel: { type: String, trim: true },
    sourceId: { type: mongoose.Schema.Types.ObjectId },
    bookingRef: { type: mongoose.Schema.Types.ObjectId, ref: 'GuestBooking' },
    internalBookingRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
    employeeRef: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    supplierRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier' },
    equipmentRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Equipment' },
    refundRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Refund' },
    /** Set on reversal journals: the original (now voided) posting being offset in the audit trail. */
    reversesFinancialJournalEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'FinancialJournalEntry',
    },
    attachmentUrl: { type: String },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    isVoided: { type: Boolean, default: false },
    voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    voidedAt: { type: Date },
    voidReason: { type: String },
  },
  { collection: 'financial_journal_entries', timestamps: true }
);

financialJournalEntrySchema.pre('validate', function (next) {
  if (!this.publicTransactionId) {
    this.publicTransactionId = generatePublicTransactionId();
  }
  const arr = this.entries || [];
  if (arr.length < 2) {
    return next(new Error('A posted journal requires at least two entry lines'));
  }
  let dr = 0;
  let cr = 0;
  for (const e of arr) {
    dr += Number(e.debit) || 0;
    cr += Number(e.credit) || 0;
  }
  dr = round2(dr);
  cr = round2(cr);
  this.totalDebit = dr;
  this.totalCredit = cr;
  if (Math.abs(dr - cr) > 0.001) {
    return next(new Error(`Unbalanced journal: total debit ${dr} ≠ total credit ${cr}`));
  }
  next();
});

financialJournalEntrySchema.pre('save', async function (next) {
  if (this.journalId) return next();
  try {
    const year = new Date(this.date || Date.now()).getFullYear();
    const prefix = `JE-${year}-`;
    const count = await this.constructor.countDocuments({
      journalId: new RegExp(`^${prefix}`),
    });
    this.journalId = `${prefix}${String(count + 1).padStart(4, '0')}`;
    next();
  } catch (err) {
    next(err);
  }
});

financialJournalEntrySchema.index({ date: -1 });
financialJournalEntrySchema.index({ transactionType: 1, date: -1 });
financialJournalEntrySchema.index({ bookingRef: 1 });
financialJournalEntrySchema.index({ isVoided: 1 });
financialJournalEntrySchema.index({ 'entries.accountCode': 1, date: -1 });

module.exports = mongoose.model('FinancialJournalEntry', financialJournalEntrySchema);
