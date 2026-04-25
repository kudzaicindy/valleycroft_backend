const Transaction = require('../models/Transaction');
const PDFDocument = require('pdfkit');
const { asyncHandler } = require('../utils/helpers');
const logAudit = require('../utils/audit');

const runAggregation = async (start, end) => {
  const match = { date: { $gte: new Date(start), $lte: new Date(end) } };
  const income = await Transaction.aggregate([
    { $match: { ...match, type: 'income' } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  const expense = await Transaction.aggregate([
    { $match: { ...match, type: 'expense' } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  return {
    income: income[0]?.total ?? 0,
    expense: expense[0]?.total ?? 0,
    profit: (income[0]?.total ?? 0) - (expense[0]?.total ?? 0),
  };
};

const runDetailedAggregation = async (start, end) => {
  const match = { date: { $gte: new Date(start), $lte: new Date(end) } };
  const grouped = await Transaction.aggregate([
    { $match: match },
    {
      $group: {
        _id: { type: '$type', category: { $ifNull: ['$category', 'uncategorized'] } },
        total: { $sum: '$amount' },
        count: { $sum: 1 },
      },
    },
    { $sort: { total: -1 } },
  ]);

  const incomeByCategory = [];
  const expenseByCategory = [];
  for (const row of grouped) {
    const entry = {
      category: row._id?.category || 'uncategorized',
      total: Number(row.total || 0),
      count: Number(row.count || 0),
    };
    if (row._id?.type === 'income') incomeByCategory.push(entry);
    if (row._id?.type === 'expense') expenseByCategory.push(entry);
  }

  const totals = {
    income: incomeByCategory.reduce((s, r) => s + r.total, 0),
    expense: expenseByCategory.reduce((s, r) => s + r.total, 0),
  };
  totals.profit = totals.income - totals.expense;

  return {
    totals,
    incomeByCategory,
    expenseByCategory,
    topIncomeCategory: incomeByCategory[0] || null,
    topExpenseCategory: expenseByCategory[0] || null,
  };
};

function periodRange(period = 'monthly') {
  const end = new Date();
  let start;
  if (period === 'weekly') {
    start = new Date(end);
    start.setDate(start.getDate() - 7);
  } else if (period === 'quarterly') {
    const q = Math.floor(end.getMonth() / 3) + 1;
    start = new Date(end.getFullYear(), (q - 1) * 3, 1);
  } else if (period === 'annual') {
    start = new Date(end.getFullYear(), 0, 1);
  } else {
    start = new Date(end.getFullYear(), end.getMonth(), 1);
  }
  return { start, end };
}

function priorRange(start, end) {
  const spanMs = Math.max(1, end.getTime() - start.getTime());
  const priorEnd = new Date(start.getTime() - 1);
  const priorStart = new Date(priorEnd.getTime() - spanMs);
  return { start: priorStart, end: priorEnd };
}

function pctChange(current, prior) {
  if (!prior) return current > 0 ? 100 : 0;
  return Number((((current - prior) / Math.abs(prior)) * 100).toFixed(2));
}

function clampPct(v, min = -100, max = 200) {
  return Math.min(max, Math.max(min, Number(v) || 0));
}

function buildForecast(payload) {
  const { period, current, prior, dateRange } = payload;
  const curRev = Number(current.totals.income || 0);
  const curExp = Number(current.totals.expense || 0);
  const priorRev = Number(prior.totals.income || 0);
  const priorExp = Number(prior.totals.expense || 0);
  const revGrowthPctRaw = pctChange(curRev, priorRev);
  const expGrowthPctRaw = pctChange(curExp, priorExp);
  const revGrowthPct = clampPct(revGrowthPctRaw);
  const expGrowthPct = clampPct(expGrowthPctRaw);

  const projectedRevenueNext = Number((curRev * (1 + revGrowthPct / 100)).toFixed(2));
  const projectedExpenseNext = Number((curExp * (1 + expGrowthPct / 100)).toFixed(2));
  const projectedProfitNext = Number((projectedRevenueNext - projectedExpenseNext).toFixed(2));
  const projectedMarginPct = projectedRevenueNext
    ? Number(((projectedProfitNext / projectedRevenueNext) * 100).toFixed(2))
    : 0;

  const start = new Date(dateRange.start);
  const end = new Date(dateRange.end);
  const elapsedDays = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 86400000));
  const dailyRevenueRunRate = Number((curRev / elapsedDays).toFixed(2));
  const dailyExpenseRunRate = Number((curExp / elapsedDays).toFixed(2));

  return {
    periodType: period,
    assumptions: [
      'Baseline uses current-period actuals versus prior comparable period.',
      'Growth rates are capped to reduce extreme outlier effects.',
      'No major pricing, capacity, or one-off shock changes assumed.',
    ],
    drivers: {
      revenueGrowthPct: revGrowthPct,
      expenseGrowthPct: expGrowthPct,
      dailyRevenueRunRate,
      dailyExpenseRunRate,
    },
    projection: {
      nextPeriodRevenue: projectedRevenueNext,
      nextPeriodExpense: projectedExpenseNext,
      nextPeriodProfit: projectedProfitNext,
      nextPeriodProfitMarginPct: projectedMarginPct,
    },
  };
}

function buildDetailedNarrative(payload, insight, forecast) {
  const period = payload.period;
  const cur = payload.current.totals;
  const prior = payload.prior.totals;
  const incDelta = pctChange(cur.income, prior.income);
  const expDelta = pctChange(cur.expense, prior.expense);
  const profDelta = pctChange(cur.profit, prior.profit);
  const topInc = payload.currentDetails.topIncomeCategory;
  const topExp = payload.currentDetails.topExpenseCategory;
  const tone = cur.profit >= 0 ? 'positive' : 'under pressure';

  const sections = {
    executiveOverview: `Performance for the ${period} period is ${tone}. Revenue closed at ${cur.income.toFixed(
      2
    )}, expenses at ${cur.expense.toFixed(2)}, producing profit of ${cur.profit.toFixed(2)} (${profDelta}% versus prior comparable).`,
    revenuePerformance: `Revenue moved by ${incDelta}% period-on-period. ${
      topInc ? `Primary driver is ${topInc.category} at ${topInc.total.toFixed(2)} across ${topInc.count} transactions.` : ''
    }`,
    costPerformance: `Operating costs changed by ${expDelta}%. ${
      topExp ? `Largest expense concentration is ${topExp.category} at ${topExp.total.toFixed(2)}.` : ''
    }`,
    profitabilityAndEfficiency: `Current profit margin is ${
      cur.income ? ((cur.profit / cur.income) * 100).toFixed(2) : '0.00'
    }%. This indicates ${cur.profit >= 0 ? 'healthy conversion of revenue to earnings' : 'earnings compression that needs intervention'}.`,
    riskAssessment:
      insight.risks?.length
        ? `Key risks identified: ${insight.risks.join(' ')}`
        : 'No immediate critical financial risk flags from current aggregates, but monitor cost growth and receivables closely.',
    forecastAndOutlook: `Forecast for next ${period} period projects revenue of ${forecast.projection.nextPeriodRevenue.toFixed(
      2
    )}, expenses of ${forecast.projection.nextPeriodExpense.toFixed(2)}, and profit of ${forecast.projection.nextPeriodProfit.toFixed(
      2
    )} (margin ${forecast.projection.nextPeriodProfitMarginPct}%).`,
    recommendations:
      insight.actions?.length
        ? `Recommended actions: ${insight.actions.join(' ')}`
        : 'Maintain revenue momentum, manage variable expenses, and keep debtor follow-up cadence weekly.',
  };

  return {
    title: `Detailed ${period} financial report`,
    generatedAt: new Date().toISOString(),
    ...sections,
  };
}

function localSummary(payload) {
  const { period, current, prior, currentDetails } = payload;
  const incDelta = pctChange(current.totals.income, prior.totals.income);
  const expDelta = pctChange(current.totals.expense, prior.totals.expense);
  const profitDelta = pctChange(current.totals.profit, prior.totals.profit);
  const topInc = currentDetails.topIncomeCategory;
  const topExp = currentDetails.topExpenseCategory;
  const highlights = [];
  if (current.totals.profit >= 0) highlights.push(`Profit is positive at ${current.totals.profit.toFixed(2)} for the ${period} period.`);
  else highlights.push(`Profit is negative at ${current.totals.profit.toFixed(2)} for the ${period} period.`);
  highlights.push(`Income changed by ${incDelta}% versus previous comparable period.`);
  highlights.push(`Expense changed by ${expDelta}% versus previous comparable period.`);
  if (topInc) highlights.push(`Top revenue category is ${topInc.category} (${topInc.total.toFixed(2)}).`);
  if (topExp) highlights.push(`Top expense category is ${topExp.category} (${topExp.total.toFixed(2)}).`);
  const risks = [];
  if (current.totals.expense > current.totals.income) risks.push('Expenses exceed income in the selected period.');
  if (expDelta > 20) risks.push('Expenses are rising quickly compared to the previous period.');
  const actions = [];
  actions.push('Review top expense categories and freeze non-essential spend this week.');
  actions.push('Follow up outstanding debtors to improve near-term cash collections.');
  if (current.totals.profit < 0) actions.push('Prioritize high-margin bookings/events to recover profitability.');
  const sections = {
    revenue: {
      detail: `Revenue is ${current.totals.income.toFixed(2)} (${incDelta}% vs prior).`,
      topCategories: currentDetails.incomeByCategory.slice(0, 5),
    },
    expenses: {
      detail: `Expenses are ${current.totals.expense.toFixed(2)} (${expDelta}% vs prior).`,
      topCategories: currentDetails.expenseByCategory.slice(0, 5),
    },
    profitability: {
      detail: `Profit is ${current.totals.profit.toFixed(2)} (${profitDelta}% vs prior).`,
      marginPct: current.totals.income ? Number(((current.totals.profit / current.totals.income) * 100).toFixed(2)) : 0,
    },
    risks: { detail: risks.join(' ') || 'No critical risks detected from current period aggregates.' },
    actions: { detail: actions.join(' ') },
  };
  return {
    mode: 'local_fallback',
    summary: `For the ${period} period, income is ${current.totals.income.toFixed(2)}, expense is ${current.totals.expense.toFixed(
      2
    )}, and profit is ${current.totals.profit.toFixed(2)} (${profitDelta}% vs prior).`,
    executiveSummary: `Performance is ${current.totals.profit >= 0 ? 'profitable' : 'loss-making'} with ${
      current.totals.income.toFixed(2)
    } revenue and ${current.totals.expense.toFixed(2)} expenses.`,
    sections,
    highlights,
    risks,
    actions,
    detailedReport: buildDetailedNarrative(payload, { highlights, risks, actions }, buildForecast(payload)),
    forecast: buildForecast(payload),
  };
}

async function openAiSummary(payload) {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) return null;
  const model = process.env.OPENAI_REPORT_MODEL || 'gpt-4o-mini';
  const prompt = `
You are a finance reporting assistant. Return JSON only with keys:
summary (string), executiveSummary (string), highlights (array of strings), risks (array of strings), actions (array of strings),
sections (object with keys revenue, expenses, profitability, risks, actions where each section has detail string and optional arrays/metrics).
forecast (object with assumptions[], drivers{}, projection{}),
detailedReport (object with keys: title, generatedAt, executiveOverview, revenuePerformance, costPerformance, profitabilityAndEfficiency, riskAssessment, forecastAndOutlook, recommendations).
Be detailed section-by-section and specific to the metrics, writing full management-report style narratives.

Input:
${JSON.stringify(payload)}
`;
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      input: prompt,
      text: { format: { type: 'json_object' } },
    }),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`AI provider error: ${response.status} ${errText}`);
  }
  const data = await response.json();
  const raw = data.output_text || '{}';
  return { mode: 'openai', ...JSON.parse(raw) };
}

async function buildAiSummaryData(periodInput) {
  const period = ['weekly', 'monthly', 'quarterly', 'annual'].includes(String(periodInput || '').toLowerCase())
    ? String(periodInput).toLowerCase()
    : 'monthly';
  const { start, end } = periodRange(period);
  const prior = priorRange(start, end);
  const [currentData, priorData, currentDetails, priorDetails] = await Promise.all([
    runAggregation(start, end),
    runAggregation(prior.start, prior.end),
    runDetailedAggregation(start, end),
    runDetailedAggregation(prior.start, prior.end),
  ]);
  const payload = {
    period,
    current: { totals: currentData },
    prior: { totals: priorData },
    currentDetails,
    priorDetails,
    dateRange: {
      start: start.toISOString(),
      end: end.toISOString(),
    },
  };

  let insight;
  try {
    insight = (await openAiSummary(payload)) || localSummary(payload);
  } catch (err) {
    insight = { ...localSummary(payload), warning: err.message };
  }
  if (!insight.forecast) insight.forecast = buildForecast(payload);
  if (!insight.detailedReport) insight.detailedReport = buildDetailedNarrative(payload, insight, insight.forecast);
  return { period, aggregates: payload, insight };
}

function money(v) {
  return `ZAR ${Number(v || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function buildAiSummaryPdfBuffer(result, opts = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const right = left + width;
    const green = '#14532d';
    const lightGreen = '#f0fdf4';
    const agg = result.aggregates;
    const insight = result.insight || {};
    const periodLabel = `${String(result.period || '').charAt(0).toUpperCase()}${String(result.period || '').slice(1)} ${
      new Date(agg.dateRange.start).getUTCFullYear()
    }`;
    const compiledBy = String(opts.compiledBy || 'SYSTEM').toUpperCase();
    const generatedAt = new Date().toLocaleString('en-ZA', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const revTop = agg.currentDetails?.topIncomeCategory;
    const revBooking = agg.currentDetails?.incomeByCategory?.find((c) => String(c.category) === 'booking');
    const bookingCount = Number(revBooking?.count || revTop?.count || 0);
    const occupancyPct = 'N/A';
    const stockAlerts = 0;

    const sectionTitle = (title) => {
      doc.font('Helvetica-Bold').fontSize(17).fillColor(green).text(`| ${title}`, left, doc.y, { width });
      doc.moveDown(0.35);
    };
    const divider = () => {
      doc.strokeColor('#e5e7eb').lineWidth(1).moveTo(left, doc.y).lineTo(right, doc.y).stroke();
      doc.moveDown(0.55);
    };

    doc.font('Helvetica-Bold').fontSize(24).fillColor(green).text(`${periodLabel} AI Business Performance Report`, left, doc.y, { width });
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(10).fillColor('#374151').text(
      `Period: ${periodLabel} | Compiled by: ${compiledBy} | Generated: ${generatedAt}`,
      left,
      doc.y,
      { width }
    );
    doc.moveDown(0.4);
    divider();

    sectionTitle('Executive Summary');
    doc.font('Helvetica').fontSize(11).fillColor('#111827').text(insight.executiveSummary || insight.summary || 'No summary generated.', left, doc.y, {
      width,
    });
    doc.moveDown(0.75);

    sectionTitle('AI Narrative');
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#374151').text(`Mode: ${insight.mode || 'local'}`, left, doc.y, { width });
    doc.moveDown(0.25);
    doc.font('Helvetica').fontSize(10).fillColor('#111827').text(insight.summary || '—', left, doc.y, { width });
    doc.moveDown(0.5);

    // Highlights/Risks/Actions table
    const tY = doc.y;
    const c1 = left;
    const c2 = left + width * 0.53;
    const c3 = left + width * 0.72;
    const h = 84;
    doc.rect(left, tY, width, 22).fillAndStroke(lightGreen, '#d1d5db');
    doc.fillColor('#111827').font('Helvetica-Bold').fontSize(10).text('Highlights', c1 + 6, tY + 6, { width: c2 - c1 - 10 });
    doc.text('Risks', c2 + 6, tY + 6, { width: c3 - c2 - 10 });
    doc.text('Actions', c3 + 6, tY + 6, { width: right - c3 - 10 });
    doc.rect(left, tY + 22, width, h).stroke('#d1d5db');
    const hi = (insight.highlights || []).join(' | ') || '—';
    const rk = (insight.risks || []).join(' | ') || '—';
    const ac = (insight.actions || []).join(' | ') || '—';
    doc.font('Helvetica').fontSize(9).fillColor('#111827').text(hi, c1 + 6, tY + 28, { width: c2 - c1 - 12 });
    doc.text(rk, c2 + 6, tY + 28, { width: c3 - c2 - 12 });
    doc.text(ac, c3 + 6, tY + 28, { width: right - c3 - 12 });
    doc.y = tY + h + 28;

    // KPI cards (2 rows x 3 columns)
    const kpiTop = doc.y;
    const gap = 10;
    const kpiW = (width - gap * 2) / 3;
    const kpiH = 56;
    const kpis = [
      { label: 'REVENUE', value: `R ${Math.round(agg.current.totals.income).toLocaleString('en-ZA')}` },
      { label: 'EXPENSES', value: `R ${Math.round(agg.current.totals.expense).toLocaleString('en-ZA')}` },
      { label: 'NET', value: `R ${Math.round(agg.current.totals.profit).toLocaleString('en-ZA')}` },
      { label: 'BOOKINGS (ALL)', value: String(bookingCount) },
      { label: 'OCCUPANCY', value: String(occupancyPct) },
      { label: 'STOCK ALERTS', value: String(stockAlerts) },
    ];
    kpis.forEach((k, idx) => {
      const row = Math.floor(idx / 3);
      const col = idx % 3;
      const x = left + col * (kpiW + gap);
      const y = kpiTop + row * (kpiH + gap);
      doc.roundedRect(x, y, kpiW, kpiH, 6).fillAndStroke('#ffffff', '#d1d5db');
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#6b7280').text(k.label, x + 10, y + 9, { width: kpiW - 20 });
      doc.font('Helvetica-Bold').fontSize(22).fillColor(green).text(k.value, x + 10, y + 24, { width: kpiW - 20 });
    });
    doc.y = kpiTop + (kpiH * 2) + gap + 12;

    sectionTitle('Coverage Across Admin and Finance Pages');
    // Coverage table
    const y2 = doc.y;
    const a1 = left;
    const a2 = left + width * 0.34;
    const a3 = left + width * 0.85;
    doc.rect(left, y2, width, 20).fillAndStroke(lightGreen, '#d1d5db');
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#111827').text('Area', a1 + 6, y2 + 5);
    doc.text('Metric', a2 + 6, y2 + 5);
    doc.text('Status', a3 + 6, y2 + 5);
    const rows = [
      {
        area: 'Bookings & Reservations',
        metric: `${bookingCount} bookings | Top revenue: ${revTop?.category || '—'} ${revTop ? money(revTop.total) : ''}`,
        status: 'Included',
      },
      {
        area: 'Finance & Costs',
        metric: `Expenses ${money(agg.current.totals.expense)} | Top expense: ${agg.currentDetails?.topExpenseCategory?.category || '—'}`,
        status: 'Included',
      },
      {
        area: 'Forecast',
        metric: insight.forecast?.projection
          ? `Next period profit: ${money(insight.forecast.projection.nextPeriodProfit)} (${insight.forecast.projection.nextPeriodProfitMarginPct}% margin)`
          : 'Forecast unavailable',
        status: 'Included',
      },
    ];
    let yRow = y2 + 20;
    rows.forEach((r) => {
      doc.rect(left, yRow, width, 24).stroke('#e5e7eb');
      doc.font('Helvetica').fontSize(9).fillColor('#111827').text(r.area, a1 + 6, yRow + 7, { width: a2 - a1 - 10 });
      doc.text(r.metric, a2 + 6, yRow + 7, { width: a3 - a2 - 10 });
      doc.text(r.status, a3 + 6, yRow + 7, { width: right - a3 - 10 });
      yRow += 24;
    });
    doc.y = yRow + 8;

    if (insight.detailedReport) {
      sectionTitle('Narrative Detail');
      const narrative = [
        insight.detailedReport.executiveOverview,
        insight.detailedReport.revenuePerformance,
        insight.detailedReport.costPerformance,
        insight.detailedReport.profitabilityAndEfficiency,
        insight.detailedReport.riskAssessment,
        insight.detailedReport.forecastAndOutlook,
        insight.detailedReport.recommendations,
      ]
        .filter(Boolean)
        .join('\n\n');
      doc.font('Helvetica').fontSize(10).fillColor('#111827').text(narrative || '—', left, doc.y, { width });
    }
    doc.end();
  });
}

const getWeekly = asyncHandler(async (req, res) => {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 7);
  const data = await runAggregation(start, end);
  res.json({ success: true, data });
});

const getMonthly = asyncHandler(async (req, res) => {
  const end = new Date();
  const start = new Date(end.getFullYear(), end.getMonth(), 1);
  const data = await runAggregation(start, end);
  res.json({ success: true, data });
});

const getQuarterly = asyncHandler(async (req, res) => {
  const end = new Date();
  const quarter = Math.floor(end.getMonth() / 3) + 1;
  const start = new Date(end.getFullYear(), (quarter - 1) * 3, 1);
  const data = await runAggregation(start, end);
  res.json({ success: true, data });
});

const getAnnual = asyncHandler(async (req, res) => {
  const end = new Date();
  const start = new Date(end.getFullYear(), 0, 1);
  const data = await runAggregation(start, end);
  res.json({ success: true, data });
});

const exportReport = asyncHandler(async (req, res) => {
  const { type } = req.params;
  const end = new Date();
  let start;
  if (type === 'weekly') {
    start = new Date(end);
    start.setDate(start.getDate() - 7);
  } else if (type === 'monthly') {
    start = new Date(end.getFullYear(), end.getMonth(), 1);
  } else if (type === 'quarterly') {
    const q = Math.floor(end.getMonth() / 3) + 1;
    start = new Date(end.getFullYear(), (q - 1) * 3, 1);
  } else {
    start = new Date(end.getFullYear(), 0, 1);
  }
  const data = await runAggregation(start, end);
  res.setHeader('Content-Type', 'application/json');
  res.json({ success: true, data });
});

const getAiSummary = asyncHandler(async (req, res) => {
  const result = await buildAiSummaryData(req.body.period);

  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'create',
    entity: 'AiReportSummary',
    after: { period: result.period, mode: result.insight?.mode },
    req,
  });

  res.json({
    success: true,
    data: result,
  });
});

const getAiSummaryPdf = asyncHandler(async (req, res) => {
  const result = await buildAiSummaryData(req.query.period);
  const pdf = await buildAiSummaryPdfBuffer(result, { compiledBy: req.user?.role || 'admin' });
  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'create',
    entity: 'AiReportSummaryPdf',
    after: { period: result.period, mode: result.insight?.mode },
    req,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="ai-report-${result.period}-${new Date().toISOString().slice(0, 10)}.pdf"`);
  res.send(pdf);
});

module.exports = { getWeekly, getMonthly, getQuarterly, getAnnual, exportReport, getAiSummary, getAiSummaryPdf };
