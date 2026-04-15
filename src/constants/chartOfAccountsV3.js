/**
 * Valley Croft — Financial Accounting Architecture v3.0 (Chynae Digital Solutions).
 * Single source: `ACCOUNTS_V3_SEED` drives Mongo `Account` documents and `CHART_OF_ACCOUNTS_V3` for GL line helpers.
 */

/**
 * Full rows for `Account` model (upsert by `code`). Matches §2 of the architecture guide.
 * @type {Array<{ code: string, name: string, type: string, subType: string, normalBalance: string, description?: string }>}
 */
const ACCOUNTS_V3_SEED = [
  { code: '1001', name: 'Cash / Bank', type: 'ASSET', subType: 'CURRENT_ASSET', normalBalance: 'DEBIT' },
  { code: '1002', name: 'Petty Cash', type: 'ASSET', subType: 'CURRENT_ASSET', normalBalance: 'DEBIT' },
  { code: '1010', name: 'Accounts Receivable', type: 'ASSET', subType: 'CURRENT_ASSET', normalBalance: 'DEBIT' },
  { code: '1050', name: 'Prepaid Expenses', type: 'ASSET', subType: 'CURRENT_ASSET', normalBalance: 'DEBIT' },
  { code: '1100', name: 'Equipment', type: 'ASSET', subType: 'FIXED_ASSET', normalBalance: 'DEBIT' },
  {
    code: '1101',
    name: 'Accumulated Depreciation',
    type: 'ASSET',
    subType: 'ACCUMULATED_DEPRECIATION',
    normalBalance: 'CREDIT',
  },
  { code: '2001', name: 'Accounts Payable', type: 'LIABILITY', subType: 'CURRENT_LIABILITY', normalBalance: 'CREDIT' },
  {
    code: '2010',
    name: 'Deposit Liability',
    type: 'LIABILITY',
    subType: 'CURRENT_LIABILITY',
    normalBalance: 'CREDIT',
    description: 'Refundable security deposits only — not partial booking payments.',
  },
  {
    code: '2020',
    name: 'Salaries Payable',
    type: 'LIABILITY',
    subType: 'CURRENT_LIABILITY',
    normalBalance: 'CREDIT',
  },
  { code: '3001', name: "Owner's Capital", type: 'EQUITY', subType: 'SHARE_CAPITAL', normalBalance: 'CREDIT' },
  {
    code: '3002',
    name: "Owner's Drawings",
    type: 'EQUITY',
    subType: 'OTHER_EQUITY',
    normalBalance: 'DEBIT',
  },
  {
    code: '3003',
    name: 'Retained Earnings',
    type: 'EQUITY',
    subType: 'RETAINED_EARNINGS',
    normalBalance: 'CREDIT',
  },
  { code: '4001', name: 'BnB Revenue', type: 'REVENUE', subType: 'OPERATING_REVENUE', normalBalance: 'CREDIT' },
  { code: '4002', name: 'Event Revenue', type: 'REVENUE', subType: 'OPERATING_REVENUE', normalBalance: 'CREDIT' },
  { code: '4003', name: 'Other Income', type: 'REVENUE', subType: 'OTHER_REVENUE', normalBalance: 'CREDIT' },
  {
    code: '4010',
    name: 'Refunds & Allowances',
    type: 'REVENUE',
    subType: 'OTHER_REVENUE',
    normalBalance: 'DEBIT',
    description: 'Contra-revenue — separate line on income statement; do not net into 4001.',
  },
  {
    code: '5001',
    name: 'Consumables & Toiletries',
    type: 'EXPENSE',
    subType: 'COGS',
    normalBalance: 'DEBIT',
  },
  { code: '5002', name: 'Cleaning Supplies', type: 'EXPENSE', subType: 'COGS', normalBalance: 'DEBIT' },
  { code: '6001', name: 'Salaries & Wages', type: 'EXPENSE', subType: 'OPERATING_EXPENSE', normalBalance: 'DEBIT' },
  { code: '6002', name: 'Staff Task Payments', type: 'EXPENSE', subType: 'OPERATING_EXPENSE', normalBalance: 'DEBIT' },
  { code: '6010', name: 'Supplier — Cleaning', type: 'EXPENSE', subType: 'OPERATING_EXPENSE', normalBalance: 'DEBIT' },
  { code: '6011', name: 'Supplier — Food & Catering', type: 'EXPENSE', subType: 'OPERATING_EXPENSE', normalBalance: 'DEBIT' },
  { code: '6012', name: 'Supplier — Maintenance', type: 'EXPENSE', subType: 'OPERATING_EXPENSE', normalBalance: 'DEBIT' },
  { code: '6013', name: 'Supplier — Other', type: 'EXPENSE', subType: 'OPERATING_EXPENSE', normalBalance: 'DEBIT' },
  { code: '6020', name: 'Utilities', type: 'EXPENSE', subType: 'OPERATING_EXPENSE', normalBalance: 'DEBIT' },
  { code: '6021', name: 'Maintenance & Repairs', type: 'EXPENSE', subType: 'OPERATING_EXPENSE', normalBalance: 'DEBIT' },
  { code: '6022', name: 'Marketing & Advertising', type: 'EXPENSE', subType: 'OPERATING_EXPENSE', normalBalance: 'DEBIT' },
  { code: '6023', name: 'Bank Charges', type: 'EXPENSE', subType: 'OPERATING_EXPENSE', normalBalance: 'DEBIT' },
  { code: '6024', name: 'Petty Cash Expenses', type: 'EXPENSE', subType: 'OPERATING_EXPENSE', normalBalance: 'DEBIT' },
  { code: '6030', name: 'Depreciation Expense', type: 'EXPENSE', subType: 'DEPRECIATION', normalBalance: 'DEBIT' },
  { code: '6031', name: 'Management Fee', type: 'EXPENSE', subType: 'OPERATING_EXPENSE', normalBalance: 'DEBIT' },
];

const V3_ACCOUNT_CODES = ACCOUNTS_V3_SEED.map((a) => a.code);

/** For `financialGlPostingService` / v3 line payloads: lowercase accountType + optional note */
function buildChartLookup() {
  const chart = {};
  for (const a of ACCOUNTS_V3_SEED) {
    const n = Number(a.code);
    const entry = {
      name: a.name,
      accountType: a.type.toLowerCase(),
    };
    if (a.description) entry.note = a.description;
    chart[n] = entry;
  }
  return chart;
}

const CHART_OF_ACCOUNTS_V3 = buildChartLookup();

/**
 * One-line meanings for ledger readers, UI tooltips, and API docs.
 * Keys are the canonical `transactionType` enum (single source of truth).
 */
const TRANSACTION_TYPE_DESCRIPTIONS_V3 = {
  booking_revenue: 'BnB booking confirmed — revenue recognised against guest AR.',
  booking_revenue_reversal:
    'Reversal of booking/event revenue — posted when a confirmed stay is cancelled; offsets original recognition (original journal is then voided).',
  booking_payment:
    'Guest cash payment clearing AR when partial vs balance is not split (generic JE-02).',
  booking_deposit_received: 'Partial payment received and applied against guest accounts receivable.',
  booking_balance_received:
    'Remaining booking balance received (e.g. on arrival or checkout), clearing AR.',
  security_deposit_received:
    'Refundable security deposit received — cash in, liability 2010 (not booking revenue).',
  security_deposit_earned:
    'Security deposit recognised as earned revenue after stay (liability 2010 released).',
  security_deposit_refunded:
    'Refundable security deposit returned to guest — liability cleared, cash out.',
  event_revenue: 'Event booking confirmed — revenue recognised.',
  salary_payment: 'Staff salary paid from bank.',
  staff_task_payment: 'Ad hoc task payment to staff from bank.',
  supplier_payment: 'Payment to supplier from bank.',
  utility_payment: 'Utility bill paid from bank.',
  maintenance_expense: 'Maintenance / repair expense paid from bank.',
  consumables_purchase: 'Consumables or cost-of-sales purchase from bank.',
  equipment_purchase: 'Capital equipment acquired from bank (investing cash flow).',
  depreciation: 'Non-cash depreciation expense and accumulated depreciation.',
  refund_issued: 'Refund to guest after revenue was recognised (contra-revenue 4010).',
  owner_investment: 'Owner capital contributed (cash in, equity up).',
  owner_drawing: 'Owner withdrawal (drawings equity, cash out — not P&L).',
  bank_charge: 'Bank fees and charges.',
  petty_cash: 'Petty cash movement or small cash expense.',
  other_income: 'Miscellaneous income.',
  other_expense: 'Miscellaneous expense.',
  management_fee_accrual: 'Management fee expense accrued to accounts payable.',
  management_fee_payment: 'Management fee paid — clears AP, cash out.',
};

const TRANSACTION_TYPES_V3 = Object.keys(TRANSACTION_TYPE_DESCRIPTIONS_V3);

/** Old `transactionType` strings → current enum (for one-off DB migration). */
const LEGACY_TRANSACTION_TYPE_RENAMES_V3 = {
  deposit_received: 'security_deposit_received',
  deposit_earned: 'security_deposit_earned',
  deposit_refund: 'security_deposit_refunded',
};

module.exports = {
  ACCOUNTS_V3_SEED,
  V3_ACCOUNT_CODES,
  CHART_OF_ACCOUNTS_V3,
  TRANSACTION_TYPES_V3,
  TRANSACTION_TYPE_DESCRIPTIONS_V3,
  LEGACY_TRANSACTION_TYPE_RENAMES_V3,
};
