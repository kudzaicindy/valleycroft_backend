/** Default food add-on catalogue — seeded into MongoDB when empty. */
const DEFAULT_FOOD_ADD_ONS = {
  breakfast: {
    id: 'breakfast',
    label: 'Breakfast',
    unitPrice: 100,
    billing: 'per_person_per_morning',
  },
  picnic: {
    id: 'picnic',
    label: 'Picnic setup + hamper',
    unitPrice: 800,
    billing: 'per_person_once',
  },
};

const FOOD_ADD_ON_IDS = Object.keys(DEFAULT_FOOD_ADD_ONS);

/** GL revenue accounts for guest booking recognition */
const REVENUE_ACCOUNTS = {
  room: '4001',
  food: '4003',
};

module.exports = {
  DEFAULT_FOOD_ADD_ONS,
  FOOD_ADD_ON_IDS,
  REVENUE_ACCOUNTS,
  /** @deprecated use foodAddOnService */
  FOOD_ADD_ONS: DEFAULT_FOOD_ADD_ONS,
};
