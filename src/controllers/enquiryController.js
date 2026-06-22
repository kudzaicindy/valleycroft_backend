const Enquiry = require('../models/Enquiry');
const Quotation = require('../models/Quotation');
const { asyncHandler, getPagination } = require('../utils/helpers');
const logAudit = require('../utils/audit');
const {
  buildQuotationPdfBuffer,
  mailConfigured,
  getMailFrom,
} = require('./quotationController');
const invoiceNotify = require('../services/invoiceNotifyService');
const {
  parseFoodAddOns,
  hasAnyFoodAddOn,
  computeEventFoodQuote,
  catalogueForApi,
} = require('../utils/foodAddOnPricing');

const PUBLIC_CREATE_FIELDS = [
  'guestName',
  'guestEmail',
  'guestPhone',
  'eventTitle',
  'eventType',
  'eventDate',
  'venue',
  'guestCount',
  'foodAddOns',
  'subject',
  'message',
];

function pickPublicEnquiryPayload(body = {}) {
  const normalized = { ...body };
  if (normalized.name !== undefined && normalized.guestName === undefined) normalized.guestName = normalized.name;
  if (normalized.email !== undefined && normalized.guestEmail === undefined) normalized.guestEmail = normalized.email;
  if (normalized.phone !== undefined && normalized.guestPhone === undefined) normalized.guestPhone = normalized.phone;
  if (normalized.notes !== undefined && normalized.message === undefined) normalized.message = normalized.notes;

  const out = {};
  for (const key of PUBLIC_CREATE_FIELDS) {
    if (normalized[key] !== undefined) out[key] = normalized[key];
  }
  if (typeof out.guestName === 'string') out.guestName = out.guestName.trim();
  if (typeof out.guestEmail === 'string') out.guestEmail = out.guestEmail.trim();
  if (typeof out.guestPhone === 'string') out.guestPhone = out.guestPhone.trim();
  if (out.guestCount !== undefined) out.guestCount = Number(out.guestCount) || 0;
  if (!out.subject && out.eventType) out.subject = `Enquiry: ${out.eventType}`;
  if (!out.message) {
    out.message = [
      out.subject || 'Guest enquiry',
      out.eventType ? `Event type: ${out.eventType}` : '',
      out.eventDate ? `Event date: ${out.eventDate}` : '',
      out.guestCount ? `Guest count: ${out.guestCount}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  return out;
}

function foodAddOnsFromBody(body) {
  if (body.foodAddOns !== undefined) {
    const raw = body.foodAddOns;
    if (typeof raw === 'string' && raw.includes(',')) {
      return parseFoodAddOns(raw.split(',').map((s) => s.trim()));
    }
    return parseFoodAddOns(raw);
  }
  return parseFoodAddOns({
    breakfast: body.breakfast,
    picnic: body.picnic,
  });
}

function appendFoodAddOnsToMessage(message, foodQuote) {
  if (!foodQuote || !hasAnyFoodAddOn(foodQuote.foodAddOns)) return message;
  const lines = (foodQuote.lineItems || []).map(
    (li) => `  • ${li.label}: ${li.rateLabel} — R ${li.total.toFixed(2)}`,
  );
  const block = [
    'Food add-ons requested:',
    ...lines,
    `Estimated food total: R ${foodQuote.foodTotal.toFixed(2)}`,
  ].join('\n');
  const base = String(message || '').trim();
  return base ? `${base}\n\n${block}` : block;
}

function createQuotationPayloadFromEnquiry(enquiry, payload = {}) {
  const lineItems = Array.isArray(payload.lineItems) ? payload.lineItems : [];
  return {
    quotationNumber: payload.quotationNumber,
    clientName: payload.clientName || enquiry.guestName,
    clientEmail: payload.clientEmail || enquiry.guestEmail,
    clientPhone: payload.clientPhone || enquiry.guestPhone,
    eventTitle: payload.eventTitle || enquiry.eventTitle,
    eventType: payload.eventType || enquiry.eventType,
    eventDate: payload.eventDate || enquiry.eventDate,
    venue: payload.venue || enquiry.venue,
    guestCount:
      payload.guestCount !== undefined ? Number(payload.guestCount) || 0 : Number(enquiry.guestCount || 0),
    validUntil: payload.validUntil,
    currency: payload.currency || 'ZAR',
    lineItems: lineItems.map((item) => {
      const qtyRaw = item.qty ?? item.quantity ?? 0;
      const qty = Number(qtyRaw) || 0;
      const unitPrice = Number(item.unitPrice) || 0;
      const computedTotal = Number((qty * unitPrice).toFixed(2));
      return {
        description: item.description,
        qty,
        unitPrice,
        total: Number(item.total) || computedTotal,
      };
    }),
    tax: Number(payload.tax) || 0,
    notes: payload.notes || '',
    terms: payload.terms || '',
    status: payload.status || 'draft',
  };
}

const getFoodAddOnCatalogue = asyncHandler(async (_req, res) => {
  res.json({ success: true, data: catalogueForApi() });
});

const quoteEventFood = asyncHandler(async (req, res) => {
  const guestCount = Number(req.query.guestCount ?? req.query.guests ?? 0);
  if (!Number.isFinite(guestCount) || guestCount < 0) {
    return res.status(400).json({ success: false, message: 'guestCount must be a valid non-negative number' });
  }
  const foodAddOns = foodAddOnsFromBody(req.query);
  if (!hasAnyFoodAddOn(foodAddOns)) {
    return res.json({
      success: true,
      data: { guestCount, foodAddOns, lineItems: [], foodTotal: 0, currency: 'ZAR' },
    });
  }
  if (guestCount < 1) {
    return res.status(400).json({
      success: false,
      message: 'guestCount is required (minimum 1) to estimate food add-ons',
    });
  }
  const quote = computeEventFoodQuote({ guestCount, foodAddOns });
  res.json({ success: true, data: { ...quote, currency: 'ZAR' } });
});

const createPublicEnquiry = asyncHandler(async (req, res) => {
  const payload = pickPublicEnquiryPayload(req.body);
  if (!payload.guestName || !payload.guestEmail || !payload.message) {
    return res.status(400).json({
      success: false,
      message: 'guestName, guestEmail and message are required',
    });
  }
  const foodAddOns = foodAddOnsFromBody(req.body);
  const guestCount = Number(payload.guestCount) || 0;
  if (hasAnyFoodAddOn(foodAddOns) && guestCount < 1) {
    return res.status(400).json({
      success: false,
      message: 'guestCount is required (minimum 1) when food add-ons are selected',
    });
  }
  let foodTotal = 0;
  let foodLineItems = [];
  if (hasAnyFoodAddOn(foodAddOns) && guestCount > 0) {
    const foodQuote = computeEventFoodQuote({ guestCount, foodAddOns });
    foodTotal = foodQuote.foodTotal;
    foodLineItems = foodQuote.lineItems;
    payload.message = appendFoodAddOnsToMessage(payload.message, foodQuote);
  }
  payload.foodAddOns = foodAddOns;
  payload.foodTotal = foodTotal;
  const enquiry = await Enquiry.create(payload);
  return res.status(201).json({
    success: true,
    data: {
      ...enquiry.toObject(),
      foodLineItems,
    },
  });
});

const listEnquiries = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, status } = req.query;
  const { skip, limit: lim } = getPagination(page, limit);
  const query = {};
  if (status && ['new', 'responded', 'closed'].includes(String(status))) query.status = status;
  const [data, total] = await Promise.all([
    Enquiry.find(query).sort({ createdAt: -1 }).skip(skip).limit(lim).populate('quotationId', 'quotationNumber status total').lean(),
    Enquiry.countDocuments(query),
  ]);
  res.json({ success: true, data, meta: { page: Number(page), limit: lim, total } });
});

const getEnquiryById = asyncHandler(async (req, res) => {
  const enquiry = await Enquiry.findById(req.params.id).populate('quotationId').lean();
  if (!enquiry) return res.status(404).json({ success: false, message: 'Enquiry not found' });
  return res.json({ success: true, data: enquiry });
});

const respondToEnquiry = asyncHandler(async (req, res) => {
  const enquiry = await Enquiry.findById(req.params.id);
  if (!enquiry) return res.status(404).json({ success: false, message: 'Enquiry not found' });

  const {
    quotationId,
    quotation: quotationInput = {},
    responseMessage = '',
    adminNotes = '',
    sendEmail = true,
    to,
    subject,
  } = req.body || {};

  let quotation;
  if (quotationId) {
    quotation = await Quotation.findById(quotationId);
    if (!quotation) {
      return res.status(404).json({ success: false, message: 'Quotation not found' });
    }
  } else {
    const quotationPayload = createQuotationPayloadFromEnquiry(enquiry, quotationInput);
    quotation = await Quotation.create({ ...quotationPayload, createdBy: req.user._id });
  }

  let mailInfo = null;
  if (sendEmail) {
    if (!mailConfigured()) {
      return res.status(400).json({
        success: false,
        message: 'Mail is not configured on the server',
      });
    }
    const recipient = String(to || quotation.clientEmail || enquiry.guestEmail || '').trim();
    if (!recipient) {
      return res.status(400).json({ success: false, message: 'Recipient email is required' });
    }
    const pdfBuffer = await buildQuotationPdfBuffer(quotation.toObject ? quotation.toObject() : quotation);
    const bodyText =
      responseMessage ||
      `Dear ${quotation.clientName || enquiry.guestName},\n\nThank you for your enquiry. Please find your quotation attached.\n\nRegards,\nValleycroft Team`;
    mailInfo = await invoiceNotify.sendViaMailTransport({
      from: getMailFrom(),
      to: recipient,
      subject: subject || `Quotation ${quotation.quotationNumber}`,
      text: bodyText,
      attachments: [
        {
          filename: `${quotation.quotationNumber || quotation._id}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    });
    if (quotation.status === 'draft') {
      quotation.status = 'sent';
      await quotation.save();
    }
  }

  enquiry.status = 'responded';
  enquiry.responseMessage = responseMessage || enquiry.responseMessage;
  enquiry.adminNotes = adminNotes || enquiry.adminNotes;
  enquiry.respondedAt = new Date();
  enquiry.respondedBy = req.user._id;
  enquiry.quotationId = quotation._id;
  await enquiry.save();

  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'update',
    entity: 'Enquiry',
    entityId: enquiry._id,
    after: {
      status: enquiry.status,
      quotationId: quotation._id,
      emailed: !!mailInfo,
      recipient: to || quotation.clientEmail || enquiry.guestEmail,
    },
    req,
  });

  return res.json({
    success: true,
    data: {
      enquiry,
      quotation,
      email: mailInfo ? { messageId: mailInfo.messageId } : null,
    },
  });
});

const closeEnquiry = asyncHandler(async (req, res) => {
  const enquiry = await Enquiry.findById(req.params.id);
  if (!enquiry) return res.status(404).json({ success: false, message: 'Enquiry not found' });
  enquiry.status = 'closed';
  if (req.body?.adminNotes) enquiry.adminNotes = req.body.adminNotes;
  await enquiry.save();
  return res.json({ success: true, data: enquiry });
});

module.exports = {
  getFoodAddOnCatalogue,
  quoteEventFood,
  createPublicEnquiry,
  listEnquiries,
  getEnquiryById,
  respondToEnquiry,
  closeEnquiry,
};
