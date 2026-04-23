const mongoose = require('mongoose');

/** Operational cash spend: staff/worker payments, supplier buys, BnB supplies, etc. */
const expenseSchema = new mongoose.Schema(
  {
    amount: { type: Number, required: true, min: 0 },
    date: { type: Date, default: Date.now },
    description: { type: String, trim: true, default: '' },
    /** What kind of spend this row represents (for reporting filters). */
    expenseKind: {
      type: String,
      enum: [
        'worker_payment',
        'supplier',
        'bnb_supply',
        'utilities',
        'maintenance',
        'marketing',
        'bank_fees',
        'other',
      ],
      default: 'other',
    },
    paymentMethod: {
      type: String,
      enum: ['cash', 'EFT', 'card', 'other'],
      default: 'other',
    },
    reference: { type: String, trim: true },
    /** Optional link to staff member paid (e.g. task / casual labour). */
    staff: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', default: null },
    /** If this row was mirrored or generated from finance `Transaction` (type expense). */
    transaction: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },
    financialJournalEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'FinancialJournalEntry',
      default: null,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

expenseSchema.index({ date: -1 });
expenseSchema.index({ expenseKind: 1, date: -1 });

module.exports = mongoose.model('Expense', expenseSchema);
