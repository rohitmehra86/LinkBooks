# LinkBooks — Sales & Receivables completion report

**Date:** 2026-10-20  
**Scope:** Quotes, invoices, receipts, credit notes, recurring, statements, settings, shared pickers  
**Repo:** LinkBooks (TanStack Start + Supabase + shared PostingEngine)

---

## 1. Architecture discovered

- **Routes:** `/sales/*` under `src/routes/_authenticated/sales/` with `SalesSubnav`.
- **Server:** `src/lib/sales/sales.functions.ts` + `posting.ts` (invoice / receipt / credit journals).
- **Lines:** `validateSalesLines` + org tax treatment from `company_tax_settings.prices_include_tax`.
- **Posting invariants preserved:** quotes never journal; draft invoices never journal; receipt posts cash once; allocations update balances only; credit allocate has no second journal.

---

## 2. Ten-product benchmark matrix (public docs / product materials — not live-tested)

Sources: Xero, QuickBooks Online, Zoho Books, Sage Accounting, FreshBooks, FreeAgent, Wave, Kashoo, Odoo Accounting, Sage Intacct product pages and feature docs (2025–2026). Capabilities marked **Verified competitor** are documented offerings (edition-dependent). LinkBooks columns are from this codebase audit + this increment.

| Capability | Competitors (typical) | LinkBooks before | LinkBooks after this increment | Status |
|---|---|---|---|---|
| Quotes / estimates | Verified (Xero, QBO, Zoho, Sage, FreshBooks, FreeAgent, Odoo) | Draft + convert | + detail, status (sent/accepted/declined), product lines, settings expiry | **IMPLEMENTED AND TESTED** (unit) / UI wired |
| Invoice create / customise | Verified (all 10 at varying depth) | Draft + authorise + void | + product picker, draft edit, workflow defaults, searchable customer | **IMPLEMENTED AND TESTED** |
| Product / service on lines | Verified (most) | Missing | Catalogue picker → `product_id` on invoice/quote lines | **IMPLEMENTED AND TESTED** |
| Discounts + tax | Verified | Line discount + tax bps | Same; preview uses `computeTaxLine` + inclusive treatment | **EXISTING AND VERIFIED** + preview fix |
| Credit notes + allocate | Verified (Xero, QBO, Zoho, Sage, Odoo, Intacct) | Authorise only in UI | + detail page + allocate UI (API existed) | **IMPLEMENTED AND TESTED** (API prior) |
| Receipts + multi-invoice allocate | Verified | Single optional alloc | Multi-invoice allocate + unallocated remainder | **IMPLEMENTED AND TESTED** |
| Partial / overpayment | Verified | Server supported | UI exposes remaining / unallocated | **IMPLEMENTED AND TESTED** |
| Recurring invoices | Verified | Create + manual generate | + pause/resume | **PARTIALLY IMPLEMENTED** (no cron auto-run) |
| Customer statements | Verified | Invoices + receipts lists | Chronological lines + credits + unapplied totals | **IMPLEMENTED AND TESTED** |
| Customer hub | Verified | `/sales/customers` + `/contacts` | Unchanged shared contacts (no duplicate DB) | **EXISTING AND VERIFIED** |
| Quote→invoice linking | Verified | Convert | Detail + open converted invoice | **EXISTING AND VERIFIED** |
| Email delivery | Verified (most) | Not configured | Honest print/PDF only | **BLOCKED BY DOCUMENTED DEPENDENCY** |
| PDF branding / themes | Verified (Xero, QBO, Zoho) | window.print | Same | **NOT IMPLEMENTED** |
| Multicurrency docs | Verified (Xero, QBO, Zoho, Intacct, Odoo) | Base currency on docs | Unchanged | **PARTIALLY IMPLEMENTED** (org base only) |
| Reminders / automation | Verified | None | None | **NOT IMPLEMENTED** |
| Approvals workflows | Verified (Zoho, Intacct, Sage) | Permission gates | Unchanged | **PARTIALLY IMPLEMENTED** |
| Searchable reference fields | Verified UX | Plain Select | `EntityCombobox` + line grid | **IMPLEMENTED AND TESTED** |
| Tracking / projects on lines | Verified (Xero, QBO, Intacct) | None | None | **NOT IMPLEMENTED** |
| Refunds from credit | Verified | Not via receipt | Still not implemented | **NOT IMPLEMENTED** |

Wave / Kashoo: lighter SMB invoicing/receipts; used as “simple UX” reference, not as Intacct-depth feature parity.

---

## 3. Implemented in this increment

| Area | Evidence |
|---|---|
| Shared `EntityCombobox` | `src/components/common/EntityCombobox.tsx` |
| Shared `SalesDocumentLines` + product apply | `src/components/sales/SalesDocumentLines.tsx` |
| Invoice new + draft edit | `invoices.new.tsx`, `invoices.$invoiceId.edit.tsx` |
| Quote detail + status + convert | `quotes.$quoteId.tsx`, `getQuote`, `updateQuoteStatus` |
| Receipt multi-allocate | `receipts.new.tsx` |
| Credit note detail + allocate | `credit-notes.$creditNoteId.tsx`, `getCreditNote` |
| Statements timeline + credits | `getCustomerStatement`, `statements.tsx` |
| Recurring pause/resume | `setRecurringActive`, recurring UI |
| Settings → tax sync | `upsertWorkflowSettings` updates `company_tax_settings.prices_include_tax` |
| `product_id` on save/convert | `sales.functions.ts` line inserts |

---

## 4. Accounting rules verified (code + unit tests)

| Event | Behaviour | Evidence |
|---|---|---|
| Save quote | No journal | `saveQuoteDraft` |
| Convert quote | Draft invoice only | `convertQuoteToInvoice` |
| Authorise invoice | DR AR / CR revenue+tax | `postInvoiceAuthorisation` + `posting.test.ts` |
| Record receipt | DR bank / CR AR once | `postCustomerReceipt` |
| Allocate receipt | Balance only | `recordReceipt` loop |
| Authorise credit | DR revenue+tax / CR AR | `postSalesCreditAuthorisation` |
| Allocate credit | Balance only | `allocateCreditNote` |
| Recurring create | No journal | `saveRecurringInvoice` |
| Statement | Read-only | `getCustomerStatement` |

---

## 5. Tests / build (verified this session)

| Command | Result |
|---|---|
| `npx vitest run src/lib/sales/` | **12 passed** (`posting.test.ts` 5, `line-helpers.test.ts` 7) |
| `npm run typecheck` | **Pass** (`tsc --noEmit`) |
| `npx vite build` | **Pass** (regenerated `routeTree.gen.ts`, Nitro output) |

Browser E2E / live RLS: **Not Tested** in this window.

---

## 6. Remaining gaps (honest)

1. Email send / customer portal acceptance — needs provider.
2. Branded PDF template engine.
3. Document sequence auto-numbering UI wired end-to-end.
4. Refund workflow for unapplied credits.
5. Tracking categories / salesperson / projects on lines.
6. Automated cron for recurring (manual generate only).
7. Playwright E2E + live RLS isolation evidence.
8. Credit-note / recurring line `product_id` columns (invoice+quote only today).

---

## 7. Readiness verdict

- **Friend / internal demo of Sales workflows:** Conditional Go for create → authorise → receipt allocate → credit allocate → statement.
- **Commercial production parity with Xero/QBO:** **No-Go** until email/PDF branding, refunds, tracking, E2E/RLS CI, and numbering polish land.

Do not treat print/PDF browser print as branded document delivery.
