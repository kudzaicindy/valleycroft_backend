const FoodAddOn = require('../models/FoodAddOn');
const { DEFAULT_FOOD_ADD_ONS, FOOD_ADD_ON_IDS } = require('../constants/foodAddOns');
const { round2 } = require('../utils/math');

/** @type {Record<string, { id: string, label: string, unitPrice: number, billing: string, rateLabel: string, isActive: boolean }>} */
let cache = {};

function formatMoney(n) {
  const v = round2(Number(n) || 0);
  return `R ${v % 1 === 0 ? v.toFixed(0) : v.toFixed(2)}`;
}

function buildRateLabel(def) {
  const price = formatMoney(def.unitPrice);
  if (def.billing === 'per_person_per_morning') {
    return `${price} per person per morning`;
  }
  if (def.billing === 'per_person_once') {
    return `${price} per person (one-time)`;
  }
  return price;
}

function toCachedEntry(row) {
  const id = row.addOnId || row.id;
  const billing = row.billing || DEFAULT_FOOD_ADD_ONS[id]?.billing;
  const entry = {
    id,
    label: row.label,
    unitPrice: round2(row.unitPrice),
    billing,
    isActive: row.isActive !== false,
  };
  entry.rateLabel = buildRateLabel(entry);
  return entry;
}

function loadDefaultsIntoCache() {
  cache = {};
  for (const id of FOOD_ADD_ON_IDS) {
    const def = DEFAULT_FOOD_ADD_ONS[id];
    cache[id] = toCachedEntry({
      addOnId: id,
      label: def.label,
      unitPrice: def.unitPrice,
      billing: def.billing,
      isActive: true,
    });
  }
}

function refreshCacheFromRows(rows) {
  cache = {};
  for (const row of rows) {
    const entry = toCachedEntry(row);
    cache[entry.id] = entry;
  }
  for (const id of FOOD_ADD_ON_IDS) {
    if (!cache[id]) {
      const def = DEFAULT_FOOD_ADD_ONS[id];
      cache[id] = toCachedEntry({
        addOnId: id,
        label: def.label,
        unitPrice: def.unitPrice,
        billing: def.billing,
        isActive: true,
      });
    }
  }
}

async function ensureFoodAddOnsSeeded() {
  const count = await FoodAddOn.countDocuments();
  if (count > 0) return;
  const docs = FOOD_ADD_ON_IDS.map((addOnId) => {
    const def = DEFAULT_FOOD_ADD_ONS[addOnId];
    return {
      addOnId,
      label: def.label,
      unitPrice: def.unitPrice,
      billing: def.billing,
      isActive: true,
    };
  });
  await FoodAddOn.insertMany(docs);
}

async function refreshFoodAddOnCache() {
  await ensureFoodAddOnsSeeded();
  const rows = await FoodAddOn.find().sort({ addOnId: 1 }).lean();
  refreshCacheFromRows(rows);
  return cache;
}

async function initFoodAddOns() {
  loadDefaultsIntoCache();
  try {
    await refreshFoodAddOnCache();
  } catch (err) {
    console.error('[food-add-ons] cache init failed, using defaults:', err?.message || err);
    loadDefaultsIntoCache();
  }
}

function getFoodAddOnsMap() {
  return cache;
}

function getFoodAddOn(id) {
  return cache[id] || null;
}

function getAllFoodAddOnIds() {
  return FOOD_ADD_ON_IDS;
}

function getActiveFoodAddOnIds() {
  return FOOD_ADD_ON_IDS.filter((id) => cache[id]?.isActive !== false);
}

function catalogueForApi({ activeOnly = true } = {}) {
  const ids = activeOnly ? getActiveFoodAddOnIds() : getAllFoodAddOnIds();
  return ids.map((id) => {
    const def = cache[id];
    return {
      id: def.id,
      label: def.label,
      rateLabel: def.rateLabel,
      unitPrice: def.unitPrice,
      billing: def.billing,
      isActive: def.isActive,
      currency: 'ZAR',
    };
  });
}

async function listForAdmin() {
  await ensureFoodAddOnsSeeded();
  const rows = await FoodAddOn.find().sort({ addOnId: 1 }).lean();
  return rows.map((row) => {
    const entry = toCachedEntry(row);
    return {
      ...entry,
      updatedAt: row.updatedAt,
      createdAt: row.createdAt,
      updatedBy: row.updatedBy,
    };
  });
}

async function updateFoodAddOn(addOnId, updates, userId) {
  const id = String(addOnId || '').trim().toLowerCase();
  if (!FOOD_ADD_ON_IDS.includes(id)) {
    throw new Error(`Unknown food add-on: ${addOnId}`);
  }

  await ensureFoodAddOnsSeeded();
  const doc = await FoodAddOn.findOne({ addOnId: id });
  if (!doc) throw new Error(`Food add-on not found: ${id}`);

  if (updates.label !== undefined) {
    const label = String(updates.label || '').trim();
    if (!label) throw new Error('label cannot be empty');
    doc.label = label;
  }
  if (updates.unitPrice !== undefined) {
    const price = Number(updates.unitPrice);
    if (!Number.isFinite(price) || price < 0) {
      throw new Error('unitPrice must be a non-negative number');
    }
    doc.unitPrice = round2(price);
  }
  if (updates.isActive !== undefined) {
    doc.isActive = !!updates.isActive;
  }
  if (userId) doc.updatedBy = userId;
  await doc.save();

  await refreshFoodAddOnCache();
  return toCachedEntry(doc.toObject());
}

module.exports = {
  initFoodAddOns,
  refreshFoodAddOnCache,
  getFoodAddOnsMap,
  getFoodAddOn,
  getAllFoodAddOnIds,
  getActiveFoodAddOnIds,
  catalogueForApi,
  listForAdmin,
  updateFoodAddOn,
  buildRateLabel,
};
