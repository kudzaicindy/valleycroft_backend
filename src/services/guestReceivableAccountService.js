/**
 * Child A/R GL account per guest booking / internal booking (code like 1010-{bookingId}).
 */
const Account = require('../models/Account');
const accountCodeService = require('./accountCodeService');

const PARENT_AR_CODE = '1010';

/**
 * @returns {Promise<import('../models/Account')>}
 */
async function ensureForGuestBooking(gb, userId) {
  if (gb.receivableAccountId) {
    const existing = await Account.findById(gb.receivableAccountId);
    if (existing && existing.isActive !== false) return existing;
  }

  const code = await accountCodeService.generateAccountCode({
    strategy: 'suffix',
    prefix: PARENT_AR_CODE,
    entityId: gb._id,
  });
  const name = `AR — ${gb.guestName} (${gb.trackingCode || gb._id})`;

  const acc = await Account.create({
    code,
    name,
    type: 'ASSET',
    subType: 'CURRENT_ASSET',
    normalBalance: 'DEBIT',
    isActive: true,
    parentCode: PARENT_AR_CODE,
    accountKind: 'guest_receivable',
    guestBooking: gb._id,
    createdBy: userId || undefined,
  });

  gb.receivableAccountId = acc._id;
  await gb.save();
  return acc;
}

/**
 * @param {import('mongoose').Document} b - internal Booking
 */
async function ensureForInternalBooking(b, userId) {
  if (b.receivableAccountId) {
    const existing = await Account.findById(b.receivableAccountId);
    if (existing && existing.isActive !== false) return existing;
  }

  const code = await accountCodeService.generateAccountCode({
    strategy: 'suffix',
    prefix: PARENT_AR_CODE,
    entityId: b._id,
  });
  const name = `AR — ${b.guestName} (booking ${b._id})`;

  const acc = await Account.create({
    code,
    name,
    type: 'ASSET',
    subType: 'CURRENT_ASSET',
    normalBalance: 'DEBIT',
    isActive: true,
    parentCode: PARENT_AR_CODE,
    accountKind: 'guest_receivable',
    internalBooking: b._id,
    createdBy: userId || undefined,
  });

  b.receivableAccountId = acc._id;
  await b.save();
  return acc;
}

/**
 * @param {{ skipSave?: boolean }} [options] — set skipSave true when caller will persist the booking doc.
 */
async function deactivateForGuestBooking(gb, options = {}) {
  const id = gb.receivableAccountId;
  if (!id) return;
  await Account.findByIdAndUpdate(id, { isActive: false });
  gb.receivableAccountId = undefined;
  if (!options.skipSave) await gb.save();
}

async function deactivateForInternalBooking(b, options = {}) {
  const id = b.receivableAccountId;
  if (!id) return;
  await Account.findByIdAndUpdate(id, { isActive: false });
  b.receivableAccountId = undefined;
  if (!options.skipSave) await b.save();
}

module.exports = {
  ensureForGuestBooking,
  ensureForInternalBooking,
  deactivateForGuestBooking,
  deactivateForInternalBooking,
  PARENT_AR_CODE,
};
