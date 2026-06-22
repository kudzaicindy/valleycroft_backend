const foodAddOnService = require('../services/foodAddOnService');
const { round2 } = require('./math');

function addonIds() {
  return foodAddOnService.getAllFoodAddOnIds();
}

function getAddon(id) {
  return foodAddOnService.getFoodAddOn(id);
}

function bookingNights(checkIn, checkOut) {
  return Math.ceil((new Date(checkOut) - new Date(checkIn)) / (1000 * 60 * 60 * 24)) || 1;
}

/** Normalise client input to { breakfast: bool, picnic: bool }. */
function parseFoodAddOns(input) {
  const selected = { breakfast: false, picnic: false };
  if (input == null) return selected;

  if (Array.isArray(input)) {
    for (const item of input) {
      const key = String(item || '').trim().toLowerCase();
      if (addonIds().includes(key)) selected[key] = true;
    }
    return selected;
  }

  if (typeof input === 'object') {
    for (const id of addonIds()) {
      const v = input[id];
      if (v === true || v === 'true' || v === '1' || v === 1) selected[id] = true;
    }
    return selected;
  }

  const single = String(input).trim().toLowerCase();
  if (single.includes(',')) {
    return parseFoodAddOns(single.split(',').map((s) => s.trim()));
  }
  if (addonIds().includes(single)) selected[single] = true;
  return selected;
}

function hasAnyFoodAddOn(selected) {
  return addonIds().some((id) => selected[id]);
}

/**
 * @param {{ guestCount: number, nights: number, selected: Record<string, boolean> }} opts
 * @returns {{ lineItems: Array<{ id, label, rateLabel, unitPrice, qty, total }>, foodTotal: number }}
 */
function computeFoodAddOnLines({ guestCount, nights, selected }) {
  const persons = Math.max(0, Number(guestCount) || 0);
  const morningCount = Math.max(1, Number(nights) || 1);
  const lineItems = [];

  if (selected.breakfast && persons > 0) {
    const def = getAddon('breakfast');
    if (def?.isActive !== false) {
      const qty = persons * morningCount;
      lineItems.push({
        id: def.id,
        label: def.label,
        rateLabel: def.rateLabel,
        unitPrice: def.unitPrice,
        qty,
        total: round2(def.unitPrice * qty),
      });
    }
  }

  if (selected.picnic && persons > 0) {
    const def = getAddon('picnic');
    if (def?.isActive !== false) {
      const qty = persons;
      lineItems.push({
        id: def.id,
        label: def.label,
        rateLabel: def.rateLabel,
        unitPrice: def.unitPrice,
        qty,
        total: round2(def.unitPrice * qty),
      });
    }
  }

  const foodTotal = round2(lineItems.reduce((sum, li) => sum + li.total, 0));
  return { lineItems, foodTotal };
}

/**
 * Full stay quote: room + optional food add-ons.
 * @param {{ pricePerNight: number, checkIn, checkOut, guestCount?: number, foodAddOns?: unknown, roomName?: string }} opts
 */
function computeStayQuote(opts) {
  const nights = bookingNights(opts.checkIn, opts.checkOut);
  const pricePerNight = Number(opts.pricePerNight) || 0;
  const roomTotal = round2(pricePerNight * nights);
  const selected = parseFoodAddOns(opts.foodAddOns);
  const guestCount = Math.max(0, Number(opts.guestCount) || 0);

  const { lineItems: foodLineItems, foodTotal } = computeFoodAddOnLines({
    guestCount,
    nights,
    selected,
  });

  const roomLabel = opts.roomName || 'Accommodation';
  const lineItems = [
    {
      id: 'room',
      label: roomLabel,
      rateLabel: `R ${pricePerNight} per night × ${nights} night${nights === 1 ? '' : 's'}`,
      unitPrice: pricePerNight,
      qty: nights,
      total: roomTotal,
    },
    ...foodLineItems,
  ];

  const totalAmount = round2(roomTotal + foodTotal);

  return {
    nights,
    guestCount,
    pricePerNight,
    roomTotal,
    foodAddOns: selected,
    foodLineItems,
    foodTotal,
    lineItems,
    totalAmount,
  };
}

/** Event / enquiry food estimate (no room component). */
function computeEventFoodQuote({ guestCount, foodAddOns }) {
  const selected = parseFoodAddOns(foodAddOns);
  const persons = Math.max(0, Number(guestCount) || 0);
  const { lineItems, foodTotal } = computeFoodAddOnLines({
    guestCount: persons,
    nights: 1,
    selected,
  });
  return {
    guestCount: persons,
    foodAddOns: selected,
    lineItems,
    foodTotal,
  };
}

function catalogueForApi() {
  return foodAddOnService.catalogueForApi({ activeOnly: true });
}

/**
 * When the website sends roomAmount + foodAmount, use that split; otherwise use the server quote.
 */
function resolveBookingAmounts(body, quote) {
  const clientRoom = Number(body?.roomAmount);
  const clientFood = Number(body?.foodAmount);
  const hasClientRoom = Number.isFinite(clientRoom) && clientRoom >= 0;
  const hasClientFood = Number.isFinite(clientFood) && clientFood >= 0;

  if (hasClientRoom && hasClientFood) {
    const roomAmount = round2(clientRoom);
    const foodAmount = round2(clientFood);
    return {
      roomAmount,
      foodAmount,
      totalAmount: round2(roomAmount + foodAmount),
    };
  }

  const roomAmount = round2(quote.roomTotal);
  const foodAmount = round2(quote.foodTotal);
  return {
    roomAmount,
    foodAmount,
    totalAmount: round2(quote.totalAmount),
  };
}

/** Align breakdown line items with resolved room/food amounts. */
function pricingBreakdownFromAmounts(quote, amounts, roomName) {
  const lineItems = [];
  const nights = quote.nights || 1;

  lineItems.push({
    id: 'room',
    label: roomName || quote.lineItems?.find((li) => li.id === 'room')?.label || 'Accommodation',
    rateLabel: quote.lineItems?.find((li) => li.id === 'room')?.rateLabel,
    unitPrice: nights > 0 ? round2(amounts.roomAmount / nights) : amounts.roomAmount,
    qty: nights,
    total: amounts.roomAmount,
  });

  if (amounts.foodAmount > 0) {
    const foodLine =
      quote.lineItems?.find((li) => li.id === 'breakfast' || li.id === 'picnic') ||
      quote.foodLineItems?.[0];
    lineItems.push({
      id: foodLine?.id || 'breakfast',
      label: foodLine?.label || 'Breakfast',
      rateLabel: foodLine?.rateLabel,
      unitPrice: foodLine?.unitPrice,
      qty: foodLine?.qty,
      total: amounts.foodAmount,
    });
  }

  return {
    nights,
    roomTotal: amounts.roomAmount,
    foodTotal: amounts.foodAmount,
    lineItems,
  };
}

/**
 * Split booking total for revenue recognition.
 * Prefers stored roomAmount / foodAmount; totalAmount is authoritative.
 */
function getGuestBookingRevenueSplit(gb) {
  const total = round2(Number(gb?.totalAmount) || 0);
  const storedFood = round2(Number(gb?.foodAmount));
  const storedRoom = round2(Number(gb?.roomAmount));

  if (storedRoom > 0 || storedFood > 0) {
    const foodTotal = storedFood > 0 ? Math.min(storedFood, total) : 0;
    const roomTotal = storedRoom > 0 ? storedRoom : round2(total - foodTotal);
    return {
      total: total || round2(roomTotal + foodTotal),
      roomTotal,
      foodTotal,
    };
  }

  const breakdown = gb?.pricingBreakdown || {};
  let foodTotal = round2(Number(breakdown.foodTotal) || 0);

  if (foodTotal <= 0 && Array.isArray(breakdown.lineItems)) {
    foodTotal = round2(
      breakdown.lineItems
        .filter((li) => li?.id === 'breakfast' || li?.id === 'picnic')
        .reduce((sum, li) => sum + (Number(li.total) || 0), 0),
    );
  }

  if (foodTotal > total) foodTotal = total;
  const roomTotal = round2(total - foodTotal);

  return { total, roomTotal, foodTotal };
}

module.exports = {
  bookingNights,
  parseFoodAddOns,
  hasAnyFoodAddOn,
  computeFoodAddOnLines,
  computeStayQuote,
  computeEventFoodQuote,
  catalogueForApi,
  resolveBookingAmounts,
  pricingBreakdownFromAmounts,
  getGuestBookingRevenueSplit,
};
