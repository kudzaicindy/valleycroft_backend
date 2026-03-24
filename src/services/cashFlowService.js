const { round2 } = require('../utils/math');
const incomeStatementService = require('./incomeStatementService');
const JournalEntry = require('../models/JournalEntry');

class CashFlowService {
  async generate(startDate, endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    const pl = await incomeStatementService.generate(startDate, endDate);
    const netIncome = pl.netIncome;
    const deprecAndAmort = pl.operatingExpenses.depreciation;

    const wc = await this._getWorkingCapitalChanges(start, end);

    const changeInAR = wc.accountsReceivable;
    const changeInInventory = wc.inventory;
    const changeInPrepaid = wc.prepaid;
    const changeInAP = wc.accountsPayable;
    const changeInAccruals = wc.accruedExpenses;
    const changeInDeferredRev = wc.deferredRevenue;

    const operatingCashFlow = round2(
      netIncome +
        deprecAndAmort -
        changeInAR -
        changeInInventory -
        changeInPrepaid +
        changeInAP +
        changeInAccruals +
        changeInDeferredRev
    );

    const investing = await this._getInvestingFlows(start, end);
    const financing = await this._getFinancingFlows(start, end);

    const netChangeInCash = round2(operatingCashFlow + investing.netInvesting + financing.netFinancing);
    const openingCash = await this._getCashBalance(start, true);
    const closingCash = round2(openingCash + netChangeInCash);
    const bsCash = await this._getCashBalance(end, false);
    const isReconciled = Math.abs(closingCash - bsCash) < 0.01;

    return {
      period: { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) },
      operatingActivities: {
        netIncome,
        addBacks: { depreciation: round2(deprecAndAmort) },
        workingCapitalChanges: {
          changeInAccountsReceivable: round2(-changeInAR),
          changeInInventory: round2(-changeInInventory),
          changeInPrepaid: round2(-changeInPrepaid),
          changeInAccountsPayable: round2(changeInAP),
          changeInAccruedExpenses: round2(changeInAccruals),
          changeInDeferredRevenue: round2(changeInDeferredRev),
        },
        netOperatingCashFlow: operatingCashFlow,
      },
      investingActivities: {
        ...investing,
        netInvestingCashFlow: investing.netInvesting,
      },
      financingActivities: {
        ...financing,
        netFinancingCashFlow: financing.netFinancing,
      },
      summary: {
        netOperatingCashFlow: operatingCashFlow,
        netInvestingCashFlow: investing.netInvesting,
        netFinancingCashFlow: financing.netFinancing,
        netChangeInCash,
        openingCash: round2(openingCash),
        closingCash,
        balanceSheetCash: round2(bsCash),
        isReconciled,
      },
    };
  }

  async _balanceAsOf(date, before) {
    const d = new Date(date);
    if (!before) d.setHours(23, 59, 59, 999);
    const match = { status: 'POSTED' };
    match.entryDate = before ? { $lt: d } : { $lte: d };

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
        $match: {
          'acc.subType': { $in: ['CURRENT_ASSET', 'CURRENT_LIABILITY'] },
        },
      },
      {
        $group: {
          _id: '$acc.code',
          subType: { $first: '$acc.subType' },
          normalBalance: { $first: '$acc.normalBalance' },
          debits: { $sum: '$lines.debit' },
          credits: { $sum: '$lines.credit' },
        },
      },
    ]);

    const balances = {};
    for (const r of rows) {
      const bal =
        r.normalBalance === 'DEBIT' ? r.debits - r.credits : r.credits - r.debits;
      balances[r._id] = bal;
    }
    return balances;
  }

  async _getWorkingCapitalChanges(start, end) {
    const opening = await this._balanceAsOf(start, true);
    const closing = await this._balanceAsOf(end, false);
    const codes = ['1010', '1020', '1030', '2001', '2010', '2030'];
    const change = (code) => (closing[code] || 0) - (opening[code] || 0);
    return {
      accountsReceivable: change('1010'),
      inventory: change('1020'),
      prepaid: change('1030'),
      accountsPayable: change('2001'),
      accruedExpenses: change('2010'),
      deferredRevenue: change('2030'),
    };
  }

  async _getInvestingFlows(start, end) {
    const r = await JournalEntry.aggregate([
      {
        $match: {
          status: 'POSTED',
          entryDate: { $gte: start, $lte: end },
        },
      },
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
          'acc.subType': { $in: ['FIXED_ASSET', 'INTANGIBLE_ASSET', 'LONG_TERM_INVESTMENT'] },
        },
      },
      {
        $group: {
          _id: null,
          assetPurchases: {
            $sum: {
              $cond: [
                { $in: ['$acc.subType', ['FIXED_ASSET', 'INTANGIBLE_ASSET', 'LONG_TERM_INVESTMENT']] },
                '$lines.debit',
                0,
              ],
            },
          },
          assetSales: {
            $sum: {
              $cond: [
                { $in: ['$acc.subType', ['FIXED_ASSET', 'INTANGIBLE_ASSET', 'LONG_TERM_INVESTMENT']] },
                '$lines.credit',
                0,
              ],
            },
          },
        },
      },
    ]);

    const row = r[0] || { assetPurchases: 0, assetSales: 0 };
    const capex = parseFloat(row.assetPurchases) || 0;
    const proceeds = parseFloat(row.assetSales) || 0;
    return {
      capitalExpenditures: round2(-capex),
      proceedsFromDisposal: round2(proceeds),
      netInvesting: round2(proceeds - capex),
    };
  }

  async _getFinancingFlows(start, end) {
    const lines = await JournalEntry.aggregate([
      {
        $match: {
          status: 'POSTED',
          entryDate: { $gte: start, $lte: end },
        },
      },
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
    ]);

    let loanProceeds = 0;
    let loanRepay = 0;
    let equityIssued = 0;
    let dividends = 0;
    const excludeLoanCodes = ['2001', '2010', '2030'];

    for (const row of lines) {
      const acc = row.acc;
      const d = row.lines.debit || 0;
      const c = row.lines.credit || 0;
      if (acc.subType === 'SHARE_CAPITAL') {
        equityIssued += c;
      } else if (acc.subType === 'DIVIDENDS') {
        dividends += d;
      } else if (
        ['CURRENT_LIABILITY', 'LONG_TERM_LIABILITY'].includes(acc.subType) &&
        !excludeLoanCodes.includes(acc.code)
      ) {
        loanProceeds += c;
        loanRepay += d;
      }
    }

    const netFinancing = round2(loanProceeds - loanRepay + equityIssued - dividends);

    return {
      loanProceeds: round2(loanProceeds),
      loanRepayments: round2(-loanRepay),
      equityIssued: round2(equityIssued),
      dividendsPaid: round2(-dividends),
      netFinancing,
    };
  }

  async _getCashBalance(date, opening) {
    const d = new Date(date);
    if (!opening) d.setHours(23, 59, 59, 999);
    const match = { status: 'POSTED' };
    match.entryDate = opening ? { $lt: d } : { $lte: d };

    const r = await JournalEntry.aggregate([
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
      { $match: { 'acc.code': { $in: ['1001', '1002'] } } },
      {
        $group: {
          _id: null,
          debits: { $sum: '$lines.debit' },
          credits: { $sum: '$lines.credit' },
        },
      },
    ]);

    if (!r.length) return 0;
    return round2((r[0].debits || 0) - (r[0].credits || 0));
  }
}

module.exports = new CashFlowService();
