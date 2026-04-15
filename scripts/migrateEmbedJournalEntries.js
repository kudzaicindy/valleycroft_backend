/**
 * Copies legacy `financial_transaction_lines` into `financial_journal_entries.entries`
 * (debit/credit per line). Required once after deploying embedded-entry journals so v3
 * statements include historical data.
 *
 *   npm run migrate:embed-journal-entries
 *
 * Idempotent: skips documents that already have `entries[0]`.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const { round2 } = require('../src/utils/math');

async function main() {
  const uri = (process.env.MONGO_URI || process.env.MONGODB_URI || '').trim();
  if (!uri) {
    console.error('Missing MONGO_URI');
    process.exit(1);
  }
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const jeCol = db.collection('financial_journal_entries');
  const lineCol = db.collection('financial_transaction_lines');

  const candidates = await jeCol
    .find({ $or: [{ entries: { $exists: false } }, { entries: { $size: 0 } }] })
    .toArray();

  let embedded = 0;
  let skipped = 0;
  for (const doc of candidates) {
    const lines = await lineCol.find({ journalEntryId: doc._id }).sort({ accountCode: 1 }).toArray();
    if (lines.length < 2) {
      skipped += 1;
      console.warn(`[skip] JE ${doc._id}: ${lines.length} line(s) in financial_transaction_lines`);
      continue;
    }
    const entries = lines.map((l) => ({
      accountCode: String(l.accountCode),
      accountName: l.accountName,
      accountType: l.accountType,
      debit: l.side === 'DR' ? round2(l.amount) : 0,
      credit: l.side === 'CR' ? round2(l.amount) : 0,
      description: '',
    }));
    const totalDebit = round2(entries.reduce((s, e) => s + e.debit, 0));
    const totalCredit = round2(entries.reduce((s, e) => s + e.credit, 0));
    const publicTransactionId =
      doc.publicTransactionId || `TXN-MIG-${doc._id.toString()}`;

    await jeCol.updateOne(
      { _id: doc._id },
      { $set: { entries, totalDebit, totalCredit, publicTransactionId } }
    );
    embedded += 1;
  }

  console.log(JSON.stringify({ candidates: candidates.length, embedded, skipped }, null, 2));
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
