# Valleycroft / Valleyroad backend — system functionality guide

This document describes **what the backend does**, **who can use it**, and **where to look in code**. For accounting rules and journal behaviour, see [`ACCOUNTING.md`](./ACCOUNTING.md). For frontend integration patterns, see [`FRONTEND-GUIDE.md`](./FRONTEND-GUIDE.md).

---

## 1. Purpose

The API supports a hospitality / venue operation with:

- **Rooms and availability** (public)
- **Guest bookings** from the website (public create + track; staff confirm/cancel)
- **Internal bookings** (BnB and events) for staff
- **Finance**: transactions, salaries, statements, dashboards
- **Accounting (GL)**: chart of accounts, journals, ledger, trial balance, financial statements
- **Debtors, suppliers, invoices, refunds**
- **Inventory** (stock and equipment)
- **Staff** (employees, tasks, work logs)
- **Reports** (period rollups and exports)
- **Audit trail** of sensitive actions

Base URL pattern: `/api/...`  
Health: `GET /api/health`

---

## 2. Roles

Users have one of: **`ceo`**, **`admin`**, **`finance`**, **`employee`**.

| Area | Typical access |
|------|----------------|
| Public | Rooms list/detail, guest booking create, guest booking track |
| Employee | Own work logs |
| Finance | Transactions (read/write with admin where noted), most finance statements, debtors/suppliers/invoices, accounting (with admin/ceo) |
| Admin | Bookings CRUD, guest booking updates, inventory, user registration, many finance writes |
| CEO | Broad read access aligned with finance/admin on many routes |

Exact enforcement is per-route in `src/routes/*.js` (see manifest JSON).

---

## 3. Authentication

- **Login**: `POST /api/auth/login` — body `{ email, password }` → JWT.
- **Register**: `POST /api/auth/register` — **admin only**, Bearer token required.
- **Current user**: `GET /api/auth/me` — protected.
- **Change password**: `PUT /api/auth/change-password` — protected.

Send JWT as: `Authorization: Bearer <token>`.

**Production**: set `JWT_SECRET` (and `MONGO_URI`) on the host (e.g. Render). Missing `JWT_SECRET` causes login to fail.

---

## 4. Cross-cutting concerns

### CORS

Allowed origins come from `FRONTEND_URL` (comma-separated). If unset, a default list includes local dev ports and `https://valleycroft.vercel.app`. Preflight: `OPTIONS` is handled globally in `server.js`.

### Audit logging

Many create/update/delete and some exports write to `AuditLog`. Query via `/api/audit` (role-restricted).

### Booking confirmation → revenue and invoice

When a **guest** or **internal** booking becomes **confirmed**, the system can create **debtor**, **income transaction**, **journal**, **guest invoice**, and optionally send **email / WhatsApp** if SMTP/WhatsApp env vars are set. See `src/services/bookingRevenueService.js`, `bookingInvoiceService.js`, `invoiceNotifyService.js`.

---

## 5. API by functional area

### 5.1 Rooms (`/api/rooms`)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/` | Public | List rooms; optional `checkIn` / `checkOut` for availability |
| GET | `/:id` | Public | Room detail; optional date filters |
| GET | `/:id/bookings` | Public | Bookings for a room (optional date range) |
| POST | `/` | Admin | Create room |
| PUT | `/:id` | Admin | Update room |
| DELETE | `/:id` | Admin | Delete room |

### 5.2 Guest bookings (`/api/guest-bookings`)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/` | Public | Submit guest booking |
| GET | `/track` | Public | Track by `email` + `trackingCode` query |
| GET | `/` | Admin, CEO, Finance | List guest bookings |
| PUT | `/:id` | Admin | Update (e.g. confirm/cancel) — triggers revenue/invoice rules when confirming |

### 5.3 Internal bookings (`/api/bookings`)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/` | Admin, CEO, Finance | List |
| GET | `/availability` | Admin, CEO, Finance | Overlap / availability |
| GET | `/:id` | Admin, CEO, Finance | One booking |
| POST | `/` | Admin | Create |
| PUT | `/:id` | Admin | Update (confirm/cancel drives revenue) |
| DELETE | `/:id` | Admin | Delete |

### 5.4 Finance (`/api/finance`)

All routes require authentication.

| Method | Path | Roles (typical) | Purpose |
|--------|------|-----------------|--------|
| GET | `/dashboard` | Finance, Admin, CEO | Aggregated KPIs, control centre, operations snapshot, charts keys — query `month=YYYY-MM`, `revenueMonths=6\|12` |
| GET | `/transactions` | Finance, Admin, CEO | List transactions |
| GET | `/transactions-ledger-format` | Finance, Admin, CEO | Ledger-shaped view |
| POST/PUT/DELETE | `/transactions`, `/transactions/:id` | Finance, Admin | CRUD |
| GET | `/cashflow`, `/cash-flow` | Finance, Admin, CEO | Cash flow (transaction basis) |
| GET | `/income-statement`, `/balance-sheet`, `/pl` | Finance, CEO | Statements |
| GET/POST | `/salary`, `/salary/employee/:id` | Mixed | Salary listing and create |

### 5.5 Statements (`/api/statements`)

Transaction-basis statements, general ledger lines, ledger-basis reports, and **`GET /catalog`** (URL discovery). Role rules mirror finance routes where applicable; ledger listing allows Finance, Admin, CEO.

### 5.6 Accounting / GL (`/api/accounting`)

Router-level: **Finance, Admin, CEO**.

Includes: chart of accounts (list/create/update/next-code), **post journal**, **void journal**, ledger, trial balance, income statement, balance sheet, cash flow, retained earnings, bundled financial-statements. See [`ACCOUNTING.md`](./ACCOUNTING.md) for concepts.

### 5.7 Debtors (`/api/debtors`)

| Method | Path | Roles |
|--------|------|-------|
| GET | `/` | Finance, Admin, CEO |
| POST/PUT/DELETE | `/`, `/:id`, `/:id` | Finance, Admin |

### 5.8 Suppliers & payments (`/api/suppliers`)

| Method | Path | Roles |
|--------|------|-------|
| GET | `/` | Finance, Admin, CEO |
| POST | `/` | Finance, Admin |
| PUT | `/:id` | Finance, Admin |
| POST | `/payments` | Finance, Admin |
| GET | `/:id/payments` | Finance, Admin, CEO |

### 5.9 Invoices (`/api/invoices`)

| Method | Path | Roles |
|--------|------|-------|
| GET | `/` | Finance, Admin, CEO |
| POST | `/` | Finance, Admin |
| PUT | `/:id` | Finance, Admin |
| GET | `/:id/pdf` | Finance, Admin, CEO (currently returns JSON payload, not binary PDF) |

### 5.10 Refunds (`/api/refunds`)

| Method | Path | Roles |
|--------|------|-------|
| GET | `/` | Finance, Admin, CEO |
| POST | `/` | Finance, Admin |
| PUT | `/:id` | Finance, Admin |

### 5.11 Inventory (`/api/inventory`)

Stock and equipment: list/create/update/delete (mostly **admin**; read sometimes **admin, CEO**). See `inventoryRoutes.js`.

### 5.12 Staff (`/api/staff`)

Employees (admin/ceo), tasks (admin assign; employees read own), work logs (admin/ceo all; employee own).

### 5.13 Reports (`/api/reports`)

Weekly / monthly / quarterly / annual and export — **admin, finance, CEO**.

### 5.14 Audit (`/api/audit`)

List, by entity, by user — **admin, CEO, finance** (user filter CEO-only for `/user/:id`).

---

## 6. Finance dashboard response (high level)

`GET /api/finance/dashboard` returns a single payload useful for UI tiles:

- **`data.controlCentre`** — finance headline, tiles, quick links, section keys
- **`data.kpis`** — flat numbers for simple widgets
- **`data.operationsDashboard`** — check-ins/outs today, occupancy, stock alerts, movements
- **`data.revenueReceiptsMonthly`**, **`data.ledgerSnapshot`**, **`data.debtors`**, **`data.paymentQueue`**, **`data.activityToday`**, **`data.deadlines`**, etc.

Use `data.controlCentre.sectionKeys` to locate sibling sections without duplicating data.

---

## 7. Environment variables (summary)

| Variable | Role |
|----------|------|
| `MONGO_URI` | MongoDB connection (required) |
| `JWT_SECRET` | Sign JWTs (required in production) |
| `FRONTEND_URL` | CORS allowlist (comma-separated) |
| `PORT` | Server port |
| SMTP / WhatsApp | Optional invoice delivery after booking confirm — see `.env.example` |

---

## 8. Related files in this repo

| File | Content |
|------|---------|
| `server.js` | App bootstrap, CORS, routes mount |
| `src/routes/*.js` | Endpoint map and RBAC |
| [`ACCOUNTING.md`](./ACCOUNTING.md) | Ledger, journals, statements |
| [`FRONTEND-GUIDE.md`](./FRONTEND-GUIDE.md) | Client usage notes |
| [`system-functionality.manifest.json`](./system-functionality.manifest.json) | Machine-readable endpoint index |

---

## 9. Maintaining this guide

When you add or change routes:

1. Update the route file and this **SYSTEM-FUNCTIONALITY.md** section for that area.
2. Update **`system-functionality.manifest.json`** so tools and new developers stay in sync.
