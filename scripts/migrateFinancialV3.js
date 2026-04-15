/**
 * Migrates v3 financial data after transactionType renames and COA note for 2010.
 *
 * 1. financial_journal_entries: deposit_* → security_deposit_* (idempotent).
 * 2. accounts: code 2010 gets description from CHART_OF_ACCOUNTS_V3 (if document exists).
 *
 * Usage: npm run migrate:financial-v3
 * Requires MONGO_URI or MONGODB_URI in .env (project root).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const {
  LEGACY_TRANSACTION_TYPE_RENAMES_V3,
  CHART_OF_ACCOUNTS_V3,
} = require('../src/constants/chartOfAccountsV3');

const JE_COLLECTION = 'financial_journal_entries';
const ACCOUNTS_COLLECTION = 'accounts';

async function migrateJournalTransactionTypes(db) {
  const col = db.collection(JE_COLLECTION);
  let totalModified = 0;

  for (const [from, to] of Object.entries(LEGACY_TRANSACTION_TYPE_RENAMES_V3)) {
    const result = await col.updateMany({ transactionType: from }, { $set: { transactionType: to } });
    console.log(
      `[journal] ${from} → ${to}: matched ${result.matchedCount}, modified ${result.modifiedCount}`
    );
    totalModified += result.modifiedCount;
  }

  const legacyKeys = Object.keys(LEGACY_TRANSACTION_TYPE_RENAMES_V3);
  const remaining = await col.countDocuments({ transactionType: { $in: legacyKeys } });
  if (remaining > 0) {
    console.warn('[journal] Warning: legacy transactionType values still present:', remaining);
  }

  return totalModified;
}

async function migrateAccount2010Description(db) {
  const col = db.collection(ACCOUNTS_COLLECTION);
  const meta = CHART_OF_ACCOUNTS_V3[2010];
  const note = meta && typeof meta === 'object' && meta.note ? meta.note : null;
  if (!note) {
    console.log('[accounts] Skip 2010 description: no note in CHART_OF_ACCOUNTS_V3');
    return { matched: 0, modified: 0 };
  }

  const result = await col.updateOne({ code: '2010' }, { $set: { description: note } });
  console.log(
    `[accounts] code 2010 description: matched ${result.matchedCount}, modified ${result.modifiedCount}`
  );
  if (result.matchedCount === 0) {
    console.log('[accounts] No account with code 2010 — create or seed chart first if needed.');
  }
  return { matched: result.matchedCount, modified: result.modifiedCount };
}

async function main() {
  const uri = (process.env.MONGO_URI || process.env.MONGODB_URI || '').trim();
  if (!uri) {
    console.error('Missing MONGO_URI (or MONGODB_URI) in .env');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('Connected:', mongoose.connection.host, mongoose.connection.name);

  const db = mongoose.connection.db;
  try {
    const jeModified = await migrateJournalTransactionTypes(db);
    const acc = await migrateAccount2010Description(db);
    console.log('\nSummary:');
    console.log(`  financial_journal_entries documents modified: ${jeModified}`);
    console.log(`  accounts (2010) matched: ${acc.matched}, modified: ${acc.modified}`);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
