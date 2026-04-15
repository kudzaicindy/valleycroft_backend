# Double-entry accounting (MongoDB)

This module mirrors the **ledger / chart of accounts / journal entries** design you specified (PostgreSQL version), implemented in **MongoDB + Mongoose**.

## Setup

1. Seed the chart of accounts (creates **1002 Bank**, revenue, expense codes, etc.):

```bash
npm run seed:accounting
```

If you use **`npm run seed:all`** (after `seed:users`), the chart is seeded automatically.  
If you see **`Unknown account code: 1002`**, this database has no `Account` rows yet — run **`npm run seed:accounting`** once against the same **`MONGO_URI`** as the API.

2. All routes require **JWT** and role **finance**, **admin**, or **ceo**.

Base path: **`/api/accounting`**

Same **ledger** listing is also available at **`GET /api/statements/ledger`** (see **Statements hub** in [`FRONTEND-GUIDE.md`](./FRONTEND-GUIDE.md)).

## Post journal entries (only way to move balances)

**POST** `/api/accounting/journal`

Body:

```json
{
  "entryDate": "2026-03-15",
  "periodId": null,
  "reference": "INV-001",
  "description": "Cash sale",
  "entryType": "MANUAL",
  "lines": [
    { "accountCode": "1002", "debit": 1000, "description": "Bank" },
    { "accountCode": "4001", "credit": 1000, "description": "Sales" }
  ]
}
```

Use **`accountId`** (Mongo ObjectId) instead of **`accountCode`** if you prefer.

Rules: **Σ debits = Σ credits**; at least **2 lines**. Entries are stored as **POSTED** by default.

**POST** `/api/accounting/journal/:id/void` — body `{ "reason": "..." }`. Marks original **VOIDED** and creates a **reversing** posted entry.

## Reports

### Date ranges (monthly / yearly Jan–Dec)

Use either:

- **`startDate`** + **`endDate`** (`YYYY-MM-DD`), or  
- **`year=2026`** → `2026-01-01` … `2026-12-31`, or  
- **`month=2026-03`** → full calendar month.

### Endpoints

| Method | Path | Query | Description |
|--------|------|--------|-------------|
| GET | `/ledger` | `startDate`, `endDate`, `status` (default `POSTED`, or `all`), `entryType`, `page`, `limit` | General ledger — journal entries with lines + account codes |
| GET | `/trial-balance` | `asOfDate` optional | Trial balance |
| GET | `/income-statement` | dates or `year` / `month` | P&amp;L from ledger |
| GET | `/retained-earnings` | same | RE roll-forward |
| GET | `/balance-sheet` | **`asOfDate`** required; `periodStartDate` optional | Balance sheet as at date |
| GET | `/cash-flow` | dates or `year` / `month` | Indirect cash flow |
| GET | `/financial-statements` | same | Income + balance sheet + cash flow + checks |

## Relation to `/api/finance`

- **`POST/PUT/DELETE /api/finance/transactions`** — each change **syncs to the ledger**:
  - **Create** → posts an **AUTO** `JournalEntry` (Bank **1002** vs revenue/expense account by `category`) and stores **`journalEntryId`** on the transaction.
  - **Update** → **voids** the previous entry, posts a **new** balanced entry.
  - **Delete** → **voids** the linked entry, then removes the transaction.
- If posting fails (e.g. accounts not seeded), **create** rolls back the transaction; **update** attempts to **re-post** the pre-update snapshot if void already ran.

**Category → account mapping** (see `src/services/transactionJournalService.js`):

| Transaction | Category (examples) | Ledger effect (simplified) |
|-------------|---------------------|----------------------------|
| income | `booking` | Dr 1002, Cr 4001 |
| income | `event` | Dr 1002, Cr 4002 |
| income | (other) | Dr 1002, Cr 4020 |
| expense | `salary` | Dr 6001, Cr 1002 |
| expense | `utilities` | Dr 6003, Cr 1002 |
| expense | `marketing` | Dr 6004, Cr 1002 |
| expense | `supplies`, `supplier` | Dr 6005, Cr 1002 |
| expense | `refund` | Dr 4001, Cr 1002 |
| expense | `booking` | Dr 5001, Cr 1002 |
| expense | (default) | Dr 6005, Cr 1002 |

For **GAAP-style reports**, use **`GET /api/accounting/*`** on posted journals.

### Transaction-based vs ledger-based reports

**Transaction-based reports** (figures from **`/api/finance`** — income statement, balance sheet, P&amp;L, cash flow there) are built from **`Transaction`** and related collections, **not** from the full double-entry ledger. If your organisation uses journal-based accounting, compare with **`/api/accounting`** reports when available — **totals can differ** (e.g. older `Transaction` rows without a posted journal, manual **`JournalEntry`** records that never created a `Transaction`, or timing / period boundaries).

### Booking confirmation → revenue, debtor, journal

When a **guest booking** or **internal booking** moves to **`confirmed`** (and **`totalAmount` / `amount` &gt; 0**), the API automatically:

1. Creates a **`Debtor`** (guest owes **`amountOwed` = total**; **`amountPaid` = deposit** if set, else 0).
2. Creates an **income `Transaction`** (`source`: `guest_booking_confirm` or `booking_confirm`, **`revenueRecognition`**: `accrual_ar`) so **finance statements** include the sale.
3. Posts an **AUTO journal**: **Dr 1010 Accounts Receivable**, **Cr revenue** (4001 / 4002 by category — BnB uses `booking`, events use `event`).

Cancelling a previously **confirmed** booking **voids** that journal, **removes** the `Transaction`, and marks the linked **debtor** **written-off** (zero balances).

Manual **`POST /api/finance/transactions`** still use **cash** recognition (**Dr 1002 Bank**) unless you add other flows later.

## Collections

- `accounts` — chart of accounts  
- `fiscalperiods` — optional periods (close flag)  
- `journalentries` — headers + embedded **`lines`** (accountId, debit, credit)
