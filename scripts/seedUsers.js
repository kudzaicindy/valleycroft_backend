/**
 * Seed initial users for each role.
 * Run once: node scripts/seedUsers.js
 * Uses plain passwords; change after first login.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../src/models/User');

const SEED_USERS = [
  { name: 'CEO User', email: 'ceo@valleyroad.com', password: 'ceo123456', role: 'ceo' },
  { name: 'Admin User', email: 'admin@valleyroad.com', password: 'admin123456', role: 'admin' },
  { name: 'Finance User', email: 'finance@valleyroad.com', password: 'finance123456', role: 'finance' },
  { name: 'Employee User', email: 'employee@valleyroad.com', password: 'employee123456', role: 'employee' },
];

async function seed() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    for (const u of SEED_USERS) {
      const existing = await User.findOne({ email: u.email });
      if (existing) {
        console.log(`Skip (exists): ${u.email} (${u.role})`);
        continue;
      }
      await User.create(u);
      console.log(`Created: ${u.email} (${u.role})`);
    }

    console.log('Seed done.');
  } catch (err) {
    console.error('Seed error:', err.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

seed();
