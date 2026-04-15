const mongoose = require('mongoose');
const Account = require('../models/Account');

const connectDB = async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri || typeof uri !== 'string' || !uri.trim()) {
    console.error(
      'Missing MongoDB connection string. Set MONGO_URI in a .env file in the project root ' +
        '(see .env.example). Example local value:\n' +
        '  MONGO_URI=mongodb://127.0.0.1:27017/valleyroad'
    );
    process.exit(1);
  }

  try {
    const conn = await mongoose.connect(uri.trim());
    console.log(`MongoDB Connected: ${conn.connection.host}`);

    Account.countDocuments()
      .then((n) => {
        if (n === 0) {
          console.warn(
            '\n[Accounting] No chart of accounts in this database. Creating finance transactions will fail ' +
              '(e.g. "Unknown account code: 1001") until you run:\n' +
              '  npm run seed:chart-v3\n' +
              '(alias: npm run seed:accounting)\n'
          );
        }
      })
      .catch(() => {
        /* ignore count errors during startup */
      });
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
