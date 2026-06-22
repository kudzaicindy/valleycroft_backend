/** Food add-on catalogue — rates in ZAR (R). */
const FOOD_ADD_ONS = {
  breakfast: {
    id: 'breakfast',
    label: 'Breakfast',
    rateLabel: 'R 100 per person per morning',
    unitPrice: 100,
    billing: 'per_person_per_morning',
  },
  picnic: {
    id: 'picnic',
    label: 'Picnic setup + hamper',
    rateLabel: 'R 800 per person (one-time)',
    unitPrice: 800,
    billing: 'per_person_once',
  },
};

const FOOD_ADD_ON_IDS = Object.keys(FOOD_ADD_ONS);

/** GL revenue accounts for guest booking recognition */
const REVENUE_ACCOUNTS = {
  room: '4001',
  food: '4003',
};

module.exports = { FOOD_ADD_ONS, FOOD_ADD_ON_IDS, REVENUE_ACCOUNTS };
