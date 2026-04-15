/**
 * Upserts the Chynae Digital Solutions v3.0 chart of accounts into MongoDB (`accounts` collection).
 *
 * Usage: npm run seed:chart-v3
 * Requires MONGO_URI (or MONGODB_URI) in .env.
 *
 * - Creates or updates each code in ACCOUNTS_V3_SEED (name, type, subType, normalBalance, description).
 * - Sets accountKind to `standard` and isActive true.
 * - Does not delete legacy codes; use manual cleanup or a separate migration if you retire old accounts.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const Account = require('../src/models/Account');
const User = require('../src/models/User');
const { ACCOUNTS_V3_SEED, V3_ACCOUNT_CODES } = require('../src/constants/chartOfAccountsV3');

async function main() {
  const uri = (process.env.MONGO_URI || process.env.MONGODB_URI || '').trim();
  if (!uri) {
    console.error('Missing MONGO_URI (or MONGODB_URI) in .env');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('Connected:', mongoose.connection.host, mongoose.connection.name);

  const admin = await User.findOne({ role: { $in: ['admin', 'ceo'] } }).select('_id').lean();
  const createdBy = admin?._id;
  if (!createdBy) {
    console.warn('[seed] No admin/ceo user found — accounts will upsert without createdBy.');
  }

  let upserted = 0;
  for (const row of ACCOUNTS_V3_SEED) {
    const set = {
      name: row.name,
      type: row.type,
      subType: row.subType,
      normalBalance: row.normalBalance,
      isActive: true,
      accountKind: 'standard',
    };
    if (row.description != null && row.description !== '') {
      set.description = row.description;
    }
    if (createdBy) set.createdBy = createdBy;

    await Account.findOneAndUpdate(
      { code: row.code },
      { $set: set },
      { upsert: true, new: true, runValidators: true }
    );
    upserted += 1;
  }

  const count = await Account.countDocuments({ code: { $in: V3_ACCOUNT_CODES } });
  console.log(`Upserted ${upserted} v3 chart rows. Active matches for v3 codes: ${count}.`);
  console.log('Codes:', V3_ACCOUNT_CODES.join(', '));

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
