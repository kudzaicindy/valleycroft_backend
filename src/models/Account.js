const mongoose = require('mongoose');

const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'];
const NORMAL_BALANCE = ['DEBIT', 'CREDIT'];

const SUB_TYPES = [
  'CURRENT_ASSET',
  'FIXED_ASSET',
  'ACCUMULATED_DEPRECIATION',
  'INTANGIBLE_ASSET',
  'LONG_TERM_INVESTMENT',
  'CURRENT_LIABILITY',
  'LONG_TERM_LIABILITY',
  'SHARE_CAPITAL',
  'RETAINED_EARNINGS',
  'DIVIDENDS',
  'OTHER_EQUITY',
  'OPERATING_REVENUE',
  'OTHER_REVENUE',
  'COGS',
  'OPERATING_EXPENSE',
  'DEPRECIATION',
  'INTEREST_EXPENSE',
  'TAX_EXPENSE',
];

const accountSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true },
    type: { type: String, required: true, enum: ACCOUNT_TYPES },
    subType: { type: String, required: true, enum: SUB_TYPES },
    normalBalance: { type: String, required: true, enum: NORMAL_BALANCE },
    isActive: { type: Boolean, default: true },
    /** Parent control account code in chart (e.g. 1010 for child guest A/R) */
    parentCode: { type: String, trim: true },
    accountKind: {
      type: String,
      enum: ['standard', 'guest_receivable'],
      default: 'standard',
    },
    guestBooking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'GuestBooking',
      unique: true,
      sparse: true,
    },
    internalBooking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      unique: true,
      sparse: true,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

accountSchema.index({ type: 1, subType: 1 });

module.exports = mongoose.model('Account', accountSchema);
module.exports.ACCOUNT_TYPES = ACCOUNT_TYPES;
module.exports.SUB_TYPES = SUB_TYPES;
