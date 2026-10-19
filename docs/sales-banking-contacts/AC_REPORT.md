# Sales / Banking / Contacts — acceptance report

**Branch:** `feature/foundational-production-readiness`  
**Date:** 19 Oct 2026  
**Evidence basis:** unit tests + code inspection. Live DB E2E blocked until migrations applied on dev (not applied without approval).

## Implemented

### Sales
- Quotes (draft/save) → convert to draft invoice (idempotent convert guard)
- Customer invoices + lines (tax bps, discounts), authorise/void via PostingEngine
- Credit notes + allocate to invoices (allocation without second journal)
- Receipts + partial allocations + unallocated overpayments
- Recurring invoices (manual generate; optional auto-authorise; same-due-date guard)
- Customer statements + Print/PDF (browser print — no fake email delivery)
- Permissions: `sales.*` on server functions

### Banking
- Bank/cash account CRUD linked to GL
- CSV import with validation + duplicate detection (`external_id` unique)
- Categorisation via `categoriseBankTransaction` (one journal + link)
- Match to existing journal line (link only; equal amounts)
- Transfers (one journal)
- Bank rules + apply-to-uncategorised
- Reconciliation sessions (balance match + no uncategorised) + history
- Feed UI: always shows disconnected unless `bank_feed_connections` row exists — **no fake success**

### Contacts
- Shared `contacts` table (customers/suppliers/both)
- Search, kind filters, duplicate active-name handling
- Detail: receivable/payable balances + invoice/bill history
- Org permissions: `contacts.manage` (+ sales/purchases draft write policies)

## Tests (automated)
- `src/lib/sales/posting.test.ts` — invoice/receipt/credit/transfer postings + idempotency keys
- `src/lib/sales/line-helpers.test.ts` — tax/discount, outstanding, recurring dates
- `src/lib/banking/csv-import.test.ts` — parse, validation, duplicate hash, rules
- Existing engine/purchases tests remain

## Limitations / remaining AC
| Item | Status |
|------|--------|
| Apply migrations to remote Supabase | **Not done** — awaiting approval |
| Live E2E against posted ledger | Blocked on migration apply |
| Split / partial bank matching (unequal amounts) | **Not supported** — schema is 1:1 equal amount |
| Email document delivery | Not configured — Print/PDF only |
| Live bank feeds (Plaid etc.) | Table exists; no provider wired; UI honest |
| Multi-allocation UI on receipts | Single invoice allocation in UI; API supports multiple |
| Credit allocate UI | API `allocateCreditNote` exists; dedicated allocate screen minimal |
| Match-existing-journal-line UI | Server fn ready; UI focuses on categorise |

## Honesty check
Page rendering alone is **not** claimed as completion. Posting paths, idempotency keys, duplicate import skips, and reconciliation balance checks are implemented in server functions and covered by unit tests where pure logic applies.
