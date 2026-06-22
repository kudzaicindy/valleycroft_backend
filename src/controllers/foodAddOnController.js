const { asyncHandler } = require('../utils/helpers');
const logAudit = require('../utils/audit');
const foodAddOnService = require('../services/foodAddOnService');

const getPublicCatalogue = asyncHandler(async (_req, res) => {
  res.json({
    success: true,
    data: foodAddOnService.catalogueForApi({ activeOnly: true }),
  });
});

const getAdminCatalogue = asyncHandler(async (_req, res) => {
  const data = await foodAddOnService.listForAdmin();
  res.json({ success: true, data });
});

const updateFoodAddOn = asyncHandler(async (req, res) => {
  const before = await foodAddOnService.listForAdmin();
  const prior = before.find((row) => row.id === req.params.addOnId);

  const updated = await foodAddOnService.updateFoodAddOn(
    req.params.addOnId,
    {
      label: req.body.label,
      unitPrice: req.body.unitPrice,
      isActive: req.body.isActive,
    },
    req.user._id,
  );

  await logAudit({
    userId: req.user._id,
    role: req.user.role,
    action: 'update',
    entity: 'FoodAddOn',
    entityId: req.params.addOnId,
    before: prior,
    after: updated,
    req,
  });

  res.json({ success: true, data: updated });
});

module.exports = {
  getPublicCatalogue,
  getAdminCatalogue,
  updateFoodAddOn,
};
