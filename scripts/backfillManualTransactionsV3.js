/**
 * Mirror legacy manual finance transactions into v3 GL (financial_journal_entries / lines).
 * Use after deploying v3 statement mirroring for POST /transactions.
 *
 *   node scripts/backfillManualTransactionsV3.js
 *   node scripts/backfillManualTransactionsV3.js --dry-run
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Transaction = require('../src/models/Transaction');
const User = require('../src/models/User');
const {
  mirrorManualTransactionToV3Ledger,
  buildLines,
} = require('../src/services/transactionJournalService');

const dryRun = process.argv.includes('--dry-run');

async function main() {
  const uri = (process.env.MONGO_URI || process.env.MONGODB_URI || '').trim();
  if (!uri) {
    console.error('Missing MONGO_URI');
    process.exit(1);
  }
  await mongoose.connect(uri);

  const admin = await User.findOne({ role: { $in: ['admin', 'ceo', 'finance'] } }).select('_id').lean();
  if (!admin?._id) {
    console.error('No admin/ceo/finance user for createdBy');
    process.exit(1);
  }

  const candidates = await Transaction.find({
    source: 'manual',
    $or: [{ financialJournalEntryId: { $exists: false } }, { financialJournalEntryId: null }],
  })
    .sort({ date: 1 })
    .lean();

  let done = 0;
  let skipped = 0;
  for (const row of candidates) {
    try {
      buildLines(row);
    } catch (e) {
      console.warn(`[skip] tx ${row._id}: ${e.message}`);
      skipped += 1;
      continue;
    }
    if (dryRun) {
      console.log(`[dry-run] would mirror tx ${row._id}`);
      done += 1;
      continue;
    }
    const r = await mirrorManualTransactionToV3Ledger(row, admin._id);
    if (r.skipped) {
      skipped += 1;
      continue;
    }
    console.log(`[ok] tx ${row._id} → v3 ${r.financialJournalEntryId}`);
    await Transaction.updateOne({ _id: row._id }, { $set: { financialJournalEntryId: r.financialJournalEntryId } });
    done += 1;
  }

  console.log(JSON.stringify({ total: candidates.length, mirrored: done, skipped }, null, 2));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
