const JournalEntry = require('../models/JournalEntry');
const Account = require('../models/Account');
const ledgerService = require('./ledgerService');
const { round2, percent } = require('../utils/math');

class IncomeStatementService {
  async generate(startDate, endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    const rows = await this._fetchPeriodBalances(start, end);
    const buckets = this._bucket(rows);

    const operatingRevenue = buckets.OPERATING_REVENUE || 0;
    const otherRevenue = buckets.OTHER_REVENUE || 0;
    const totalRevenue = round2(operatingRevenue + otherRevenue);

    const cogs = buckets.COGS || 0;
    const grossProfit = round2(totalRevenue - cogs);
    const grossMargin = percent(grossProfit, totalRevenue);

    const operatingExpense = buckets.OPERATING_EXPENSE || 0;
    const depreciation = buckets.DEPRECIATION || 0;
    const totalOpex = round2(operatingExpense + depreciation);

    const ebit = round2(grossProfit - totalOpex);
    const ebitMargin = percent(ebit, totalRevenue);

    const interestExpense = buckets.INTEREST_EXPENSE || 0;
    const netInterest = round2(interestExpense);
    const ebt = round2(ebit - netInterest);

    const taxExpense = buckets.TAX_EXPENSE || 0;
    const netIncome = round2(ebt - taxExpense);
    const netMargin = percent(netIncome, totalRevenue);

    return {
      period: { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) },
      revenue: {
        operatingRevenue: round2(operatingRevenue),
        otherRevenue: round2(otherRevenue),
        totalRevenue,
      },
      cogs: round2(cogs),
      grossProfit,
      grossMarginPct: grossMargin,
      operatingExpenses: {
        operatingExpense: round2(operatingExpense),
        depreciation: round2(depreciation),
        totalOpex,
      },
      ebit,
      ebitMarginPct: ebitMargin,
      interestExpense: round2(interestExpense),
      ebt,
      taxExpense: round2(taxExpense),
      netIncome,
      netMarginPct: netMargin,
      lineItems: rows,
    };
  }

  async getRetainedEarningsRollforward(startDate, endDate) {
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    const dayBefore = new Date(start);
    dayBefore.setDate(dayBefore.getDate() - 1);

    const { netIncome } = await this.generate(startDate, endDate);
    const currentDividend = await this._getPeriodDividends(startDate, endDate);

    const reAcc = await Account.findOne({ code: '3010' });
    let openingRE = 0;
    if (reAcc) {
      const bal = await ledgerService.getAccountBalance(reAcc._id, dayBefore);
      openingRE = bal ? bal.balance : 0;
    }

    const closingRE = round2(openingRE + netIncome - currentDividend);

    return {
      openingRetainedEarnings: round2(openingRE),
      netIncome,
      dividendsPaid: round2(currentDividend),
      closingRetainedEarnings: closingRE,
    };
  }

  async _getPeriodDividends(startDate, endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    const r = await JournalEntry.aggregate([
      { $match: { status: 'POSTED', entryDate: { $gte: start, $lte: end } } },
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
      { $match: { 'acc.subType': 'DIVIDENDS' } },
      {
        $group: {
          _id: null,
          dividends: { $sum: { $subtract: ['$lines.debit', '$lines.credit'] } },
        },
      },
    ]);
    return r[0] ? parseFloat(r[0].dividends) : 0;
  }

  async _fetchPeriodBalances(startDate, endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    const grouped = await JournalEntry.aggregate([
      { $match: { status: 'POSTED', entryDate: { $gte: start, $lte: end } } },
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
      { $match: { 'acc.type': { $in: ['REVENUE', 'EXPENSE'] } } },
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

    return grouped
      .map((r) => {
        const balance =
          r.normalBalance === 'DEBIT'
            ? r.totalDebits - r.totalCredits
            : r.totalCredits - r.totalDebits;
        return {
          code: r.code,
          name: r.name,
          type: r.type,
          subType: r.subType,
          normalBalance: r.normalBalance,
          totalDebits: round2(r.totalDebits),
          totalCredits: round2(r.totalCredits),
          balance: round2(balance),
        };
      })
      .filter((r) => Math.abs(r.totalDebits) + Math.abs(r.totalCredits) > 0);
  }

  _bucket(rows) {
    return rows.reduce((acc, row) => {
      acc[row.subType] = (acc[row.subType] || 0) + row.balance;
      return acc;
    }, {});
  }
}

module.exports = new IncomeStatementService();
