# Frontend API Guide — Valleyroad Backend

Use this guide to wire your frontend to the backend. Every module and endpoint is listed with access, request shape, and examples.

---

## 1. Setup

### Base URL

- **Development:** `http://localhost:5000`
- **Production:** Set `VITE_API_URL` (or your env) to your deployed API URL.

```javascript
// e.g. src/config.js or .env
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000';
```

### Auth token

After login, store the JWT (e.g. in memory, localStorage, or a cookie) and send it on every protected request.

```javascript
// Example: store token after login
let authToken = null;
export function setToken(token) {
  authToken = token;
}
export function getToken() {
  return authToken;
}
```

### API client (recommended)

Use a small helper so all requests use the same base URL and auth:

```javascript
// src/api/client.js
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000';

export async function api(path, options = {}) {
  const url = `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };
  const token = getToken(); // or from your auth store
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(url, { ...options, headers });
  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(body.message || res.statusText || 'Request failed');
  }
  return body;
}
```

### Response shape

- **Success:** `{ success: true, data: ... }`
- **List with pagination:** `{ success: true, data: [...], meta: { page, limit, total } }`
- **Error:** `{ success: false, message: "..." }` with HTTP 4xx/5xx

---

## 2. Auth — `/api/auth`

| Method | Endpoint            | Access   | Description        |
|--------|---------------------|----------|--------------------|
| POST   | `/api/auth/login`   | Public   | Login, get JWT     |
| POST   | `/api/auth/register`| Admin    | Create new user    |
| GET    | `/api/auth/me`      | Logged in| Current user       |
| PUT    | `/api/auth/change-password` | Logged in | Change own password |

### POST `/api/auth/login` (Public)

**Body:** `{ email: string, password: string }`

**Response:** `{ success: true, data: { token: string, user: { _id, name, email, role } } }`

```javascript
const { data } = await api('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email: 'admin@valleyroad.com', password: 'admin123456' }),
});
setToken(data.token);
// data.user: { _id, name, email, role }
```

### POST `/api/auth/register` (Admin)

**Body:** `{ name, email, password, role: 'ceo'|'admin'|'finance'|'employee', phone?, idNumber? }`

**Response:** `{ success: true, data: { _id, name, email, role } }`

### GET `/api/auth/me` (Logged in)

**Response:** `{ success: true, data: { _id, name, email, role, phone, idNumber, dateJoined, dateLeft, isActive } }`

### PUT `/api/auth/change-password` (Logged in)

**Body:** `{ currentPassword: string, newPassword: string }`

**Response:** `{ success: true, message: 'Password updated' }`

---

## 3. Rooms — `/api/rooms`

| Method | Endpoint          | Access | Description           |
|--------|-------------------|--------|-----------------------|
| GET    | `/api/rooms`      | Public | List available rooms  |
| GET    | `/api/rooms/:id`  | Public | Single room detail   |
| POST   | `/api/rooms`      | Admin  | Add room              |
| PUT    | `/api/rooms/:id`   | Admin  | Update room           |
| DELETE | `/api/rooms/:id`   | Admin  | Remove room           |

### GET `/api/rooms` (Public, no auth)

Returns rooms where `isAvailable === true`, sorted by `order`.

**Response:** `{ success: true, data: [{ _id, name, description, type, capacity, pricePerNight, amenities, images, order }, ...] }`

### GET `/api/rooms/:id` (Public)

**Response:** `{ success: true, data: { _id, name, description, type, capacity, pricePerNight, amenities, images } }`

### POST `/api/rooms` (Admin)

**Body:** `{ name, description?, type: 'bnb'|'event-space', capacity?, pricePerNight?, amenities?: string[], images?: string[], isAvailable?: boolean, order? }`

**Response:** `{ success: true, data: <room> }`

### PUT `/api/rooms/:id` (Admin)

**Body:** Same fields as POST (partial update).

### DELETE `/api/rooms/:id` (Admin)

**Response:** `{ success: true, message: 'Room removed' }`

---

## 4. Guest bookings (public website) — `/api/guest-bookings`

| Method | Endpoint                         | Access     | Description                    |
|--------|----------------------------------|------------|--------------------------------|
| GET    | `/api/guest-bookings/food-add-ons` | Public   | Food add-on rates (ZAR)        |
| GET    | `/api/guest-bookings/quote`      | Public     | Preview room + food total      |
| POST   | `/api/guest-bookings`            | Public     | Submit booking request         |
| GET    | `/api/guest-bookings/track`      | Public     | Track by email + code          |
| GET    | `/api/guest-bookings`            | Admin, CEO | List all guest bookings        |
| PUT    | `/api/guest-bookings/:id`        | Admin      | Update status/notes            |

### Food add-ons (ZAR)

Rates are **admin-configurable** (see **§4c**). Defaults:

| Add-on | Default rate |
|--------|----------------|
| **Breakfast** | R 100 per person per morning |
| **Picnic setup + hamper** | R 800 per person (one-time) |

Breakfast is priced per **morning** (= number of nights). Example: 2 guests, 3 nights at R 100 → R 100 × 2 × 3 = **R 600**.

### GET `/api/guest-bookings/food-add-ons` (Public)

Alias of **`GET /api/food-add-ons`**. Returns active add-ons only.

**Response:** `{ success: true, data: [{ id, label, rateLabel, unitPrice, billing, currency }] }`

### GET `/api/guest-bookings/quote` (Public)

**Query:** `roomId`, `checkIn`, `checkOut`, `guestCount?`, `foodAddOns?`

`foodAddOns` accepts `breakfast`, `picnic`, comma-separated (`breakfast,picnic`), repeated query params, or `breakfast=true`.

**Response:** `{ success: true, data: { roomName, nights, guestCount, roomTotal, foodTotal, lineItems, totalAmount, deposit, ... } }`

### POST `/api/guest-bookings` (Public, no auth)

**Body:** `{ guestName, guestEmail, guestPhone?, roomId, checkIn, checkOut, guestCount?, foodAddOns?, notes?, source? }`

`foodAddOns`: `{ breakfast?: boolean, picnic?: boolean }` or `["breakfast", "picnic"]`. When any add-on is selected, **`guestCount`** (min 1, max room capacity) is required unless **`foodAmount`** is sent (guests inferred). Optional **`roomAmount`** + **`foodAmount`**: when both are sent, the API stores **`totalAmount = roomAmount + foodAmount`** (e.g. 1500 + 200 = **1700**).

**Response:** `{ success: true, data: { _id, trackingCode, roomAmount, foodAmount, totalAmount, guestCount, foodAddOns, pricingBreakdown, deposit, status, roomName, roomType, ... } }`  
Show `trackingCode` to the guest for tracking; use **`roomName`** in confirmation UI. **`pricingBreakdown.lineItems`** has room + food lines for the review step.

### GET `/api/guest-bookings/track` (Public)

**Query:** `?email=...&trackingCode=...`

**Response:** `{ success: true, data: { guestName, guestEmail, checkIn, checkOut, guestCount, foodAddOns, pricingBreakdown, totalAmount, deposit, status, trackingCode, roomId: { name, type }, roomName, roomType } }`  
(`roomName` / `roomType` mirror the linked room for easy preview text.)

### GET `/api/guest-bookings` (Admin, CEO)

**Query:** `?page=1&limit=20`

**Response:** `{ success: true, data: [...], meta: { page, limit, total } }`

### PUT `/api/guest-bookings/:id` (Admin)

**Body:** `{ status?: 'pending'|'confirmed'|'cancelled', notes? }`

**Response:** `{ success: true, data: <booking> }` — when **`status`** becomes **`confirmed`**, **`debtorId`**, **`roomRevenueTransactionId`**, **`foodRevenueTransactionId`** (when food add-ons), and **`revenueTransactionId`** (room txn alias) are set. Revenue is split: room **`booking`** txn (`BOOK-{trackingCode}`) + food **`catering`** txn (`BOOK-FOOD-{trackingCode}`). One GL journal (DR 1010 total, CR 4001 room + CR 4003 food). If ledger seed is missing, confirm fails with **400** and the status is rolled back.

### POST `/api/guest-bookings/:id/post-revenue` (Admin)

Repair or post split revenue when a booking is already **confirmed** but food (or room) transactions are missing.

**Response:** `{ success: true, data: <booking>, revenue: { roomRevenueTransactionId, foodRevenueTransactionId, roomTotal, foodTotal, total } }`

---

## 4c. Food add-on pricing (admin) — `/api/food-add-ons`

| Method | Endpoint | Access | Description |
|--------|----------|--------|-------------|
| GET | `/api/food-add-ons` | Public | Active add-ons + current rates |
| GET | `/api/food-add-ons/manage` | Admin | All add-ons (incl. inactive) + timestamps |
| PUT | `/api/food-add-ons/:addOnId` | Admin | Update label, price, or visibility |

Same routes under **`/api/admin/food-add-ons`**.

**`:addOnId`:** `breakfast` or `picnic`

### PUT `/api/food-add-ons/:addOnId` (Admin)

**Body:** `{ label?: string, unitPrice?: number, isActive?: boolean }`

**Example — breakfast to R 120:**
```json
{ "unitPrice": 120 }
```

**Response:** `{ success: true, data: { id, label, unitPrice, rateLabel, billing, isActive } }`

Price changes apply to **new quotes and bookings** only; confirmed bookings keep their stored amounts.

---

| Method | Endpoint                      | Access     | Description              |
|--------|-------------------------------|------------|--------------------------|
| GET    | `/api/enquiries/food-add-ons` | Public     | Same food rates catalogue |
| GET    | `/api/enquiries/food-quote`   | Public     | Estimate food total      |
| POST   | `/api/enquiries`              | Public     | Submit event enquiry     |
| GET    | `/api/enquiries`              | Admin+     | List enquiries           |

### GET `/api/enquiries/food-quote` (Public)

**Query:** `guestCount`, `foodAddOns` (e.g. `picnic` or `breakfast,picnic`)

**Response:** `{ success: true, data: { guestCount, foodAddOns, lineItems, foodTotal, currency: 'ZAR' } }`

Picnic for 10 guests: **R 8,000** (R 800 × 10).

### POST `/api/enquiries` (Public)

**Body:** `{ guestName, guestEmail, guestPhone?, eventTitle?, eventType?, eventDate?, venue?, guestCount?, foodAddOns?, subject?, message }`

When `foodAddOns` includes picnic/breakfast, **`guestCount`** is required. Selected add-ons and estimated food total are stored on the enquiry and appended to **`message`** for admin review.

**Response:** `{ success: true, data: { ...enquiry, foodLineItems? } }`

---

## 5. Internal bookings — `/api/bookings`

| Method | Endpoint                 | Access     | Description           |
|--------|--------------------------|------------|-----------------------|
| GET    | `/api/bookings`          | Admin, CEO | List internal bookings|
| GET    | `/api/bookings/availability` | Admin, CEO | Check availability   |
| GET    | `/api/bookings/:id`      | Admin, CEO | Single booking        |
| POST   | `/api/bookings`          | Admin      | Create booking        |
| PUT    | `/api/bookings/:id`      | Admin      | Update booking        |
| DELETE | `/api/bookings/:id`      | Admin      | Cancel/delete         |

### GET `/api/bookings`

**Query:** `?page=1&limit=20`

**Response:** `{ success: true, data: [...], meta: { page, limit, total } }`

### GET `/api/bookings/availability`

**Query:** `?checkIn=...&checkOut=...&type=bnb|event`

**Response:** `{ success: true, data: [ overlapping bookings ] }`

### GET `/api/bookings/:id`

**Response:** `{ success: true, data: <booking> }`

### POST `/api/bookings`

**Body:** `{ guestName, guestEmail?, guestPhone?, type: 'bnb'|'event', roomId?, checkIn?, checkOut?, eventDate?, amount?, deposit?, status?, notes? }`  
For BnB rows, set **`roomId`** (Room `_id`) so list/detail responses include **`roomName`** / **`roomType`** for previews.

**Response:** `{ success: true, data: <booking> }`

### PUT `/api/bookings/:id`

**Body:** Same fields as POST (partial). Moving to **`confirmed`** (from another status) records **debtor + income transaction + journal** like guest bookings; **`confirmed` → `cancelled`** reverses them.

### DELETE `/api/bookings/:id`

**Response:** `{ success: true, message: 'Booking removed' }`

---

## 6. Finance — `/api/finance`

> **Transaction-based reports**  
> Figures from **`/api/finance`** statements (**income-statement**, **balance-sheet**, **pl**, **cashflow**) come from **`Transaction`** documents and related finance data (e.g. **debtors** on the balance sheet). Confirming a **guest** or **internal** booking auto-creates a **debtor**, an **income transaction**, and a matching **ledger entry** (Dr AR / Cr revenue). Compare with **`/api/accounting`** if you also post manual journals — totals can still differ for old data or timing.

| Method | Endpoint                         | Access           | Description        |
|--------|----------------------------------|------------------|--------------------|
| GET    | `/api/finance/transactions`      | Finance, Admin, CEO | List transactions |
| POST   | `/api/finance/transactions`      | Finance, Admin   | Add transaction    |
| PUT    | `/api/finance/transactions/:id`  | Finance, Admin   | Edit transaction   |
| DELETE | `/api/finance/transactions/:id`  | Finance, Admin   | Delete transaction |
| GET    | `/api/finance/cashflow`          | Finance, Admin, CEO | Cash flow        |
| GET    | `/api/finance/cash-flow`         | Finance, Admin, CEO | Same as `cashflow` |
| GET    | `/api/finance/income-statement`  | Finance, CEO     | Income statement   |
| GET    | `/api/finance/balance-sheet`     | Finance, CEO     | Balance sheet      |
| GET    | `/api/finance/pl`                | Finance, CEO     | P&L                |
| GET    | `/api/finance/salary`            | Finance, Admin, CEO | List salary payments |
| POST   | `/api/finance/salary`            | Finance, Admin   | Record salary      |
| GET    | `/api/finance/salary/employee/:id` | Finance, Admin | Salary history     |

### Transactions

**GET** `?page=1&limit=20` → `{ success: true, data: [...], meta }`

**POST** body: `{ type: 'income'|'expense', category?, description?, amount, date?, reference?, booking? }`

**PUT/DELETE** standard.

### Cashflow

**GET** `/api/finance/cashflow?start=YYYY-MM-DD&end=YYYY-MM-DD`  
**Response:** `{ success: true, data: [ { _id: 'income', total }, { _id: 'expense', total } ] }`

### Income statement / Balance sheet / P&L

**GET** `/api/finance/income-statement?start=...&end=...`  
**Response:** `{ success: true, data: { income: [...], expense: [...] } }`

**GET** `/api/finance/balance-sheet`  
**Response:** `{ success: true, data: [...] }`

**GET** `/api/finance/pl?start=...&end=...`  
**Response:** `{ success: true, data: { income, expense, profit } }`

### Salary

**GET** `/api/finance/salary?page=1&limit=20` → list with `meta`.

**POST** body: `{ employee: userId, amount, month?: 'YYYY-MM', paidOn?, notes? }`

**GET** `/api/finance/salary/employee/:id` → `{ success: true, data: [...] }`

### Ledger / accounting (compare with finance statements)

Base: **`/api/accounting`** (JWT; roles **finance**, **admin**, **ceo**). Examples: **`GET /api/accounting/income-statement?year=2026`**, **`GET /api/accounting/balance-sheet?asOfDate=2026-03-31`**, **`GET /api/accounting/cash-flow?month=2026-03`**, **`GET /api/accounting/ledger?startDate=2026-01-01&endDate=2026-03-31`**. Full list and bodies: [`ACCOUNTING.md`](./ACCOUNTING.md).

---

## 6b. Statements hub — `/api/statements`

Single place for **income statement**, **cash flow**, **balance sheet**, and **general ledger** (journal lines). All require JWT.

| Method | Path | Access | Basis |
|--------|------|--------|--------|
| GET | `/api/statements/income-statement` | Finance, CEO | **Transactions** (same as `/api/finance/income-statement`) |
| GET | `/api/statements/cash-flow` | Finance, Admin, CEO | **Transactions** |
| GET | `/api/statements/balance-sheet` | Finance, CEO | **Transactions** |
| GET | `/api/statements/pl` | Finance, CEO | **Transactions** (P&amp;L) |
| GET | `/api/statements/ledger` | Finance, Admin, CEO | **Posted journals** — entries with lines + account `code` / `name` |
| GET | `/api/statements/ledger-basis/income-statement` | Finance, Admin, CEO | **Ledger** (`year`, `month`, or `startDate`+`endDate`) |
| GET | `/api/statements/ledger-basis/cash-flow` | Finance, Admin, CEO | **Ledger** |
| GET | `/api/statements/ledger-basis/balance-sheet` | Finance, Admin, CEO | **Ledger** — query **`asOfDate`** required |
| GET | `/api/statements/catalog` | Finance, Admin, CEO | JSON index of all statement URLs (no heavy work) |

**Query params** match the underlying `/api/finance/*` or `/api/accounting/*` routes (e.g. `start`/`end` or `startDate`/`endDate` where applicable).

---

## 7. Debtors — `/api/debtors`

| Method | Endpoint             | Access           |
|--------|----------------------|------------------|
| GET    | `/api/debtors`       | Finance, Admin, CEO |
| POST   | `/api/debtors`       | Finance, Admin   |
| PUT    | `/api/debtors/:id`   | Finance, Admin   |
| DELETE | `/api/debtors/:id`   | Finance, Admin   |

**Query (GET):** `?page=1&limit=20`

**POST body:** `{ name, contactEmail?, contactPhone?, description?, amountOwed, amountPaid?, dueDate?, status?, bookingRef?, invoiceRef?, notes? }`

**PUT** partial update. Debtor has virtual `balance` (amountOwed - amountPaid) in response.

---

## 8. Suppliers — `/api/suppliers`

| Method | Endpoint                      | Access           |
|--------|-------------------------------|------------------|
| GET    | `/api/suppliers`              | Finance, Admin, CEO |
| POST   | `/api/suppliers`              | Finance, Admin   |
| PUT    | `/api/suppliers/:id`          | Finance, Admin   |
| GET    | `/api/suppliers/:id/payments` | Finance, Admin, CEO |
| POST   | `/api/suppliers/payments`     | Finance, Admin   |

**POST supplier:** `{ name, contactEmail?, contactPhone?, category?, bankDetails?: { accountName, bank, accountNumber }, isActive?, notes? }`

**POST payment:** `{ supplier: supplierId, amount, date?, description?, invoiceNumber?, paymentMethod: 'cash'|'EFT'|'card', attachmentUrl? }`

---

## 9. Invoices — `/api/invoices`

| Method | Endpoint              | Access           |
|--------|-----------------------|------------------|
| GET    | `/api/invoices`       | Finance, Admin, CEO |
| POST   | `/api/invoices`       | Finance, Admin   |
| PUT    | `/api/invoices/:id`   | Finance, Admin   |
| GET    | `/api/invoices/:id/pdf` | Finance, Admin, CEO |

**Query (GET):** `?page=1&limit=20`

**POST body:** `{ type: 'guest'|'supplier', relatedTo?, issueDate?, dueDate?, lineItems?: [{ description, qty, unitPrice, total }], subtotal?, tax?, total?, status?, notes? }`  
`invoiceNumber` is auto-generated (INV-YYYY-NNNN).

**GET** `/:id/pdf` returns JSON invoice data (frontend or separate service can generate PDF).

---

## 10. Refunds — `/api/refunds`

| Method | Endpoint             | Access           |
|--------|----------------------|------------------|
| GET    | `/api/refunds`       | Finance, Admin, CEO |
| POST   | `/api/refunds`       | Finance, Admin   |
| PUT    | `/api/refunds/:id`   | Finance, Admin   |

**POST body:** `{ guestName?, guestEmail?, bookingRef?, amount, reason?, status?, notes? }`

**PUT body:** `{ status?: 'pending'|'approved'|'processed'|'rejected', notes? }` — updating status sets `processedBy` and `processedOn`.

---

## 11. Staff — `/api/staff`

| Method | Endpoint                  | Access              |
|--------|---------------------------|---------------------|
| GET    | `/api/staff/employees`     | Admin, CEO          |
| PUT    | `/api/staff/employees/:id` | Admin               |
| POST   | `/api/staff/tasks`        | Admin               |
| GET    | `/api/staff/tasks/:employeeId` | Admin, CEO, Employee (own only) |
| GET    | `/api/staff/worklogs`     | Admin, CEO          |
| GET    | `/api/staff/worklogs/me`  | Employee            |
| POST   | `/api/staff/worklogs`     | Employee            |

### Employees

**GET** `?page=1&limit=20` → list employees (name, email, phone, idNumber, dateJoined, dateLeft).

**PUT** body: `{ dateLeft?, ...profileFields }` — update profile or set date left.

### Tasks

**POST** `/api/staff/tasks` body: `{ employeeId, tasks: string[] }` — creates a work log with `tasksAssigned`.

**GET** `/api/staff/tasks/:employeeId` — Employee may only call with their own `employeeId`.

### Work logs

**GET** `/api/staff/worklogs` — all work logs (Admin, CEO). **Query:** `?page=1&limit=20`.

**GET** `/api/staff/worklogs/me` — current user’s work logs (Employee).

**POST** `/api/staff/worklogs` body: `{ workDone, period?: 'daily'|'weekly', tasksAssigned?, photos? }` — Employee submits; `photos` can be S3 URLs if you upload first.

---

## 12. Inventory — `/api/inventory`

| Method | Endpoint                | Access      |
|--------|-------------------------|-------------|
| GET    | `/api/inventory/stock`   | Admin, CEO  |
| POST   | `/api/inventory/stock`   | Admin       |
| PUT    | `/api/inventory/stock/:id` | Admin    |
| DELETE | `/api/inventory/stock/:id` | Admin    |
| GET    | `/api/inventory/equipment` | Admin, CEO |
| POST   | `/api/inventory/equipment` | Admin    |
| PUT    | `/api/inventory/equipment/:id` | Admin  |

**Stock POST:** `{ name, category?, quantity?, unit?, reorderLevel?, lastRestocked? }`

**Stock PUT:** partial; updating quantity can set `lastRestocked`.

**Equipment POST:** `{ name, category?, serialNumber?, condition?: 'good'|'fair'|'needs repair'|'out of service', purchaseDate?, lastServiced?, notes? }`

**Equipment PUT:** partial update.

---

## 13. Reports — `/api/reports`

| Method | Endpoint                   | Access              |
|--------|----------------------------|---------------------|
| GET    | `/api/reports/weekly`      | Admin, Finance, CEO |
| GET    | `/api/reports/monthly`     | Admin, Finance, CEO |
| GET    | `/api/reports/quarterly`   | Admin, Finance, CEO |
| GET    | `/api/reports/annual`      | Admin, Finance, CEO |
| GET    | `/api/reports/export/:type`| Admin, Finance, CEO |

**Response (weekly/monthly/quarterly/annual):** `{ success: true, data: { income, expense, profit } }`

**Export:** `GET /api/reports/export/weekly|monthly|quarterly|annual` — returns same data (audit logged). Use for “Download as PDF” (generate PDF on frontend or another service).

---

## 14. Audit — `/api/audit`

Read-only. No POST/PUT/DELETE.

| Method | Endpoint                   | Access              |
|--------|----------------------------|---------------------|
| GET    | `/api/audit`               | Admin, CEO, Finance |
| GET    | `/api/audit/entity/:name`  | Admin, CEO, Finance |
| GET    | `/api/audit/user/:id`      | Admin, CEO          |

**GET** `/api/audit?userId=...&entity=...&start=...&end=...&page=1&limit=20`  
**Response:** `{ success: true, data: [...], meta }` — each item: userId, role, action, entity, entityId, before, after, ip, userAgent, timestamp.

**GET** `/api/audit/entity/Booking` — all actions for that entity type.

**GET** `/api/audit/user/:id` — all actions by that user.

---

## 15. Health check (no auth)

**GET** `/api/health` → `{ status: 'ok', timestamp: '...' }`  
Use for uptime checks or “API is up” in the UI.

---

## 16. Role summary

| Role     | Typical access |
|----------|----------------|
| CEO      | Read most; reports; audit; guest-bookings list |
| Admin    | Full CRUD on rooms, bookings, guest-bookings, staff, inventory; register users |
| Finance  | Transactions, salary, debtors, suppliers, invoices, refunds, reports, audit |
| Employee | Own tasks, own work logs, submit work logs |

Public (no token): rooms list/detail, guest-booking submit/track, auth login.

---

## 17. Pagination

All list endpoints that support pagination accept:

- `?page=1` (default 1)
- `?limit=20` (default 20, max 100)

Response includes `meta: { page, limit, total }`. Use for “Page X of Y” and next/previous.

---

## 18. Error handling

- **401** — Missing or invalid token. Redirect to login.
- **403** — Valid token but role not allowed. Show “Access denied”.
- **404** — Resource not found. Show message from `body.message`.
- **400** — Validation/body error. Show `body.message`.

Always use the same `api()` helper and centralize error handling (e.g. toast or global handler that reads `body.message`).

This covers every module from booking through to audit so the frontend can implement all flows end-to-end.
