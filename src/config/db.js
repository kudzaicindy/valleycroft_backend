const mongoose = require('mongoose');
const Account = require('../models/Account');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI);
    console.log(`MongoDB Connected: ${conn.connection.host}`);

    Account.countDocuments()
      .then((n) => {
        if (n === 0) {
          console.warn(
            '\n[Accounting] No chart of accounts in this database. Creating finance transactions will fail ' +
              '(e.g. "Unknown account code: 1002") until you run:\n' +
              '  npm run seed:accounting\n' +
              'Or use: npm run seed:all (after seed:users).\n'
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
