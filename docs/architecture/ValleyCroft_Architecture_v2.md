# Valley Croft Farm Management System — Technical Architecture & Developer Guide

**Version:** 2.0 | **March 2026**  
**Prepared by:** Chynae Digital Solutions  
**Confidential**

**Stack:** React.js · Node.js + Express · MongoDB Atlas · Amazon S3  
**Deployed:** Vercel (frontend) · Render (backend) · valleycroft.com

> Converted from `ValleyCroft_Architecture_v2.pdf` for easier editing in-repo.

**Implementation note (this backend repo):** Entry point is `server.js` at the project root (`npm start` / `node server.js`). The PDF below references `node src/server.js` — adjust for your deployment start command if it differs.

---

## 1. Project overview

Valley Croft Farm Management System is a full-stack web application serving two distinct audiences: the general public booking accommodation and events, and internal staff managing day-to-day operations. The system is split into **two separate repositories** deployed independently.

> Two separate repos: **valleycroft-frontend** and **valleycroft-backend**. Do not mix them.

### 1.1 System audiences

| Audience | Description |
|----------|-------------|
| **Public / Guests** | Anyone visiting valleycroft.com — can view rooms, make bookings, track booking status without logging in. |
| **Internal staff** | Admin, Finance, CEO, and Employees — access role-specific dashboards via JWT-authenticated login. |

### 1.2 Internal roles

| Role | Responsibilities |
|------|------------------|
| **admin** | Manages bookings, staff, tasks, inventory, room listings, guest booking confirmations. Full system access. |
| **finance** | Manages financial operations: transactions, salaries, supplier payments, debtors, invoices, refunds, financial statements, audit trail. |
| **ceo** | Read-only access to bookings, financial statements (cashflow, balance sheet, income statement, P&L), staff, debtors, suppliers, reports, audit trail. |
| **employee** | Views assigned tasks, submits daily/weekly work logs with photo uploads, views own logs and payslips. |

### 1.3 Repository structure

**Frontend — valleycroft-frontend/**

```
valleycroft-frontend/
├── public/
├── src/
│   ├── api/              ← all axios API call functions
│   ├── components/       ← reusable UI components
│   ├── pages/
│   │   ├── public/       ← landing, rooms, booking, tracking
│   │   ├── admin/
│   │   ├── ceo/
│   │   ├── finance/
│   │   └── employee/
│   ├── context/          ← AuthContext
│   ├── hooks/            ← custom React hooks
│   ├── utils/            ← helpers
│   ├── App.jsx
│   └── main.jsx
├── .env
└── package.json
```

**Backend — valleycroft-backend/**

```
valleycroft-backend/
├── src/
│   ├── config/           ← db.js (MongoDB connection)
│   ├── controllers/      ← one file per module
│   ├── models/           ← Mongoose schemas
│   ├── routes/           ← Express route files
│   ├── middleware/       ← auth.js, upload.js (S3)
│   └── utils/            ← audit.js, helpers
├── server.js             ← entry point (this repo)
├── .env
└── package.json
```

### 1.4 Environment variables

> Never commit `.env` files to GitHub. Add `.env` to `.gitignore` before your first commit.

**Backend `.env`**

| Variable | Example / notes |
|----------|-----------------|
| `PORT` | `5000` |
| `MONGO_URI` | `mongodb+srv://<user>:<pass>@cluster.mongodb.net/valleycroft` |
| `JWT_SECRET` | Long random secret |
| `JWT_EXPIRES_IN` | `7d` |
| `AWS_ACCESS_KEY_ID` | AWS key |
| `AWS_SECRET_ACCESS_KEY` | AWS secret |
| `AWS_REGION` | e.g. `af-south-1` |
| `AWS_S3_BUCKET` | e.g. `valleycroft-uploads` |
| `FRONTEND_URL` | e.g. `https://valleycroft.com` |

**Frontend `.env`**

| Variable | Example |
|----------|---------|
| `VITE_API_URL` | `https://your-backend.onrender.com/api` |

---

## 2. Public landing page

The public landing page is accessible without authentication. Guests browse rooms, make bookings, and track status with a unique tracking code.

### 2.1 Public pages

| Route | Purpose |
|-------|---------|
| `/` | Home — hero, highlights, featured rooms, CTA |
| `/rooms` | All rooms — photos (S3), price, amenities, Book Now |
| `/rooms/:id` | Room detail — gallery, date picker, booking form |
| `/track-booking` | Guest enters email + tracking code for status |

### 2.2 Guest booking flow

1. Guest selects room and dates on `/rooms/:id`.
2. Frontend sends `POST /api/guest-bookings` — returns `trackingCode`.
3. Confirmation page shows `trackingCode` — guest should save it.
4. Admin sees pending booking and confirms or cancels.
5. Guest checks status at `/track-booking` with email + `trackingCode`.

> Room images load directly from S3 URLs — backend does not serve image bytes. Use `loading="lazy"` on room photos.

### 2.3 Public API routes — `/api/rooms` and `/api/guest-bookings`

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| GET | `/api/rooms` | Public | List rooms |
| GET | `/api/rooms/:id` | Public | Room detail |
| POST | `/api/guest-bookings` | Public | Submit guest booking |
| GET | `/api/guest-bookings/track` | Public | Track by email + trackingCode |
| POST | `/api/rooms` | Admin | Add room |
| PUT | `/api/rooms/:id` | Admin | Update room |
| DELETE | `/api/rooms/:id` | Admin | Remove room |
| GET | `/api/guest-bookings` | Admin, CEO, Finance | List guest requests (PDF: Admin, CEO; backend may also allow finance) |
| PUT | `/api/guest-bookings/:id` | Admin | Confirm / cancel / update |

---

## 3. MongoDB models (Mongoose schemas)

Define schemas before routes. Use consistent field names. All models use `timestamps: true` where applicable.

### 3.1 User

| Field | Type | Notes |
|-------|------|-------|
| name | String, required | Full name |
| email | String, required, unique | Login |
| password | String, required | bcrypt — never plain text |
| role | enum: `ceo` \| `admin` \| `finance` \| `employee` | RBAC |
| phone | String | Optional |
| idNumber | String | Optional national ID |
| dateJoined | Date, default now | |
| dateLeft | Date | null = still employed |
| isActive | Boolean, default true | |

### 3.2 Room

| Field | Type | Notes |
|-------|------|-------|
| name | String, required | e.g. Garden Suite, Event Hall |
| description | String | Public copy |
| type | enum: `bnb` \| `event-space` | |
| capacity | Number | Max guests |
| pricePerNight | Number | |
| amenities | [String] | e.g. WiFi, Pool |
| images | [String] | S3 URLs |
| isAvailable | Boolean, default true | Hide from public |
| order | Number | Display order |

### 3.3 GuestBooking (public bookings)

| Field | Type | Notes |
|-------|------|-------|
| guestName | String, required | |
| guestEmail | String, required | Lookup |
| guestPhone | String | |
| roomId | ObjectId, ref Room | |
| checkIn | Date | |
| checkOut | Date | |
| totalAmount | Number | Calculated on submit |
| deposit | Number | |
| status | enum: `pending` \| `confirmed` \| `cancelled` | Admin updates |
| trackingCode | String, unique | Guest lookup |
| source | String, default `website` | |
| notes | String | Admin |

### 3.4 Booking (internal staff)

| Field | Type | Notes |
|-------|------|-------|
| guestName | String, required | |
| guestEmail | String | |
| guestPhone | String | |
| type | enum: `bnb` \| `event` | |
| checkIn | Date | |
| checkOut | Date | |
| eventDate | Date | Events |
| amount | Number | |
| deposit | Number | |
| status | enum: `pending` \| `confirmed` \| `checked-in` \| `checked-out` \| `cancelled` | |
| notes | String | |
| createdBy | ObjectId, ref User | |

### 3.5 Transaction

| Field | Type | Notes |
|-------|------|-------|
| type | enum: `income` \| `expense` | |
| category | String | booking, salary, supplies, utilities, refund, supplier, … |
| description | String | |
| amount | Number, required | |
| date | Date, default now | |
| reference | String | |
| booking | ObjectId, ref Booking | Optional |
| createdBy | ObjectId, ref User | |

### 3.6 Salary and WorkLog

**Salary**

| Field | Type | Notes |
|-------|------|-------|
| employee | ObjectId, ref User, required | |
| amount | Number | |
| month | String | e.g. `2026-03` |
| paidOn | Date | |
| notes | String | |

**WorkLog**

| Field | Type | Notes |
|-------|------|-------|
| employee | ObjectId, ref User | |
| date | Date, default now | |
| period | enum: `daily` \| `weekly` | |
| tasksAssigned | [String] | Admin |
| workDone | String, required | Employee |
| photos | [String] | S3 URLs |

### 3.7 Stock and Equipment

**Stock**

| Field | Type | Notes |
|-------|------|-------|
| name | String, required | |
| category | String | toiletries, cleaning, kitchen |
| quantity | Number, default 0 | |
| unit | String | units, litres, kg |
| reorderLevel | Number | Alert threshold |
| lastRestocked | Date | |

**Equipment**

| Field | Type | Notes |
|-------|------|-------|
| name | String, required | |
| category | String | appliance, furniture, machinery |
| serialNumber | String | |
| condition | enum: `good` \| `fair` \| `needs repair` \| `out of service` | |
| purchaseDate | Date | |
| lastServiced | Date | |
| notes | String | |

### 3.8 Finance models

**Debtor**

| Field | Type | Notes |
|-------|------|-------|
| name | String, required | |
| contactEmail | String | |
| contactPhone | String | |
| description | String | |
| amountOwed | Number | |
| amountPaid | Number, default 0 | |
| balance | Virtual | owed − paid |
| dueDate | Date | |
| status | enum: `outstanding` \| `partial` \| `paid` \| `written-off` | |
| bookingRef | ObjectId, ref Booking | Optional |
| invoiceRef | ObjectId, ref Invoice | Optional |
| notes | String | |
| createdBy | ObjectId, ref User | |

**Supplier**

| Field | Type | Notes |
|-------|------|-------|
| name | String, required | |
| contactEmail | String | |
| contactPhone | String | |
| category | String | cleaning, food, maintenance, other |
| bankDetails | Object | accountName, bank, accountNumber |
| isActive | Boolean | |
| notes | String | |
| createdBy | ObjectId, ref User | |

**SupplierPayment**

| Field | Type | Notes |
|-------|------|-------|
| supplier | ObjectId, ref Supplier, required | |
| amount | Number | |
| date | Date | |
| description | String | |
| invoiceNumber | String | |
| paymentMethod | enum: `cash` \| `EFT` \| `card` | |
| attachmentUrl | String | S3 |
| createdBy | ObjectId, ref User | |

**Invoice**

| Field | Type | Notes |
|-------|------|-------|
| type | enum: `guest` \| `supplier` | |
| relatedTo | ObjectId | Booking or Supplier |
| invoiceNumber | String, auto | e.g. INV-2026-0001 |
| issueDate | Date | |
| dueDate | Date | |
| lineItems | [{ description, qty, unitPrice, total }] | |
| subtotal | Number | |
| tax | Number | |
| total | Number | |
| status | enum: `draft` \| `sent` \| `paid` \| `void` | |
| notes | String | |
| createdBy | ObjectId, ref User | |

**Refund**

| Field | Type | Notes |
|-------|------|-------|
| guestName | String | |
| guestEmail | String | |
| bookingRef | ObjectId | Booking or GuestBooking |
| amount | Number | |
| reason | String | |
| status | enum: `pending` \| `approved` \| `processed` \| `rejected` | |
| processedBy | ObjectId, ref User | |
| processedOn | Date | |
| notes | String | |
| createdBy | ObjectId, ref User | |

### 3.9 AuditLog

| Field | Type | Notes |
|-------|------|-------|
| userId | ObjectId, ref User, required | Actor |
| role | String | At time of action |
| action | enum: `create` \| `update` \| `delete` \| `login` \| `logout` \| `export` | |
| entity | String | e.g. Booking, Transaction |
| entityId | ObjectId | |
| before | Mixed | Snapshot |
| after | Mixed | Snapshot |
| ip | String | |
| userAgent | String | |
| timestamp | Date, default now | Index |

> AuditLog is append-only — do not delete or update documents. Remove PUT/DELETE on `/api/audit` if ever added.

**Suggested indexes**

```js
BookingSchema.index({ checkIn: 1, checkOut: 1 });
BookingSchema.index({ status: 1 });
TransactionSchema.index({ date: -1 });
TransactionSchema.index({ type: 1, date: -1 });
WorkLogSchema.index({ employee: 1, date: -1 });
AuditLogSchema.index({ userId: 1, timestamp: -1 });
AuditLogSchema.index({ entity: 1, timestamp: -1 });
DebtorSchema.index({ status: 1 });
GuestBookingSchema.index({ trackingCode: 1 });
GuestBookingSchema.index({ guestEmail: 1 });
```

---

## 4. Backend setup (Node.js + Express)

### 4.1 Install packages

```bash
npm install express mongoose dotenv cors bcryptjs jsonwebtoken compression helmet
npm install multer @aws-sdk/client-s3 multer-s3
npm install --save-dev nodemon
```

### 4.2 `server.js` entry point (conceptual)

- `helmet()`, `compression()`, CORS (restrict to `FRONTEND_URL` in production).
- Mount public routes: `/api/rooms`, `/api/guest-bookings`.
- Mount protected routes: auth, bookings, finance, staff, inventory, reports, debtors, suppliers, invoices, refunds, audit.
- `GET /api/health` for uptime monitors.

> Add uptime monitor (e.g. UptimeRobot) pinging `/api/health` every ~10 minutes to reduce Render cold starts.

### 4.3 Authentication middleware

JWT from `Authorization: Bearer <token>`. `protect` verifies; `authorize(...roles)` restricts by role.

### 4.4 Audit utility

Call `logAudit` on create/update/delete, login/logout, and exports.

### 4.5 Performance rules

- Use `.lean()` on read queries where appropriate.
- Use `.select()` to limit fields; never return passwords.
- Paginate lists: `?page=1&limit=20`.
- Prefer MongoDB aggregation for financial reports.
- Use `compression` middleware.
- Standard shape: `{ success, data, message?, meta? }`.

---

## 5. API routes — module by module

Convention: prefix `/api/`. `protect` on non-public routes; `authorize` for roles.

### 5.1 Auth — `/api/auth`

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| POST | `/login` | Public | JWT |
| POST | `/register` | Admin | Create user |
| GET | `/me` | Logged in | Current user |
| PUT | `/change-password` | Logged in | Change password |

### 5.2 Internal bookings — `/api/bookings`

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| GET | `/` | Admin, CEO | List (PDF); backend may also allow finance read) |
| GET | `/availability` | Admin, CEO | Availability |
| GET | `/:id` | Admin, CEO | One booking |
| POST | `/` | Admin | Create |
| PUT | `/:id` | Admin | Update |
| DELETE | `/:id` | Admin | Delete |

### 5.3 Finance — `/api/finance`

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| GET | `/transactions` | Finance, Admin, CEO | List |
| POST | `/transactions` | Finance, Admin | Create |
| PUT | `/transactions/:id` | Finance, Admin | Update |
| DELETE | `/transactions/:id` | Finance, Admin | Delete |
| GET | `/cashflow` | Finance, Admin, CEO | Cash flow |
| GET | `/income-statement` | Finance, CEO | Income statement |
| GET | `/balance-sheet` | Finance, CEO | Balance sheet |
| GET | `/pl` | Finance, CEO | P&L |
| GET | `/salary` | Finance, Admin, CEO | Salaries |
| POST | `/salary` | Finance, Admin | Record salary |
| GET | `/salary/employee/:id` | Finance, Admin | Per employee |

> This repo also exposes `/api/finance/dashboard`, `/api/statements/*`, and `/api/accounting/*` for GL and consolidated reporting — see [`../guides/SYSTEM-FUNCTIONALITY.md`](../guides/SYSTEM-FUNCTIONALITY.md).

### 5.4 Debtors — `/api/debtors`

| Method | Endpoint | Access |
|--------|----------|--------|
| GET | `/` | Finance, Admin, CEO |
| POST | `/` | Finance, Admin |
| PUT | `/:id` | Finance, Admin |
| DELETE | `/:id` | Finance, Admin |

### 5.5 Suppliers — `/api/suppliers`

| Method | Endpoint | Access |
|--------|----------|--------|
| GET | `/` | Finance, Admin, CEO |
| POST | `/` | Finance, Admin |
| PUT | `/:id` | Finance, Admin |
| GET | `/:id/payments` | Finance, Admin, CEO |
| POST | `/payments` | Finance, Admin |

### 5.6 Invoices — `/api/invoices`

| Method | Endpoint | Access |
|--------|----------|--------|
| GET | `/` | Finance, Admin, CEO |
| POST | `/` | Finance, Admin |
| PUT | `/:id` | Finance, Admin |
| GET | `/:id/pdf` | Finance, Admin, CEO |

### 5.7 Refunds — `/api/refunds`

| Method | Endpoint | Access |
|--------|----------|--------|
| GET | `/` | Finance, Admin, CEO |
| POST | `/` | Finance, Admin |
| PUT | `/:id` | Finance, Admin |

### 5.8 Staff — `/api/staff`

| Method | Endpoint | Access |
|--------|----------|--------|
| GET | `/employees` | Admin, CEO |
| PUT | `/employees/:id` | Admin |
| POST | `/tasks` | Admin |
| GET | `/tasks/:employeeId` | Admin, CEO, Employee |
| GET | `/worklogs` | Admin, CEO |
| GET | `/worklogs/me` | Employee |
| POST | `/worklogs` | Employee |

> Employees must only fetch their own tasks — enforce with `req.user._id`, not URL alone.

### 5.9 Inventory — `/api/inventory`

| Method | Endpoint | Access |
|--------|----------|--------|
| GET | `/stock` | Admin, CEO |
| POST | `/stock` | Admin |
| PUT | `/stock/:id` | Admin |
| DELETE | `/stock/:id` | Admin |
| GET | `/equipment` | Admin, CEO |
| POST | `/equipment` | Admin |
| PUT | `/equipment/:id` | Admin |

### 5.10 Reports — `/api/reports`

| Method | Endpoint | Access |
|--------|----------|--------|
| GET | `/weekly` | Admin, Finance, CEO |
| GET | `/monthly` | Admin, Finance, CEO |
| GET | `/quarterly` | Admin, Finance, CEO |
| GET | `/annual` | Admin, Finance, CEO |
| GET | `/export/:type` | Admin, Finance, CEO |

### 5.11 Audit — `/api/audit`

| Method | Endpoint | Access |
|--------|----------|--------|
| GET | `/` | Admin, CEO, Finance |
| GET | `/entity/:name` | Admin, CEO, Finance |
| GET | `/user/:id` | Admin, CEO |

> No POST/PUT/DELETE on audit — read-only.

---

## 6. Frontend setup (React + Vite)

### 6.1 Initialize and install

```bash
npm create vite@latest valleycroft-frontend -- --template react
cd valleycroft-frontend && npm install
npm install axios react-router-dom@^6.26.0 react-hook-form
npm install @tanstack/react-query date-fns recharts
npm install tailwindcss @tailwindcss/vite
```

> Prefer react-router-dom v6 for Vercel compatibility; pin `^6.26.0` if needed.

### 6.2 Routing structure (sketch)

- Public: `/`, `/rooms`, `/rooms/:id`, `/track-booking`
- Protected: `/login`, then role-gated `/ceo/*`, `/admin/*`, `/finance/*`, `/employee/*`

### 6.3 Dashboard pages by role

**Admin:** dashboard, bookings, guest-bookings, rooms, staff, salary, inventory, reports, audit.

**Finance:** dashboard, transactions, salary, suppliers, debtors, invoices, refunds, cashflow, income-statement, balance-sheet, pl, audit.

**CEO:** read-only variants of bookings, finance summaries, statements, debtors, suppliers, staff, reports, audit.

**Employee:** dashboard, log-work, my-logs, payslips.

### 6.4 Axios instance

Base URL from `import.meta.env.VITE_API_URL`; attach `Authorization: Bearer <token>` from storage.

### 6.5 React Query

Wrap app with `QueryClientProvider`; use sensible `staleTime` (e.g. 5 minutes) and limited retries.

---

## 7. Performance — faster system

### 7.1 Frontend

- Code-split dashboards with `React.lazy` + `Suspense`.
- Optimistic updates where safe.
- Paginated queries; `keepPreviousData` for smooth paging.

### 7.2 Backend

- `.lean()` for plain objects on reads.
- `.select()` for smaller payloads.
- Aggregation for financial rollups.

### 7.3 Infrastructure

- Serve room/work-log images from S3 URLs in the browser, not via the API.

---

## 8. Recommended build order

Build in order: foundation → auth → rooms → public guest flow → frontend shell → admin guest bookings → internal bookings → finance modules → audit → staff → inventory → reports → CEO read-only → deploy.

(See original PDF table for full step-by-step checklist.)

---

## 9. Deployment guide

### 9.1 Backend (Render)

- Connect GitHub repo, build `npm install`, start **`node server.js`** (verify against your repo).
- Set all env vars in Render.
- Use uptime ping on `/api/health`.

### 9.2 Frontend (Vercel)

- Vite preset; `npm run build`; output `dist`.
- `VITE_API_URL` = backend URL including `/api` if that is your convention.

### 9.3 Domain

- Add domain in Vercel; configure DNS; SSL automatic.

### 9.4 MongoDB Atlas

- Create cluster, user, allow Render IPs (often `0.0.0.0/0` for serverless hosts — follow your security policy).

---

## 10. Best practices and key rules

**Security:** bcrypt passwords, JWT expiry, validate inputs server-side, restrict CORS, `helmet`, never leak secrets, never return password field.

**Finance and audit:** `logAudit` on writes; append-only audit; aggregations for statements; invoice immutability rules per policy; refunds tied to transactions when processed.

**Workflow:** API first, test in Postman, then frontend; module branches; mobile testing.

**Performance:** lean/select/pagination/indexes; React Query caching; lazy images from S3; lazy route chunks.

> Golden rule from PDF: build and test backend API first, then matching frontend — avoid building both sides of the same module in parallel.

---

*End of document (converted from PDF v2.0, 28 pages).*
