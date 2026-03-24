/**
 * Seed all collections: users, rooms, guest bookings, bookings, transactions,
 * debtors, suppliers, supplier payments, invoices, refunds, stock, equipment,
 * salary, work logs.
 * Run after seedUsers (or ensure users exist). Run once: node scripts/seedAll.js
 * Also seeds chart of accounts (same as npm run seed:accounting) so finance ↔ ledger works.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { seedChartOfAccounts } = require('./seedAccounting');
const crypto = require('crypto');

const User = require('../src/models/User');
const Room = require('../src/models/Room');
const GuestBooking = require('../src/models/GuestBooking');
const Booking = require('../src/models/Booking');
const Transaction = require('../src/models/Transaction');
const Debtor = require('../src/models/Debtor');
const Supplier = require('../src/models/Supplier');
const SupplierPayment = require('../src/models/SupplierPayment');
const Invoice = require('../src/models/Invoice');
const Refund = require('../src/models/Refund');
const Stock = require('../src/models/Stock');
const Equipment = require('../src/models/Equipment');
const Salary = require('../src/models/Salary');
const WorkLog = require('../src/models/WorkLog');

function trackingCode() {
  return crypto.randomBytes(6).toString('hex').toUpperCase();
}

function addDays(d, days) {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

async function seed() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    const admin = await User.findOne({ role: 'admin' });
    const finance = await User.findOne({ role: 'finance' });
    const employee = await User.findOne({ role: 'employee' });
    if (!admin || !finance || !employee) {
      console.log('Run npm run seed:users first to create users.');
      process.exit(1);
    }

    // --- Chart of accounts (required for POST /api/finance/transactions journal sync) ---
    const { created: acctCreated, total: acctTotal } = await seedChartOfAccounts();
    if (acctCreated > 0) {
      console.log(`Seeded ${acctCreated} new GL account(s). Total: ${acctTotal}.`);
    }

    // --- Rooms ---
    const roomNames = ['Garden Suite', 'Event Hall', 'Mountain View', 'Pool Cottage'];
    const roomPayloads = [
      { name: 'Garden Suite', description: 'Spacious suite with garden access', type: 'bnb', capacity: 2, pricePerNight: 1200, amenities: ['WiFi', 'Braai', 'Kitchen'], isAvailable: true, order: 1 },
      { name: 'Event Hall', description: 'Large hall for events and conferences', type: 'event-space', capacity: 80, pricePerNight: 5000, amenities: ['WiFi', 'Projector', 'Catering'], isAvailable: true, order: 2 },
      { name: 'Mountain View', description: 'Room with mountain views', type: 'bnb', capacity: 4, pricePerNight: 1500, amenities: ['WiFi', 'Pool', 'Braai'], isAvailable: true, order: 3 },
      { name: 'Pool Cottage', description: 'Cottage near the pool', type: 'bnb', capacity: 4, pricePerNight: 1800, amenities: ['WiFi', 'Pool', 'Aircon'], isAvailable: true, order: 4 },
    ];
    const roomIds = [];
    for (const r of roomPayloads) {
      let room = await Room.findOne({ name: r.name });
      if (!room) {
        room = await Room.create(r);
        console.log('Created room:', room.name);
      }
      roomIds.push(room._id);
    }

    // --- Guest bookings (public) ---
    if ((await GuestBooking.countDocuments()) === 0) {
      const today = new Date();
      await GuestBooking.create([
        { guestName: 'John Doe', guestEmail: 'john@example.com', guestPhone: '+27123456789', roomId: roomIds[0], checkIn: addDays(today, 7), checkOut: addDays(today, 9), totalAmount: 2400, deposit: 720, status: 'confirmed', trackingCode: trackingCode(), source: 'website' },
        { guestName: 'Jane Smith', guestEmail: 'jane@example.com', roomId: roomIds[2], checkIn: addDays(today, 14), checkOut: addDays(today, 16), totalAmount: 3000, deposit: 900, status: 'pending', trackingCode: trackingCode(), source: 'website' },
      ]);
      console.log('Created guest bookings');
    }

    // --- Internal bookings ---
    if ((await Booking.countDocuments()) === 0) {
      const today = new Date();
      await Booking.create([
        { guestName: 'Corporate Event', guestEmail: 'events@corp.com', type: 'event', eventDate: addDays(today, 21), amount: 15000, deposit: 5000, status: 'confirmed', createdBy: admin._id },
        { guestName: 'Family Stay', guestEmail: 'family@mail.com', type: 'bnb', roomId: roomIds[0], checkIn: addDays(today, 5), checkOut: addDays(today, 7), amount: 3600, deposit: 1080, status: 'pending', createdBy: admin._id },
      ]);
      console.log('Created internal bookings');
    }

    const bookingIds = await Booking.find().limit(2).then((b) => b.map((x) => x._id));

    // --- Transactions ---
    if ((await Transaction.countDocuments()) === 0) {
      const today = new Date();
      await Transaction.create([
        { type: 'income', category: 'booking', description: 'Guest payment', amount: 2400, date: today, createdBy: finance._id },
        { type: 'income', category: 'booking', description: 'Event deposit', amount: 5000, date: today, createdBy: finance._id },
        { type: 'expense', category: 'supplies', description: 'Cleaning supplies', amount: 450, date: today, createdBy: finance._id },
        { type: 'expense', category: 'utilities', description: 'Electricity', amount: 1200, date: today, createdBy: finance._id },
        { type: 'income', category: 'booking', description: 'BnB booking', amount: 1800, date: addDays(today, -5), createdBy: finance._id },
      ]);
      console.log('Created transactions');
    }

    // --- Debtors ---
    if ((await Debtor.countDocuments()) === 0) {
      await Debtor.create([
        { name: 'ABC Events', contactEmail: 'payments@abcevents.com', amountOwed: 5000, amountPaid: 2000, status: 'partial', dueDate: addDays(new Date(), 14), createdBy: finance._id },
        { name: 'Guest – Late checkout', contactPhone: '+27987654321', amountOwed: 500, amountPaid: 0, status: 'outstanding', createdBy: finance._id },
      ]);
      console.log('Created debtors');
    }

    // --- Suppliers ---
    const supplierPayloads = [
      { name: 'CleanPro Services', contactEmail: 'info@cleanpro.co.za', category: 'cleaning', bankDetails: { accountName: 'CleanPro', bank: 'FNB', accountNumber: '62xxx' }, isActive: true, createdBy: finance._id },
      { name: 'Fresh Foods Co', contactEmail: 'orders@freshfoods.co.za', category: 'food', isActive: true, createdBy: finance._id },
    ];
    const supplierIds = [];
    for (const s of supplierPayloads) {
      let sup = await Supplier.findOne({ name: s.name });
      if (!sup) {
        sup = await Supplier.create(s);
        console.log('Created supplier:', sup.name);
      }
      supplierIds.push(sup._id);
    }

    if ((await SupplierPayment.countDocuments()) === 0 && supplierIds[0]) {
      await SupplierPayment.create({
        supplier: supplierIds[0],
        amount: 1200,
        date: new Date(),
        description: 'Monthly cleaning contract',
        paymentMethod: 'EFT',
        createdBy: finance._id,
      });
      console.log('Created supplier payment');
    }

    // --- Invoices ---
    if ((await Invoice.countDocuments()) === 0) {
      const today = new Date();
      const year = today.getFullYear();
      await Invoice.create({ type: 'guest', invoiceNumber: `INV-${year}-0001`, issueDate: today, dueDate: addDays(today, 14), lineItems: [{ description: 'Garden Suite x 2 nights', qty: 2, unitPrice: 1200, total: 2400 }], subtotal: 2400, tax: 0, total: 2400, status: 'sent', createdBy: finance._id });
      await Invoice.create({ type: 'supplier', relatedTo: supplierIds[0], invoiceNumber: `INV-${year}-0002`, issueDate: today, dueDate: addDays(today, 30), lineItems: [{ description: 'Cleaning services', qty: 1, unitPrice: 1200, total: 1200 }], subtotal: 1200, tax: 0, total: 1200, status: 'draft', createdBy: finance._id });
      console.log('Created invoices');
    }

    // --- Refunds ---
    if ((await Refund.countDocuments()) === 0) {
      await Refund.create({
        guestName: 'Canceled Guest',
        guestEmail: 'cancel@example.com',
        amount: 500,
        reason: 'Booking cancelled within policy',
        status: 'pending',
        createdBy: finance._id,
      });
      console.log('Created refund');
    }

    // --- Stock ---
    const stockItems = [
      { name: 'Toilet paper', category: 'toiletries', quantity: 48, unit: 'units', reorderLevel: 12, lastRestocked: new Date() },
      { name: 'Surface cleaner', category: 'cleaning', quantity: 6, unit: 'litres', reorderLevel: 2 },
      { name: 'Coffee pods', category: 'kitchen', quantity: 120, unit: 'units', reorderLevel: 30 },
      { name: 'Hand soap', category: 'toiletries', quantity: 24, unit: 'units', reorderLevel: 6 },
    ];
    for (const s of stockItems) {
      const exists = await Stock.findOne({ name: s.name });
      if (!exists) {
        await Stock.create(s);
        console.log('Created stock:', s.name);
      }
    }

    // --- Equipment ---
    const equipmentItems = [
      { name: 'Vacuum cleaner', category: 'appliance', condition: 'good', lastServiced: new Date() },
      { name: 'Conference table', category: 'furniture', condition: 'good' },
      { name: 'Projector', category: 'appliance', serialNumber: 'PRJ-001', condition: 'fair', lastServiced: addDays(new Date(), -60) },
    ];
    for (const e of equipmentItems) {
      const exists = await Equipment.findOne({ name: e.name });
      if (!exists) {
        await Equipment.create(e);
        console.log('Created equipment:', e.name);
      }
    }

    // --- Salary ---
    if ((await Salary.countDocuments()) === 0) {
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      await Salary.create([
        { employee: employee._id, amount: 8500, month, paidOn: addDays(now, -7), notes: 'March salary' },
        { employee: employee._id, amount: 8500, month: '2026-02', paidOn: new Date('2026-02-28'), notes: 'February salary' },
      ]);
      console.log('Created salary records');
    }

    // --- Work logs ---
    if ((await WorkLog.countDocuments()) === 0) {
      await WorkLog.create([
        { employee: employee._id, workDone: 'Cleaned Garden Suite and Pool Cottage. Restocked toiletries.', period: 'daily', tasksAssigned: ['Housekeeping'], date: new Date() },
        { employee: employee._id, workDone: 'Set up Event Hall for conference. Assisted with AV equipment.', period: 'daily', tasksAssigned: ['Event setup'], date: addDays(new Date(), -1) },
      ]);
      console.log('Created work logs');
    }

    console.log('Seed all done.');
  } catch (err) {
    console.error('Seed error:', err.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

seed();
