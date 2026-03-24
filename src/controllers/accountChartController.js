const Account = require('../models/Account');
const accountCodeService = require('../services/accountCodeService');
const { asyncHandler } = require('../utils/helpers');
const logAudit = require('../utils/audit');

/**
 * GET /api/accounting/accounts/next-code?strategy=suffix|numeric_sequence&prefix=1010&entityId=
 * Returns a suggested code (does not create a row).
 */
const getNextAccountCode = asyncHandler(async (req, res) => {
  const strategy = (req.query.strategy || 'suffix').trim();
  const prefix = req.query.prefix != null ? String(req.query.prefix).trim() : '1010';
  const entityId = req.query.entityId;

  try {
    const code = await accountCodeService.peekSuggestedCode({
      strategy,
      prefix,
      entityId: entityId != null && String(entityId).trim() ? entityId : undefined,
    });
    res.json({ success: true, data: { code, strategy, prefix, entityId: entityId || null } });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message || 'Invalid code request' });
  }
});

/**
 * POST /api/accounting/accounts
 * Body: { name, type, subType, normalBalance, code? , autoCode?: { strategy, prefix?, entityId? }, ... }
 */
const createAccount = asyncHandler(async (req, res) => {
  const {
    code: codeFromBody,
    autoCode,
    name,
    type,
    subType,
    normalBalance,
    parentCode,
    accountKind,
    isActive,
  } = req.body;

  if (!name || !type || !subType || !normalBalance) {
    return res.status(400).json({
      success: false,
      message: 'name, type, subType, and normalBalance are required',
    });
  }

  let code = codeFromBody != null ? String(codeFromBody).trim() : '';
  if (!code && autoCode && typeof autoCode === 'object') {
    code = await accountCodeService.generateAccountCode({
      strategy: autoCode.strategy || 'suffix',
      prefix: autoCode.prefix,
      entityId: autoCode.entityId,
    });
  }

  if (!code) {
    return res.status(400).json({
      success: false,
      message: 'Provide code or autoCode to generate one',
    });
  }

  let doc;
  try {
    doc = await Account.create({
      code,
      name: String(name).trim(),
      type,
      subType,
      normalBalance,
      parentCode: parentCode != null ? String(parentCode).trim() : undefined,
      accountKind: accountKind || 'standard',
      isActive: isActive !== false,
      createdBy: req.user._id,
    });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ success: false, message: 'Account code already exists' });
    }
    throw err;
  }

  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'create',
    entity: 'Account',
    entityId: doc._id,
    after: doc.toObject(),
    req,
  });

  res.status(201).json({ success: true, data: doc });
});

const listAccounts = asyncHandler(async (req, res) => {
  const activeOnly = String(req.query.activeOnly || '').toLowerCase() === '1' ||
    String(req.query.activeOnly || '').toLowerCase() === 'true';
  const q = activeOnly ? { isActive: true } : {};
  const rows = await Account.find(q).sort({ code: 1 }).lean();
  res.json({ success: true, data: rows });
});

module.exports = {
  getNextAccountCode,
  createAccount,
  listAccounts,
};
