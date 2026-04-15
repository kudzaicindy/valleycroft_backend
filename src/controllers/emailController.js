const Email = require('../models/Email');
const { asyncHandler, getPagination } = require('../utils/helpers');

const list = asyncHandler(async (req, res) => {
  const { page = 1, limit = 30, status, templateKey, relatedModel } = req.query;
  const { skip, limit: lim } = getPagination(page, limit);
  const filter = {};
  if (status) filter.status = status;
  if (templateKey) filter.templateKey = templateKey;
  if (relatedModel) filter.relatedModel = relatedModel;

  const [data, total] = await Promise.all([
    Email.find(filter).sort({ createdAt: -1 }).skip(skip).limit(lim).lean(),
    Email.countDocuments(filter),
  ]);

  res.json({
    success: true,
    data,
    meta: { page: parseInt(page, 10), limit: lim, total },
  });
});

module.exports = { list };
