/**
 * Seed chart of accounts (double-entry). Run: npm run seed:accounting
 * Also used by seed:all — export seedChartOfAccounts() when DB is already connected.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Account = require('../src/models/Account');

const CHART = [
  ['1001', 'Cash', 'ASSET', 'CURRENT_ASSET', 'DEBIT'],
  ['1002', 'Bank Account', 'ASSET', 'CURRENT_ASSET', 'DEBIT'],
  ['1010', 'Accounts Receivable', 'ASSET', 'CURRENT_ASSET', 'DEBIT'],
  ['1020', 'Inventory', 'ASSET', 'CURRENT_ASSET', 'DEBIT'],
  ['1030', 'Prepaid Expenses', 'ASSET', 'CURRENT_ASSET', 'DEBIT'],
  ['1100', 'Property, Plant & Equipment', 'ASSET', 'FIXED_ASSET', 'DEBIT'],
  ['1110', 'Accumulated Depreciation', 'ASSET', 'ACCUMULATED_DEPRECIATION', 'CREDIT'],
  ['1200', 'Intangible Assets', 'ASSET', 'INTANGIBLE_ASSET', 'DEBIT'],
  ['2001', 'Accounts Payable', 'LIABILITY', 'CURRENT_LIABILITY', 'CREDIT'],
  ['2010', 'Accrued Expenses', 'LIABILITY', 'CURRENT_LIABILITY', 'CREDIT'],
  ['2020', 'Short-term Loan', 'LIABILITY', 'CURRENT_LIABILITY', 'CREDIT'],
  ['2030', 'Deferred Revenue', 'LIABILITY', 'CURRENT_LIABILITY', 'CREDIT'],
  ['2100', 'Long-term Debt', 'LIABILITY', 'LONG_TERM_LIABILITY', 'CREDIT'],
  ['2110', 'Deferred Tax Liability', 'LIABILITY', 'LONG_TERM_LIABILITY', 'CREDIT'],
  ['3001', 'Share Capital', 'EQUITY', 'SHARE_CAPITAL', 'CREDIT'],
  ['3010', 'Retained Earnings', 'EQUITY', 'RETAINED_EARNINGS', 'CREDIT'],
  ['3020', 'Dividends Paid', 'EQUITY', 'DIVIDENDS', 'DEBIT'],
  ['4001', 'Sales Revenue', 'REVENUE', 'OPERATING_REVENUE', 'CREDIT'],
  ['4002', 'Service Revenue', 'REVENUE', 'OPERATING_REVENUE', 'CREDIT'],
  ['4010', 'Interest Income', 'REVENUE', 'OTHER_REVENUE', 'CREDIT'],
  ['4020', 'Other Income', 'REVENUE', 'OTHER_REVENUE', 'CREDIT'],
  ['5001', 'Cost of Goods Sold', 'EXPENSE', 'COGS', 'DEBIT'],
  ['5002', 'Direct Labour', 'EXPENSE', 'COGS', 'DEBIT'],
  ['6001', 'Salaries & Wages', 'EXPENSE', 'OPERATING_EXPENSE', 'DEBIT'],
  ['6002', 'Rent Expense', 'EXPENSE', 'OPERATING_EXPENSE', 'DEBIT'],
  ['6003', 'Utilities Expense', 'EXPENSE', 'OPERATING_EXPENSE', 'DEBIT'],
  ['6004', 'Marketing & Advertising', 'EXPENSE', 'OPERATING_EXPENSE', 'DEBIT'],
  ['6005', 'Office Supplies', 'EXPENSE', 'OPERATING_EXPENSE', 'DEBIT'],
  ['6010', 'Depreciation Expense', 'EXPENSE', 'DEPRECIATION', 'DEBIT'],
  ['6011', 'Amortisation Expense', 'EXPENSE', 'DEPRECIATION', 'DEBIT'],
  ['7001', 'Interest Expense', 'EXPENSE', 'INTEREST_EXPENSE', 'DEBIT'],
  ['8001', 'Income Tax Expense', 'EXPENSE', 'TAX_EXPENSE', 'DEBIT'],
];

/**
 * Create any missing accounts from CHART. Assumes mongoose is already connected.
 * @returns {Promise<{ created: number, total: number }>}
 */
async function seedChartOfAccounts() {
  let created = 0;
  for (const [code, name, type, subType, normalBalance] of CHART) {
    const exists = await Account.findOne({ code });
    if (exists) continue;
    await Account.create({ code, name, type, subType, normalBalance, isActive: true });
    created += 1;
    console.log('Created account', code);
  }
  const total = await Account.countDocuments();
  return { created, total };
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected');
  const { created, total } = await seedChartOfAccounts();
  console.log(`Done. Created ${created} accounts (skipped existing). Total accounts: ${total}.`);
  await mongoose.disconnect();
  process.exit(0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { seedChartOfAccounts, CHART };
