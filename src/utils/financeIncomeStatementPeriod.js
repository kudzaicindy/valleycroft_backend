/**
 * Accrual / stay-window amount attributed to [periodStart, periodEnd] for
 * transactions-basis income statement (must match getIncomeStatementFromTransactions).
 *
 * @param {Record<string, unknown>} tx Lean transaction with optional booking / guestBooking
 * @param {Date|string} periodStart Inclusive
 * @param {Date|string} periodEnd Inclusive
 * @returns {number}
 */
function amountRecognizedInIncomeStatementPeriod(tx, periodStart, periodEnd) {
  const start = periodStart instanceof Date ? periodStart : new Date(periodStart);
  const end = periodEnd instanceof Date ? periodEnd : new Date(periodEnd);

  const amount = Number(tx.amount || 0);
  if (!Number.isFinite(amount) || amount === 0) return 0;

  const category = String(tx.category || '').toLowerCase();
  const b = tx.booking || null;
  const g = tx.guestBooking || null;

  const txDate = tx.date ? new Date(tx.date) : null;
  const inRangeByTxDate =
    txDate &&
    !Number.isNaN(txDate.getTime()) &&
    txDate.getTime() >= start.getTime() &&
    txDate.getTime() <= end.getTime();

  if (category === 'event') {
    const eventDate = b?.eventDate ? new Date(b.eventDate) : null;
    if (eventDate && !Number.isNaN(eventDate.getTime())) {
      return eventDate >= start && eventDate <= end ? amount : 0;
    }
    return inRangeByTxDate ? amount : 0;
  }

  if (category === 'booking') {
    const checkIn = b?.checkIn || g?.checkIn;
    if (checkIn) {
      const asDayStartUtc = (d) => {
        const x = new Date(d);
        x.setUTCHours(0, 0, 0, 0);
        return x;
      };
      const ci = asDayStartUtc(checkIn);
      const ps = asDayStartUtc(start);
      const pe = asDayStartUtc(end);
      return ci >= ps && ci <= pe ? amount : 0;
    }
    const effectiveDate =
      txDate && !Number.isNaN(txDate.getTime()) ? txDate : new Date(0);
    return effectiveDate >= start && effectiveDate <= end ? amount : 0;
  }

  return inRangeByTxDate ? amount : 0;
}

/**
 * Whether an income row should appear in a P&amp;L-aligned transaction list for the period.
 * Booking/event use stay/event window; other income uses transaction date.
 *
 * @param {Record<string, unknown>} tx
 * @param {Date} periodStart
 * @param {Date} periodEnd
 */
function incomeTxMatchesIncomeStatementPeriod(tx, periodStart, periodEnd) {
  const cat = String(tx.category || '').toLowerCase();
  if (cat === 'booking_payment' || cat === 'owner_investment' || cat === 'capital_injection') {
    return false;
  }
  if (cat === 'booking' || cat === 'event') {
    return amountRecognizedInIncomeStatementPeriod(tx, periodStart, periodEnd) > 0;
  }
  const txDate = tx.date ? new Date(tx.date) : null;
  if (!txDate || Number.isNaN(txDate.getTime())) return false;
  return txDate >= periodStart && txDate <= periodEnd;
}

module.exports = {
  amountRecognizedInIncomeStatementPeriod,
  incomeTxMatchesIncomeStatementPeriod,
};
