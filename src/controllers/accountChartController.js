const Account = require('../models/Account');
const accountCodeService = require('../services/accountCodeService');
const { asyncHandler } = require('../utils/helpers');
const logAudit = require('../utils/audit');

/**
 * Accepts canonical SUB_TYPES (e.g. FIXED_ASSET) or human labels ("Fixed Asset", "fixed-asset").
 * @param {string} raw
 * @returns {string|null}
 */
function normalizeSubTypeInput(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const trimmed = String(raw).trim();
  if (Account.SUB_TYPES.includes(trimmed)) return trimmed;
  const slug = trimmed
    .toUpperCase()
    .replace(/[\s-]+/g, '_')
    .replace(/_+/g, '_');
  if (Account.SUB_TYPES.includes(slug)) return slug;
  return null;
}

/** When subType / normalBalance are omitted on POST /accounts */
function inferSubTypeAndNormalBalance(type) {
  const t = String(type || '').trim().toUpperCase();
  if (t === 'ASSET') return { subType: 'CURRENT_ASSET', normalBalance: 'DEBIT' };
  if (t === 'LIABILITY') return { subType: 'CURRENT_LIABILITY', normalBalance: 'CREDIT' };
  if (t === 'EQUITY') return { subType: 'OTHER_EQUITY', normalBalance: 'CREDIT' };
  if (t === 'REVENUE') return { subType: 'OPERATING_REVENUE', normalBalance: 'CREDIT' };
  if (t === 'EXPENSE') return { subType: 'OPERATING_EXPENSE', normalBalance: 'DEBIT' };
  return null;
}

/**
 * UI often sends labels like "Fixed Asset"; the schema stores SUB_TYPES enum tokens (e.g. FIXED_ASSET).
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
function normalizeSubTypeInput(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const trimmed = String(raw).trim();
  if (Account.SUB_TYPES.includes(trimmed)) return trimmed;
  const slug = trimmed
    .toUpperCase()
    .replace(/[\s-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  if (Account.SUB_TYPES.includes(slug)) return slug;
  return trimmed;
}

/** Prefix for numeric_sequence when `autoCode: true` (avoids clashing with seeded 4-digit codes). */
function defaultNumericPrefixForType(typeNorm) {
  switch (String(typeNorm || '').toUpperCase()) {
    case 'ASSET':
      return '1090';
    case 'LIABILITY':
      return '2090';
    case 'EQUITY':
      return '3090';
    case 'REVENUE':
      return '4090';
    case 'EXPENSE':
      return '6090';
    default:
      return '6090';
  }
}

/**
 * @returns {null | { strategy: string, prefix?: string, entityId?: string }}
 */
function normalizeAutoCodeOption(autoCodeRaw, typeNorm) {
  if (
    autoCodeRaw === true ||
    autoCodeRaw === 'true' ||
    autoCodeRaw === 1 ||
    autoCodeRaw === '1'
  ) {
    return {
      strategy: 'numeric_sequence',
      prefix: defaultNumericPrefixForType(typeNorm),
    };
  }
  if (autoCodeRaw && typeof autoCodeRaw === 'object' && !Array.isArray(autoCodeRaw)) {
    const strategy = String(autoCodeRaw.strategy || 'numeric_sequence').trim();
    const prefixFromBody =
      autoCodeRaw.prefix != null && String(autoCodeRaw.prefix).trim() !== ''
        ? String(autoCodeRaw.prefix).trim()
        : undefined;
    return {
      strategy,
      prefix: prefixFromBody || defaultNumericPrefixForType(typeNorm),
      entityId: autoCodeRaw.entityId,
    };
  }
  return null;
}

/** Prefix for `autoCode: true` → numeric_sequence (e.g. 60901, 60902 under seeded chart). */
function defaultPrefixForAutoCode(typeNorm) {
  const t = String(typeNorm || '').toUpperCase();
  if (t === 'ASSET') return '1090';
  if (t === 'LIABILITY') return '2090';
  if (t === 'EQUITY') return '3090';
  if (t === 'REVENUE') return '4090';
  if (t === 'EXPENSE') return '6090';
  return '6090';
}

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
 * Body: { name, type, subType?, normalBalance?, code?, autoCode?: true | { strategy, prefix?, entityId? },
 *   openingBalance?, openingBalanceAsOf?, openingBalanceNote?, description?,
 *   parentCode?, accountKind?, isActive? }
 * Opening balances are on the account’s **normal** side (see Account schema).
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
    openingBalance,
    openingBalanceAsOf,
    openingBalanceNote,
    description,
  } = req.body;

  if (name == null || String(name).trim() === '' || type == null || String(type).trim() === '') {
    return res.status(400).json({
      success: false,
      message:
        'name and type are required; subType and normalBalance are optional (defaults are chosen from type)',
    });
  }

  const typeNorm = String(type).trim();
  if (!Account.ACCOUNT_TYPES.includes(typeNorm)) {
    return res.status(400).json({
      success: false,
      message: `type must be one of: ${Account.ACCOUNT_TYPES.join(', ')}`,
    });
  }

  const inferred = inferSubTypeAndNormalBalance(typeNorm);
  const subTypeRaw =
    subType != null && String(subType).trim() !== '' ? String(subType).trim() : inferred?.subType;
  const subTypeResolved = normalizeSubTypeInput(subTypeRaw);
  const normalBalanceResolved =
    normalBalance != null && String(normalBalance).trim() !== ''
      ? String(normalBalance).trim().toUpperCase()
      : inferred?.normalBalance;

  if (!subTypeResolved || !normalBalanceResolved) {
    return res.status(400).json({
      success: false,
      message: 'Provide subType and normalBalance explicitly when type cannot be defaulted',
    });
  }

  if (!Account.SUB_TYPES.includes(subTypeResolved)) {
    return res.status(400).json({
      success: false,
      message:
        'Invalid subType — use a SUB_TYPES token (e.g. FIXED_ASSET for fixed assets), or omit subType to use the default for your type. Human labels like "Fixed Asset" are accepted when they map to a known token.',
      allowedSubTypes: Account.SUB_TYPES,
      hint: typeNorm === 'ASSET' ? 'For barns/equipment use subType: "FIXED_ASSET" (or "Fixed Asset").' : undefined,
    });
  }
  if (!['DEBIT', 'CREDIT'].includes(normalBalanceResolved)) {
    return res.status(400).json({
      success: false,
      message: 'normalBalance must be DEBIT or CREDIT',
    });
  }

  let code = codeFromBody != null ? String(codeFromBody).trim() : '';
  const autoOpts = normalizeAutoCodeOption(autoCode, typeNorm);
  if (!code && autoOpts) {
    try {
      code = await accountCodeService.generateAccountCode(autoOpts);
    } catch (err) {
      return res.status(400).json({
        success: false,
        message: err.message || 'Could not generate account code',
      });
    }
  }

  if (!code) {
    return res.status(400).json({
      success: false,
      message:
        'Provide code, or set autoCode to true to auto-generate, or autoCode: { strategy, prefix?, entityId? }',
    });
  }

  let doc;
  try {
    doc = await Account.create({
      code,
      name: String(name).trim(),
      type: typeNorm,
      subType: subTypeResolved,
      normalBalance: normalBalanceResolved,
      parentCode: parentCode != null ? String(parentCode).trim() : undefined,
      accountKind: accountKind || 'standard',
      isActive: isActive !== false,
      openingBalance:
        openingBalance != null && openingBalance !== '' ? Number(openingBalance) : 0,
      openingBalanceAsOf: openingBalanceAsOf ? new Date(openingBalanceAsOf) : undefined,
      openingBalanceNote:
        openingBalanceNote != null ? String(openingBalanceNote).trim() : undefined,
      description: description != null ? String(description).trim() : undefined,
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

  const usedTypeDefaults =
    subType == null ||
    String(subType).trim() === '' ||
    normalBalance == null ||
    String(normalBalance).trim() === '';

  res.status(201).json({
    success: true,
    data: doc,
    ...(usedTypeDefaults
      ? {
          defaultsApplied: {
            subType: subTypeResolved,
            normalBalance: normalBalanceResolved,
            inferredFromType: typeNorm,
          },
        }
      : {}),
  });
});

const listAccounts = asyncHandler(async (req, res) => {
  const activeOnly = String(req.query.activeOnly || '').toLowerCase() === '1' ||
    String(req.query.activeOnly || '').toLowerCase() === 'true';
  const q = activeOnly ? { isActive: true } : {};
  const rows = await Account.find(q).sort({ code: 1 }).lean();
  res.json({ success: true, data: rows });
});

/**
 * PUT /api/accounting/accounts/:id
 * Partial update; use for opening balances after go-live.
 */
const updateAccount = asyncHandler(async (req, res) => {
  const doc = await Account.findById(req.params.id);
  if (!doc) return res.status(404).json({ success: false, message: 'Account not found' });
  const before = doc.toObject();
  const allowed = [
    'name',
    'description',
    'isActive',
    'parentCode',
    'openingBalance',
    'openingBalanceAsOf',
    'openingBalanceNote',
  ];
  for (const key of allowed) {
    if (req.body[key] === undefined) continue;
    if (key === 'openingBalance') {
      doc.openingBalance = req.body.openingBalance == null ? 0 : Number(req.body.openingBalance);
      continue;
    }
    if (key === 'openingBalanceAsOf') {
      doc.openingBalanceAsOf = req.body.openingBalanceAsOf
        ? new Date(req.body.openingBalanceAsOf)
        : undefined;
      continue;
    }
    if (key === 'name') doc.name = String(req.body.name).trim();
    else if (key === 'description') {
      doc.description =
        req.body.description != null ? String(req.body.description).trim() : undefined;
    } else if (key === 'isActive') doc.isActive = !!req.body.isActive;
    else if (key === 'parentCode') {
      doc.parentCode =
        req.body.parentCode != null ? String(req.body.parentCode).trim() : undefined;
    } else if (key === 'openingBalanceNote') {
      doc.openingBalanceNote =
        req.body.openingBalanceNote != null ? String(req.body.openingBalanceNote).trim() : '';
    }
  }
  await doc.save();
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'update',
    entity: 'Account',
    entityId: doc._id,
    before,
    after: doc.toObject(),
    req,
  });
  res.json({ success: true, data: doc });
});

module.exports = {
  getNextAccountCode,
  createAccount,
  updateAccount,
  listAccounts,
};
