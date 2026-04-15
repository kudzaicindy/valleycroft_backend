/**
 * Create Chynae v3 JE-01 headers + lines for guest bookings that already have
 * `Transaction` (guest_booking_confirm) but no `financialJournalEntryId` — e.g. confirms
 * that ran before v3 GL was deployed.
 *
 * Usage:
 *   node scripts/backfillGuestBookingV3Journals.js           # apply
 *   node scripts/backfillGuestBookingV3Journals.js --dry-run
 *
 * Requires MONGO_URI (or MONGODB_URI) and at least one admin/ceo user for createdBy.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Transaction = require('../src/models/Transaction');
const GuestBooking = require('../src/models/GuestBooking');
const FinancialJournalEntry = require('../src/models/FinancialJournalEntry');
const User = require('../src/models/User');
const financialGlPostingService = require('../src/services/financialGlPostingService');

const dryRun = process.argv.includes('--dry-run');

async function main() {
  const uri = (process.env.MONGO_URI || process.env.MONGODB_URI || '').trim();
  if (!uri) {
    console.error('Missing MONGO_URI (or MONGODB_URI) in .env');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('Connected:', mongoose.connection.host, mongoose.connection.name);
  if (dryRun) console.log('[dry-run] No writes will be performed.\n');

  const admin = await User.findOne({ role: { $in: ['admin', 'ceo'] } }).select('_id').lean();
  if (!admin?._id) {
    console.error('No admin or ceo user found — cannot set createdBy on journal entries.');
    process.exit(1);
  }
  const userId = admin._id;

  const txs = await Transaction.find({
    source: 'guest_booking_confirm',
    guestBooking: { $exists: true, $ne: null },
    $or: [{ financialJournalEntryId: { $exists: false } }, { financialJournalEntryId: null }],
  })
    .sort({ date: 1 })
    .lean();

  let linked = 0;
  let posted = 0;
  let skipped = 0;

  for (const tx of txs) {
    const gb = await GuestBooking.findById(tx.guestBooking).lean();
    if (!gb) {
      console.warn(`[skip] tx ${tx._id}: guest booking missing`);
      skipped += 1;
      continue;
    }
    if (gb.status !== 'confirmed') {
      console.warn(`[skip] tx ${tx._id}: booking ${gb._id} status=${gb.status}`);
      skipped += 1;
      continue;
    }

    const txAmt = Number(tx.amount) || 0;
    const gbAmt = Number(gb.totalAmount) || 0;
    if (Math.abs(txAmt - gbAmt) > 0.01) {
      console.warn(
        `[warn] tx ${tx._id} amount ${txAmt} ≠ guestBooking.totalAmount ${gbAmt} — posting uses guest booking total`
      );
    }

    const existing = await FinancialJournalEntry.findOne({
      bookingRef: gb._id,
      isVoided: false,
    })
      .select('_id')
      .lean();

    if (existing) {
      console.log(`[link] tx ${tx._id} → existing JE ${existing._id} (bookingRef)`);
      if (!dryRun) {
        await Transaction.updateOne({ _id: tx._id }, { $set: { financialJournalEntryId: existing._id } });
      }
      linked += 1;
      continue;
    }

    console.log(
      `[post] tx ${tx._id} booking ${gb._id} ${gb.trackingCode || ''} amount=${gbAmt} date=${tx.date?.toISOString?.() || tx.date}`
    );
    if (dryRun) {
      posted += 1;
      continue;
    }

    const je = await financialGlPostingService.postGuestBookingRevenueV3(gb, userId, {
      journalDate: tx.date || gb.updatedAt || gb.createdAt,
    });
    await Transaction.updateOne({ _id: tx._id }, { $set: { financialJournalEntryId: je._id } });
    posted += 1;
  }

  console.log(
    JSON.stringify({ totalCandidates: txs.length, linkedExisting: linked, postedNew: posted, skipped }, null, 2)
  );
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
