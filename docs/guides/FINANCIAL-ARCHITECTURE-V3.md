# Financial accounting architecture v3.0 (double-entry)

This backend implements the **Chynae Digital Solutions / Valley Croft** double-entry model. **Published financial statements** (`/api/finance/*`, `/api/statements/*` income/cash/balance/pl, and `/api/accounting/income-statement`, `balance-sheet`, `cash-flow`, `financial-statements`) aggregate **`financial_journal_entries.entries`** — each posted journal is one document with an **`entries`** array (`debit` / `credit` per line, `basis: double_entry_v3`). Legacy **`JournalEntry`** (manual POST `/api/accounting/journal`, trial balance, general ledger list) remains for migration and manual entries.

## Collections

| Collection | Mongoose model | Role |
|------------|----------------|------|
| `financial_journal_entries` | `FinancialJournalEntry` | Posted journal: `journalId` (`JE-YYYY-NNNN`), `publicTransactionId` (`TXN…`), `transactionType`, **`entries[]`** (each: `accountCode`, `accountName`, `accountType`, `debit`, `credit`, `description`), `totalDebit` / `totalCredit`, refs, `isVoided` |
| `financial_transaction_lines` | `FinancialTransactionLine` | **Legacy** line store (pre-embed). New posts do not write here. Run **`npm run migrate:embed-journal-entries`** once to copy lines into parent documents. |

Rules: every event is one journal document and **at least two** `entries`; **total debit = total credit**; void the header (`isVoided`) instead of deleting rows; statements exclude `isVoided: true`.

## Does this match the Chynae v3.0 document?

**Short answer:** The **v3 statement compilers** (`GET /api/accounting/v3/income-statement`, `/cash-flow`, `/balance-sheet`) follow **§6** of that guide: **`$unwind` `financial_journal_entries.entries`**, exclude **`isVoided: true`**, use the same balance formulas for the balance sheet, and build cash flow from **1001** lines with **debit = inflow**, **credit = outflow**, and **`transactionType`** buckets for investing vs financing (as in §6.2). **`createFinancialJournalEntry`** writes the full journal (header + embedded lines) and enforces **§1 / rule 7** (balanced DR/CR before save).

Your statements will only be **correct in the sense of that document** if:

1. **All** material activity is posted into the v3 collections using the **§2** chart and **§4** journal recipes (or equivalent balanced entries). Anything still on the legacy `JournalEntry` + `Account` path does **not** appear on v3 statements.
2. **Primary statement routes** (above) all use the v3 compilers. The optional **`/api/statements/ledger-basis/*`** and **`/api/accounting/trial-balance`** paths still read the **legacy** embedded `JournalEntry` chart where noted.
3. **Balance sheet equation (rule 10):** The guide’s identity **Assets = Liabilities + Equity** holds for a **complete** set of **asset, liability, and equity** postings. Revenue and expense do **not** sit on the balance sheet until **closed** into equity (e.g. **3003 Retained Earnings**). If you post P&amp;L activity but never close the period into **3003**, v3 totals may **not** tie even though each journal balances — that is expected until closing entries exist.

**Income statement §7:** The v3 income statement groups **4001–4003**, **4010**, **5xxx** COS, **6xxx** opex into the same structure (net revenue, gross profit, operating profit). Line ordering and labels may differ slightly from the PDF; amounts are driven by posted lines.

**Rules §8:** Items such as **deposits as 2010 until checkout**, **4010 for refunds**, **JE-17/18 for management fees**, and **no drawings on the P&amp;L** are **posting** rules. The aggregation code does not stop someone posting the wrong accounts; correctness depends on controllers and finance process.

**Naming vs PDF:** `transactionType` values for security deposits were renamed (`security_deposit_received`, etc.) and split booking cash types (`booking_deposit_received`, `booking_balance_received`) — see `chartOfAccountsV3.js`. Behaviour matches the intent of JE-03–JE-05 and JE-02.

## Chart of accounts & transaction types

Canonical codes and labels live in `src/constants/chartOfAccountsV3.js`:

- `CHART_OF_ACCOUNTS_V3` — account codes; **2010 Deposit Liability** includes `note`: refundable **security** deposits only, not partial booking payments.
- `TRANSACTION_TYPES_V3` — allowed `transactionType` values on `FinancialJournalEntry`.
- `TRANSACTION_TYPE_DESCRIPTIONS_V3` — short explanation per type (security deposit vs booking cash is explicit: `security_deposit_*` vs `booking_deposit_received` / `booking_balance_received`).

Legacy names `deposit_received`, `deposit_earned`, and `deposit_refund` were renamed to `security_deposit_received`, `security_deposit_earned`, and `security_deposit_refunded`.

### Chart of accounts (MongoDB `accounts`)

Upsert the full **§2** chart (1001–6031) from a single seed list:

```bash
npm run seed:chart-v3
```

Alias: `npm run seed:accounting`. Source: **`ACCOUNTS_V3_SEED`** in `src/constants/chartOfAccountsV3.js` (also builds **`CHART_OF_ACCOUNTS_V3`** for GL helpers). Safe to re-run; it updates names, types, subTypes, normal balances, and descriptions for each code.

### Database migration (journal enums + 2010 note)

After deploying the new enums, run once per environment (requires `.env` with `MONGO_URI`):

```bash
npm run migrate:financial-v3
```

This updates:

1. **`financial_journal_entries`** — old `transactionType` values → new names (`LEGACY_TRANSACTION_TYPE_RENAMES_V3` in `chartOfAccountsV3.js`). Safe to run multiple times.
2. **`accounts`** — if a row exists with `code: "2010"`, sets optional **`description`** to the deposit-liability note (also applied by `seed:chart-v3`).

## Posting helper

`src/utils/financialJournal.js` — `createFinancialJournalEntry(entry, lines)` validates balance and saves one **`financial_journal_entries`** document with embedded **`entries`** (Dr/Cr per line) in a **Mongo transaction**.

### Booking revenue — confirm vs cancel

- **Pending** guest/internal bookings: no debtor, no revenue `Transaction`, no v3 journal.
- **Confirmed**: `booking_revenue` or `event_revenue` journal only at confirm (`bookingRevenueService.onGuestBookingConfirmed` / `onInternalBookingConfirmed`).
- **Cancelled after confirm**: `postReversalThenVoidFinancialJournalV3` posts **`booking_revenue_reversal`** (same accounts, **swapped** Dr/Cr), sets **`reversesFinancialJournalEntryId`** on the new journal, then **voids** the original. Statements ignore voided journals; the active reversal adjusts the period when cancellation occurred. If a legacy header has no embedded **`entries`**, only void runs — run **`npm run migrate:embed-journal-entries`** so reversals can be generated from lines.

## HTTP API

### V3 GL write & raw journal read (auth: `finance`, `admin`, `ceo`)

Base path: **`/api/accounting/v3`**

| Method | Path | Notes |
|--------|------|--------|
| POST | `/journal` | Body: `{ entry, lines }` — `entry` matches `FinancialJournalEntry` fields; `lines` array of `{ accountCode, accountName, accountType, side, amount }` |
| POST | `/journal/:id/void` | Body: `{ voidReason }` — sets `isVoided`; reversing entry is a **separate** POST `/journal` per policy |
| GET | `/journal` | Query: `page`, `limit`, `isVoided`, `transactionType` |
| GET | `/journal/:id` | Header + lines |
| GET | `/income-statement` | `startDate`, `endDate` |
| GET | `/cash-flow` | `startDate`, `endDate` — **1001** only (§6.2) |
| GET | `/balance-sheet` | `asAt` or `asOf` |

### Same statements (v3 basis) elsewhere

- **`/api/finance`** — `income-statement`, `balance-sheet`, `cash-flow` / `cashflow`, `pl` (roles per `financeRoutes.js`).
- **`/api/accounting`** — `income-statement`, `balance-sheet`, `cash-flow`, `financial-statements` (same payloads; balance sheet accepts `asOfDate` or `asAt`).
- **`/api/statements`** — `income-statement`, `balance-sheet`, `cash-flow`, `pl` (same handlers as `/api/finance`).

## How statements are compiled (v3 vs legacy)

See **[BALANCE-SHEET-AND-CASH-FLOW-COMPILATION.md](./BALANCE-SHEET-AND-CASH-FLOW-COMPILATION.md)** for balance sheet and cash flow: what each route uses and how that compares to the v3 architecture text.

## Legacy ledger (still in use)

- **POST `/api/accounting/journal`** — posts embedded-line `JournalEntry` (does **not** write `financial_transaction_lines`).
- **Trial balance, GL list** — legacy `JournalEntry` + `Account`.
- **Confirmed guest/internal bookings** — now post **JE-01** to v3 via `financialGlPostingService` (control **1010**). Other flows (salaries, supplier payments, deposits, etc.) should be wired to `createFinancialJournalEntry` per §4.

## Full journal recipes

See the authoritative **Financial Accounting Architecture v3.0** document (JE-01–JE-18) for DR/CR by `transactionType`. This file is the implementation index only.
