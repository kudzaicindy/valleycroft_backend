const mongoose = require('mongoose');
const Account = require('../models/Account');
const FiscalPeriod = require('../models/FiscalPeriod');
const JournalEntry = require('../models/JournalEntry');
const { round2 } = require('../utils/math');

function assertBalanced(lines) {
  if (!lines || lines.length < 2) throw new Error('A journal entry requires at least 2 lines');
  const totalDebit = lines.reduce((s, l) => s + (parseFloat(l.debit) || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0);
  if (Math.abs(totalDebit - totalCredit) > 0.01) {
    throw new Error(`Unbalanced journal entry — debits: ${totalDebit.toFixed(2)}, credits: ${totalCredit.toFixed(2)}`);
  }
}

async function resolveLineAccounts(lines) {
  const resolved = [];
  for (const line of lines) {
    let accountId = line.accountId;
    if (!accountId && line.accountCode) {
      const acc = await Account.findOne({ code: String(line.accountCode).trim() });
      if (!acc) throw new Error(`Unknown account code: ${line.accountCode}`);
      accountId = acc._id;
    }
    if (!accountId) throw new Error('Each line needs accountId or accountCode');
    resolved.push({
      accountId,
      debit: parseFloat(line.debit) || 0,
      credit: parseFloat(line.credit) || 0,
      description: line.description,
    });
  }
  return resolved;
}

class LedgerService {
  async postEntry({ entryDate, periodId, reference, description, entryType = 'MANUAL', lines, createdBy, status = 'POSTED' }) {
    assertBalanced(lines);
    const resolvedLines = await resolveLineAccounts(lines);

    if (periodId) {
      const period = await FiscalPeriod.findById(periodId);
      if (!period) throw new Error('Fiscal period not found');
      if (period.isClosed) throw new Error(`Period ${periodId} is closed — cannot post entries`);
    }

    const entry = await JournalEntry.create({
      entryDate: new Date(entryDate),
      periodId: periodId || undefined,
      reference,
      description,
      entryType,
      status,
      lines: resolvedLines,
      createdBy,
    });
    return { entryId: entry._id, lines: entry.lines.length };
  }

  async voidEntry(entryId, reason, voidedBy) {
    const original = await JournalEntry.findById(entryId);
    if (!original || original.status !== 'POSTED') {
      throw new Error('Entry not found or already voided');
    }

    original.status = 'VOIDED';
    original.voidedAt = new Date();
    original.voidedReason = reason;
    await original.save();

    const reversingLines = original.lines.map((row) => ({
      accountId: row.accountId,
      debit: row.credit,
      credit: row.debit,
      description: `REVERSAL: ${row.description || ''}`,
    }));

    const rev = await JournalEntry.create({
      entryDate: new Date(),
      description: `VOID of entry #${entryId}: ${reason}`,
      entryType: 'ADJUSTMENT',
      status: 'POSTED',
      lines: reversingLines,
      createdBy: voidedBy,
    });

    return { voidedEntryId: entryId, reversingEntryId: rev._id };
  }

  async getAccountBalance(accountId, asOfDate = null) {
    const match = { status: 'POSTED' };
    if (asOfDate) match.entryDate = { $lte: new Date(asOfDate) };

    const rows = await JournalEntry.aggregate([
      { $match: match },
      { $unwind: '$lines' },
      { $match: { 'lines.accountId': new mongoose.Types.ObjectId(accountId) } },
      {
        $lookup: {
          from: 'accounts',
          localField: 'lines.accountId',
          foreignField: '_id',
          as: 'acc',
        },
      },
      { $unwind: '$acc' },
      {
        $group: {
          _id: null,
          totalDebits: { $sum: '$lines.debit' },
          totalCredits: { $sum: '$lines.credit' },
          normalBalance: { $first: '$acc.normalBalance' },
        },
      },
    ]);

    const acc = await Account.findById(accountId).lean();
    if (!acc) return null;
    const opening = Number(acc.openingBalance) || 0;

    if (!rows.length) {
      return {
        code: acc.code,
        name: acc.name,
        type: acc.type,
        subType: acc.subType,
        normalBalance: acc.normalBalance,
        totalDebits: 0,
        totalCredits: 0,
        openingBalance: round2(opening),
        balance: round2(opening),
      };
    }

    const r = rows[0];
    const journalBalance =
      r.normalBalance === 'DEBIT'
        ? r.totalDebits - r.totalCredits
        : r.totalCredits - r.totalDebits;

    return {
      code: acc.code,
      name: acc.name,
      type: acc.type,
      subType: acc.subType,
      normalBalance: acc.normalBalance,
      totalDebits: round2(r.totalDebits),
      totalCredits: round2(r.totalCredits),
      openingBalance: round2(opening),
      balance: round2(journalBalance + opening),
    };
  }

  async getTrialBalance(asOfDate = null) {
    const match = { status: 'POSTED' };
    if (asOfDate) match.entryDate = { $lte: new Date(asOfDate) };

    const rows = await JournalEntry.aggregate([
      { $match: match },
      { $unwind: '$lines' },
      {
        $lookup: {
          from: 'accounts',
          localField: 'lines.accountId',
          foreignField: '_id',
          as: 'acc',
        },
      },
      { $unwind: '$acc' },
      {
        $group: {
          _id: '$lines.accountId',
          code: { $first: '$acc.code' },
          name: { $first: '$acc.name' },
          type: { $first: '$acc.type' },
          subType: { $first: '$acc.subType' },
          normalBalance: { $first: '$acc.normalBalance' },
          totalDebits: { $sum: '$lines.debit' },
          totalCredits: { $sum: '$lines.credit' },
        },
      },
    ]);

    const journalById = Object.fromEntries(
      rows.map((r) => [
        String(r._id),
        {
          totalDebits: r.totalDebits,
          totalCredits: r.totalCredits,
          code: r.code,
          name: r.name,
          type: r.type,
          subType: r.subType,
          normalBalance: r.normalBalance,
        },
      ])
    );

    const allAccounts = await Account.find({ isActive: true }).sort({ code: 1 }).lean();
    const accounts = [];

    for (const acc of allAccounts) {
      const jr = journalById[String(acc._id)];
      const totalDebits = jr ? jr.totalDebits : 0;
      const totalCredits = jr ? jr.totalCredits : 0;
      const journalBalance =
        acc.normalBalance === 'DEBIT'
          ? totalDebits - totalCredits
          : totalCredits - totalDebits;
      const opening = Number(acc.openingBalance) || 0;
      const balance = round2(journalBalance + opening);
      const hasMovement =
        Math.abs(totalDebits) > 0.005 || Math.abs(totalCredits) > 0.005;
      if (!hasMovement && Math.abs(opening) < 0.005) continue;

      accounts.push({
        accountId: acc._id,
        code: acc.code,
        name: acc.name,
        type: acc.type,
        subType: acc.subType,
        normalBalance: acc.normalBalance,
        totalDebits: round2(totalDebits),
        totalCredits: round2(totalCredits),
        openingBalance: round2(opening),
        balance,
      });
    }

    const journalDebits = accounts.reduce((s, r) => s + r.totalDebits, 0);
    const journalCredits = accounts.reduce((s, r) => s + r.totalCredits, 0);

    let trialDebitColumn = 0;
    let trialCreditColumn = 0;
    for (const a of accounts) {
      const b = a.balance;
      if (a.normalBalance === 'DEBIT') {
        if (b >= 0) trialDebitColumn += b;
        else trialCreditColumn += -b;
      } else if (b >= 0) trialCreditColumn += b;
      else trialDebitColumn += -b;
    }
    trialDebitColumn = round2(trialDebitColumn);
    trialCreditColumn = round2(trialCreditColumn);

    return {
      accounts,
      totals: {
        journalMovementDebits: round2(journalDebits),
        journalMovementCredits: round2(journalCredits),
        journalMovementsMatch: Math.abs(journalDebits - journalCredits) < 0.01,
        trialDebitColumn: trialDebitColumn,
        trialCreditColumn,
        trialBalanced: Math.abs(trialDebitColumn - trialCreditColumn) < 0.01,
      },
      totalDebits: round2(journalDebits),
      totalCredits: round2(journalCredits),
      isBalanced: Math.abs(trialDebitColumn - trialCreditColumn) < 0.01,
    };
  }

  /**
   * General ledger: journal entries with line-level account codes (posted by default).
   */
  async listJournalEntries({
    startDate,
    endDate,
    status = 'POSTED',
    entryType,
    page = 1,
    limit = 50,
  } = {}) {
    const q = {};
    if (status && String(status).toLowerCase() !== 'all') {
      const s = String(status).trim();
      if (s.includes(',')) {
        q.status = { $in: s.split(',').map((x) => x.trim()) };
      } else {
        q.status = s;
      }
    }
    if (entryType) q.entryType = entryType;
    if (startDate || endDate) {
      q.entryDate = {};
      if (startDate) q.entryDate.$gte = new Date(startDate);
      if (endDate) {
        const e = new Date(endDate);
        e.setUTCHours(23, 59, 59, 999);
        q.entryDate.$lte = e;
      }
    }

    const p = Math.max(1, parseInt(page, 10) || 1);
    const lim = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const skip = (p - 1) * lim;

    const [entries, total] = await Promise.all([
      JournalEntry.find(q).sort({ entryDate: -1, createdAt: -1 }).skip(skip).limit(lim).lean(),
      JournalEntry.countDocuments(q),
    ]);

    const accountIds = [
      ...new Set(entries.flatMap((e) => (e.lines || []).map((l) => String(l.accountId)))),
    ];
    const oidList = accountIds.filter((id) => mongoose.isValidObjectId(id)).map((id) => new mongoose.Types.ObjectId(id));
    const accounts = oidList.length ? await Account.find({ _id: { $in: oidList } }).lean() : [];
    const map = Object.fromEntries(accounts.map((a) => [String(a._id), a]));

    const data = entries.map((e) => ({
      _id: e._id,
      entryDate: e.entryDate,
      reference: e.reference,
      description: e.description,
      entryType: e.entryType,
      status: e.status,
      voidedAt: e.voidedAt,
      voidedReason: e.voidedReason,
      createdAt: e.createdAt,
      lines: (e.lines || []).map((l) => {
        const acc = map[String(l.accountId)];
        return {
          _id: l._id,
          accountId: l.accountId,
          debit: l.debit,
          credit: l.credit,
          description: l.description,
          account: acc
            ? { code: acc.code, name: acc.name, type: acc.type, subType: acc.subType }
            : null,
        };
      }),
    }));

    return {
      data,
      meta: { page: p, limit: lim, total },
    };
  }
}

module.exports = new LedgerService();
