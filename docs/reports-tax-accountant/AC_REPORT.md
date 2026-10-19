# Reports / Tax / Accountant — acceptance report

**Date:** 19 Oct 2026  
**Evidence:** deterministic unit tests + code paths from posted ledger / open documents.  
**Migrations not applied remotely** without approval (`20261019190000_reports_tax_accountant.sql`).

## Reports implemented

| Report | Source of truth | Verified |
|--------|-----------------|----------|
| Trial Balance | Posted journal lines | TB balances fixture; `balances` flag |
| Profit & Loss | Income/expense posted lines in range | Golden net income |
| Balance Sheet | BS accounts + closed P&L | `assets = liabilities + equity` |
| General Ledger / Account txns | Posted lines + opening before `from` | Opening/running balance test |
| Aged Receivables | Open sales invoices outstanding | Bucket math + control tie flag |
| Aged Payables | Open purchase bills outstanding | Same |
| Cash Flow | Bank GL movements (direct proxy) | Opening/net/closing; **not IAS 7** |
| Tax summary | Tax control account movements | Output/input/net fixture |
| Journal report | Journals + line totals | Status/date filter |
| Audit report | `audit_events` | Permission-gated |

Export CSV (TB) + Print/PDF via browser. Zero-data and error states on `/reports`.

## Tax configuration

- Org settings: regime, jurisdiction code, inclusive prices, basis, output/input accounts  
- `tax_rates` (effective dates) + `tax_codes` + seed packs for vat/gst  
- Inclusive/exclusive math in `src/lib/tax/tax-math.ts`  
- **Sales documents** load `prices_include_tax` and compute lines via `computeTaxLine` (half-up)  
- Period-end **tax adjustments** post `tax_adjustment` journals (idempotent) from `/accountant`  
- Limitations: `docs/reports-tax-accountant/JURISDICTIONS_AND_LIMITATIONS.md`

## Accountant tools

- `/accountant` checklist: unlocked periods, drafts, uncategorised/matched bank, open recon, recent journals  
- Tax adjustment posting + deep links to fix queues / reports / period lock / firm  
- Audit history via `/reports` → Audit tab (`audit.view`)

## Firm / clients

- `/firm`: create firm, link active org (owner/admin), access levels → membership roles, revoke  

## Tests

- `reporting.test.ts` + `reporting-extended.test.ts` (golden JE, voids/reversals, boundaries, aging, tax, cash, isolation)  
- `tax-math.test.ts` (inclusive/exclusive, effective dates)  
- Full suite must remain green after this work  

## Remaining / not claimed

| Item | Status |
|------|--------|
| Live E2E on remote DB | Blocked until migration apply |
| Statutory cash flow / tax filing | Explicitly out of scope |
| Multi-currency FX reports | Not implemented |
| Aged AR/AP always = control | Flagged when drift; unallocated receipts / timing can diverge |
| Working papers export | Later |

**Completion rule applied:** report numbers are traced to ledger fixtures in unit tests; UI alone is not treated as done.
