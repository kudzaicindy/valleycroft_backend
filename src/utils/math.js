const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const percent = (value, base) => (base !== 0 && base != null ? round2((value / base) * 100) : 0);

module.exports = { round2, percent };
