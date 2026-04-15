# How balance sheet and cash flow are compiled

**Published** income statement, balance sheet, and cash flow for `/api/finance`, `/api/statements` (main paths), and `/api/accounting` (`income-statement`, `balance-sheet`, `cash-flow`, `financial-statements`) all use **`financialStatementsV3Service`** (`basis: double_entry_v3` in JSON). Optional **`/api/statements/ledger-basis/*`** still uses legacy `JournalEntry` + `incomeStatementService` / `balanceSheetService` / `cashFlowService`.

---

## Quick reference

| Statement | Route | Service / module | Follows pasted v3 spec? |
|-----------|--------|------------------|-------------------------|
| Balance sheet | `GET /api/accounting/balance-sheet`, `/api/finance/balance-sheet`, `/api/statements/balance-sheet` | `financialStatementsV3Service.getBalanceSheetV3` | **Yes** |
| Cash flow | `GET /api/accounting/cash-flow`, `/api/finance/cash-flow`, `/api/statements/cash-flow` | `financialStatementsV3Service.getCashFlowV3` | **Mostly yes** — **1001** lines; see caveats |
| Same | `GET /api/accounting/v3/cash-flow` | (identical compiler) | **Same** |

---

## V3 stack (aligned with your pasted architecture)

Source collections: **`financial_transaction_lines`**, **`financial_journal_entries`**.

### Voiding

Only lines whose header has **`isVoided: false`** are included (via `$lookup` + `$match`). That matches the rule: voided entries must not appear in statements.

### Balance sheet (`getBalanceSheetV3`)

1. Select all lines with `date <= asAt` and `accountType` in `asset`, `liability`, `equity`.
2. Join to `financial_journal_entries` and drop voided journals.
3. Group by `accountCode`, `accountName`, `accountType`.
4. For each account:
   - **Assets:** balance = **DR total − CR total** (includes contra assets such as accumulated depreciation).
   - **Liabilities and equity:** balance = **CR total − DR total**.
5. Sum **totalAssets** and **totalLiabilitiesAndEquity**; set **`balances: true`** when they match within **0.02** (rounding).

This is the same logical structure as §6.3 in your document (running balance from ledger lines, equation check).

**Caveats**

- Balances come **only** from v3 lines. Legacy `JournalEntry` / `Account` activity does **not** appear here until you post those events through v3.
- There is **no** separate “retained earnings rollforward” branch like the legacy balance sheet; equity is whatever appears on v3 equity accounts (e.g. 3003) plus postings.

### Cash flow (`getCashFlowV3`)

1. Select lines where **`accountCode === '1001'`** (Cash / Bank only) and `date` is in the period.
2. Join to journals; exclude voided.
3. **DR to 1001** → treated as **cash inflow**; **CR to 1001** → **cash outflow** (matches your §6.2).
4. **Classification** by `transactionType` on the journal header:
   - **Investing:** `equipment_purchase`
   - **Financing:** `owner_investment`, `owner_drawing`
   - **Everything else:** operating (including e.g. `management_fee_payment`, salaries, supplier payments, etc.)

Per-period summary: for each category, **net = inflows − outflows**; **netCashMovement** = operating + investing + financing net.

**Caveats vs your text**

- **Petty cash (1002)** is **not** included; your spec emphasised **1001** for the cash-flow build — the code matches that narrow definition. If you want one “total cash” statement, you would extend the match to include `1002` (or a defined list of cash accounts).
- **Depreciation** correctly does **not** appear here (no 1001 line).
- The pasted doc also described **indirect** method add-backs in §7; the **v3** endpoint is **direct** (1001-only), not indirect.

---

## Legacy stack (ledger-basis & manual journal)

**`balanceSheetService` / `cashFlowService` / `incomeStatementService`** are still used for **`GET /api/statements/ledger-basis/*`** and for **`cashFlowService`**’s internal use of **`incomeStatementService`**. **`POST /api/accounting/journal`** posts **`JournalEntry`** (embedded `lines` with `debit` / `credit` per line), **`Account`** (`type`, `subType`, `normalBalance`, `openingBalance`). Only journals with **`status: 'POSTED'`** are included. **`VOIDED`** entries are excluded by that filter.

### Balance sheet (`balanceSheetService.generate`) — ledger-basis only

1. Aggregate **posted** journal lines up to end of `asOfDate`, joined to `accounts`.
2. For each balance-sheet account (`ASSET`, `LIABILITY`, `EQUITY`), compute movement using **`normalBalance`** (DEBIT-normal: debits − credits; CREDIT-normal: credits − debits).
3. Add each account’s **`openingBalance`** to get **balance**.
4. **Presentation** groups rows by **`subType`** (e.g. `CURRENT_ASSET`, `FIXED_ASSET`, `CURRENT_LIABILITY`) and maps **specific codes** (1001, 1002, 1010, 2001, 2010, …) into line items like “cash”, “accounts payable”, “accrued expenses”. So the **math** is standard double-entry on the legacy ledger, but the **layout** is a fixed template, not a raw list of every account like v3.

**Alignment with your pasted doc**

- Same underlying principle: assets, liabilities, equity from the ledger with normal balances.
- **Differs** from v3 in: data model (embedded lines + `Account` refs), use of **`subType`/`code` buckets**, and optional **retained earnings rollforward** when `periodStartDate` is passed (ties to `incomeStatementService`).

**Naming mismatch to be aware of**

- Legacy presentation labels **2010** as “accrued expenses” in places (`financeStatements.js` / balance sheet buckets). Your v3 chart defines **2010** as **deposit liability**. Meaning of **2010** should be unified in your chart of accounts and seeds; the **services** are just reading balances for whatever that code represents in Mongo.

### Cash flow (`cashFlowService.generate`)

This is **not** built from “every line that hits 1001”. It uses the **indirect** approach:

1. **Operating:** start from **net income** and **depreciation** from `incomeStatementService` for the period, then adjust for **changes in working capital** by comparing opening vs closing balances (from posted journals) on selected codes: **1010, 1020, 1030, 2001, 2010, 2030**.
2. **Investing:** aggregates **debits/credits** on accounts whose **`subType`** is fixed asset, intangible, or long-term investment (not a `transactionType` map).
3. **Financing:** scans lines for share capital, dividends, and certain liability types (excluding 2001, 2010, 2030) to infer loans and equity flows.
4. **Reconciliation:** opening cash + net change vs **1001 + 1002** balance at period end (`_getCashBalance`).

**Alignment with your pasted doc**

- **Does not** follow §6.2’s direct compilation from **1001** lines and `transactionType` buckets.
- Closer in spirit to **§7** mention of indirect method (net income, add back depreciation, working capital) — but the exact line items and codes are **this codebase’s** design, not the v3 enum list.

---

## Which endpoint should you use?

- If you are standardising on the **v3 double-entry model** and the behaviours in your Chynae document, use **`/api/accounting/v3/balance-sheet`** and **`/api/accounting/v3/cash-flow`** for statements that must match that architecture.
- **`/api/accounting/financial-statements`** (bundle) still uses the **legacy** income statement, balance sheet, and cash flow together; it does **not** switch the bundle to v3 automatically.

For more on v3 posting and migration, see [FINANCIAL-ARCHITECTURE-V3.md](./FINANCIAL-ARCHITECTURE-V3.md).
