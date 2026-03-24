/**
 * Resolve reporting period from query: explicit dates, year=YYYY, or month=YYYY-MM
 * @param {Record<string, string | undefined>} query
 * @returns {{ startDate: string, endDate: string } | null}
 */
function resolvePeriodDates(query) {
  if (query.startDate && query.endDate) {
    return { startDate: query.startDate, endDate: query.endDate };
  }
  if (query.year) {
    const y = String(query.year).trim();
    return { startDate: `${y}-01-01`, endDate: `${y}-12-31` };
  }
  if (query.month) {
    const [y, m] = String(query.month).trim().split('-');
    if (y && m) {
      const last = new Date(parseInt(y, 10), parseInt(m, 10), 0).getDate();
      const mm = m.padStart(2, '0');
      return {
        startDate: `${y}-${mm}-01`,
        endDate: `${y}-${mm}-${String(last).padStart(2, '0')}`,
      };
    }
  }
  return null;
}

module.exports = { resolvePeriodDates };
