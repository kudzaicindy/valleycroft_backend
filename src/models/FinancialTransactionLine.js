/**
 * Legacy collection used before journal lines were embedded on `FinancialJournalEntry`.
 * New v3 journals do not insert here; use `npm run migrate:embed-journal-entries` for old rows.
 */
const mongoose = require('mongoose');

const financialTransactionLineSchema = new mongoose.Schema(
  {
    journalEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'FinancialJournalEntry',
      required: true,
    },
    accountCode: { type: String, required: true },
    accountName: { type: String, required: true },
    accountType: {
      type: String,
      required: true,
      enum: ['asset', 'liability', 'equity', 'revenue', 'expense'],
    },
    side: { type: String, required: true, enum: ['DR', 'CR'] },
    amount: { type: Number, required: true, min: 0 },
    date: { type: Date, required: true },
  },
  { collection: 'financial_transaction_lines', timestamps: true }
);

financialTransactionLineSchema.index({ accountCode: 1, date: -1 });
financialTransactionLineSchema.index({ journalEntryId: 1 });
financialTransactionLineSchema.index({ accountType: 1, date: -1 });
financialTransactionLineSchema.index({ date: -1 });

module.exports = mongoose.model('FinancialTransactionLine', financialTransactionLineSchema);
