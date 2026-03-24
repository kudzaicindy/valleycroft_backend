const { round2 } = require('../utils/math');
const incomeStatementService = require('./incomeStatementService');
const JournalEntry = require('../models/JournalEntry');

class BalanceSheetService {
  async generate(asOfDate, periodStartDate = null) {
    const asAt = new Date(asOfDate);
    asAt.setHours(23, 59, 59, 999);

    const rows = await this._fetchBalances(asAt);
    const bySubType = this._groupBySubType(rows);

    const cash =
      (bySubType.CURRENT_ASSET || [])
        .filter((r) => ['1001', '1002'].includes(r.code))
        .reduce((s, r) => s + r.balance, 0) || 0;
    const accountsRec = bySubType.CURRENT_ASSET?.find((r) => r.code === '1010')?.balance || 0;
    const inventory = bySubType.CURRENT_ASSET?.find((r) => r.code === '1020')?.balance || 0;
    const prepaid = bySubType.CURRENT_ASSET?.find((r) => r.code === '1030')?.balance || 0;
    const otherCurrentAss =
      (bySubType.CURRENT_ASSET || [])
        .filter((r) => !['1001', '1002', '1010', '1020', '1030'].includes(r.code))
        .reduce((s, r) => s + r.balance, 0) || 0;

    const totalCurrentAssets = round2(cash + accountsRec + inventory + prepaid + otherCurrentAss);

    const grossPPE = (bySubType.FIXED_ASSET || []).reduce((s, r) => s + r.balance, 0) || 0;
    const accumDeprec = (bySubType.ACCUMULATED_DEPRECIATION || []).reduce((s, r) => s + r.balance, 0) || 0;
    const netPPE = round2(grossPPE - accumDeprec);
    const intangibles = (bySubType.INTANGIBLE_ASSET || []).reduce((s, r) => s + r.balance, 0) || 0;
    const longTermInv = (bySubType.LONG_TERM_INVESTMENT || []).reduce((s, r) => s + r.balance, 0) || 0;

    const totalNonCurrentAssets = round2(netPPE + intangibles + longTermInv);
    const totalAssets = round2(totalCurrentAssets + totalNonCurrentAssets);

    const accountsPay = bySubType.CURRENT_LIABILITY?.find((r) => r.code === '2001')?.balance || 0;
    const accruedExp = bySubType.CURRENT_LIABILITY?.find((r) => r.code === '2010')?.balance || 0;
    const shortTermLoan = bySubType.CURRENT_LIABILITY?.find((r) => r.code === '2020')?.balance || 0;
    const deferredRev = bySubType.CURRENT_LIABILITY?.find((r) => r.code === '2030')?.balance || 0;
    const otherCurrentLia =
      (bySubType.CURRENT_LIABILITY || [])
        .filter((r) => !['2001', '2010', '2020', '2030'].includes(r.code))
        .reduce((s, r) => s + r.balance, 0) || 0;

    const totalCurrentLiabilities = round2(
      accountsPay + accruedExp + shortTermLoan + deferredRev + otherCurrentLia
    );

    const longTermDebt = bySubType.LONG_TERM_LIABILITY?.find((r) => r.code === '2100')?.balance || 0;
    const deferredTax = bySubType.LONG_TERM_LIABILITY?.find((r) => r.code === '2110')?.balance || 0;
    const totalNonCurrentLiabilities = round2(longTermDebt + deferredTax);
    const totalLiabilities = round2(totalCurrentLiabilities + totalNonCurrentLiabilities);

    const shareCapital = (bySubType.SHARE_CAPITAL || []).reduce((s, r) => s + r.balance, 0) || 0;

    if (periodStartDate) {
      const re = await incomeStatementService.getRetainedEarningsRollforward(periodStartDate, asOfDate);
      const retainedEarnings = re.closingRetainedEarnings;
      const totalEquity = round2(shareCapital + retainedEarnings);
      const totalLiabAndEquity = round2(totalLiabilities + totalEquity);

      return this._buildResponse({
        asOfDate: asAt.toISOString().slice(0, 10),
        periodStartDate,
        currentAssets: {
          cash,
          accountsRec,
          inventory,
          prepaid,
          otherCurrentAss,
          total: totalCurrentAssets,
        },
        nonCurrentAssets: {
          grossPPE,
          accumDeprec,
          netPPE,
          intangibles,
          longTermInv,
          total: totalNonCurrentAssets,
        },
        totalAssets,
        currentLiabilities: {
          accountsPay,
          accruedExp,
          shortTermLoan,
          deferredRev,
          otherCurrentLia,
          total: totalCurrentLiabilities,
        },
        nonCurrentLiabilities: { longTermDebt, deferredTax, total: totalNonCurrentLiabilities },
        totalLiabilities,
        equity: {
          shareCapital: round2(shareCapital),
          openingRE: re.openingRetainedEarnings,
          netIncome: re.netIncome,
          dividendsPaid: re.dividendsPaid,
          retainedEarnings,
          totalEquity,
        },
        totalLiabAndEquity,
        rows,
      });
    }

    const explicitRE = (bySubType.RETAINED_EARNINGS || []).reduce((s, r) => s + r.balance, 0) || 0;
    const retainedEarnings = round2(explicitRE);
    const totalEquity = round2(shareCapital + retainedEarnings);
    const totalLiabAndEquity = round2(totalLiabilities + totalEquity);

    return this._buildResponse({
      asOfDate: asAt.toISOString().slice(0, 10),
      currentAssets: {
        cash,
        accountsRec,
        inventory,
        prepaid,
        otherCurrentAss,
        total: totalCurrentAssets,
      },
      nonCurrentAssets: {
        grossPPE,
        accumDeprec,
        netPPE,
        intangibles,
        longTermInv,
        total: totalNonCurrentAssets,
      },
      totalAssets,
      currentLiabilities: {
        accountsPay,
        accruedExp,
        shortTermLoan,
        deferredRev,
        otherCurrentLia,
        total: totalCurrentLiabilities,
      },
      nonCurrentLiabilities: { longTermDebt, deferredTax, total: totalNonCurrentLiabilities },
      totalLiabilities,
      equity: { shareCapital: round2(shareCapital), retainedEarnings, totalEquity },
      totalLiabAndEquity,
      rows,
    });
  }

  _buildResponse(data) {
    const { totalAssets, totalLiabAndEquity } = data;
    const isBalanced = Math.abs(totalAssets - totalLiabAndEquity) < 0.01;
    return {
      ...data,
      isBalanced,
      variance: round2(totalAssets - totalLiabAndEquity),
    };
  }

  async _fetchBalances(asOfDate) {
    const asAt = new Date(asOfDate);
    asAt.setHours(23, 59, 59, 999);

    const grouped = await JournalEntry.aggregate([
      { $match: { status: 'POSTED', entryDate: { $lte: asAt } } },
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
        $match: {
          'acc.type': { $in: ['ASSET', 'LIABILITY', 'EQUITY'] },
          $or: [{ 'acc.isActive': true }, { 'acc.isActive': { $exists: false } }],
        },
      },
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

    return grouped.map((r) => {
      const balance =
        r.normalBalance === 'DEBIT'
          ? r.totalDebits - r.totalCredits
          : r.totalCredits - r.totalDebits;
      return { ...r, balance: round2(balance) };
    });
  }

  _groupBySubType(rows) {
    return rows.reduce((acc, row) => {
      if (!acc[row.subType]) acc[row.subType] = [];
      acc[row.subType].push(row);
      return acc;
    }, {});
  }
}

module.exports = new BalanceSheetService();
