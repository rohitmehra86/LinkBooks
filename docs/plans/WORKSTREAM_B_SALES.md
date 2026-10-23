# Workstream B — Sales / Accounts Receivable

Branch: `workstream-b-sales` (not pushed). Source audit: `docs/audit/BUGS_SALES_AR.md`.

## How it was verified

- `npx tsc --noEmit`, `npx vitest run` (312 tests), `npx eslint` on touched files, `npx vite build`: all pass.
- Migrations were replayed on a local Postgres 16 harness (`.pgtest/`, git-ignored) with Supabase stubs,
  twice over (idempotency). Covered: over-allocation rollback, AR as deposit rejected, receipt + allocation,
  credit allocation, unallocate, void receipt, void credit note, void invoice, quote convert once only,
  delete draft, locked-period void (rejected, then OK on a later open date), recurring delete, posted-document guard.
- **Not verified:** nothing was run against the live Supabase project or in a browser. UI flows are
  type-checked and built, not clicked through. See "Manual test steps".

## Finding status

| ID | Status | Notes |
|---|---|---|
| AR-01 | Done | RPC `record_customer_receipt` validates, posts DR bank / CR AR, writes receipt + allocations in one transaction. TS fallback validates first and compensates (reverses journal, voids receipt). |
| AR-02 | Partial | Trigger blocks client edits to amounts, date, number, currency and journal link of posted invoices / credit notes, and moving them back to draft. Paid / credited columns stay client-writable because the TS fallbacks need them. Line tables are not guarded. Tighten after the RPC migrations are live. |
| AR-03 | Done | Credit allocation checks invoice status, customer, currency, outstanding (RPC + fallback). |
| AR-04 | Done | RPCs lock rows; fallback uses conditional updates on `amount_paid_minor`. |
| AR-05 | Done | `unallocate_customer_receipt`, `void_customer_receipt`, `void_sales_credit_note`, `remove_sales_credit_allocation`; soft reversal (`reversed_on`). UI buttons, confirm dialogs, mandatory reason, date. Correction RPCs have **no TS fallback** (clear "apply migration" error). |
| AR-06 | Done | `listOpenInvoicesForCustomer` (paged, no 50-row cap) used by receipt and credit-note screens. |
| AR-07 | Done | Credit notes use `SalesDocumentLines` (multi-line, tax, discount, tax code). |
| AR-08 | Done | `getAgedReceivablesAsAt` in `ar-reports.functions.ts`: as-at from dated events, unallocated receipts and unapplied credits as negative lines, per currency, ties to AR control. **Not yet wired into the Reports page** (reports workstream). |
| AR-09 | Done | Statement has opening balance, per-currency sections, void entries. |
| AR-10 | Partial | Currency picker + FX rate on invoices, quotes, credit notes and receipts; amounts shown in document currency; `fx_rate_to_base` passed to posting. Recurring invoices are base currency only. No FX revaluation / realised gain-loss. |
| AR-11 | Done | `saveAndAuthoriseInvoice` keeps one draft; the editor keeps the saved id, so a failed authorise leaves the form on the same draft. |
| AR-12 | Done | `save_sales_document_draft` RPC saves header + lines atomically (compensated fallback). |
| AR-13 | Done | Number allocated in the transaction when missing, on save and on quote->invoice. |
| AR-14 | Done | Quotes, credit notes, invoices allocate numbers (`QU-`, `SCN-`, `INV-`). |
| AR-15 | Done | Every write error is checked in sales and recurring code. |
| AR-16 | Done | Quote->invoice: company-timezone today, customer/company terms, recalculated lines, atomic claim (second convert rejected). |
| AR-17 | Done | Transition table; `sent_at` / `accepted_at` / `declined_at` stamped (needs migration 110100). |
| AR-18 | Done | `company_tax_settings.prices_include_tax` is the single source (server config drives the UI preview). |
| AR-19 | Done | Tax-code picker shows %, `tax_code_id` saved on every line; rate derived server-side. |
| AR-20 | Done | Half-up rounding in `line-math-rounded.ts` with tests. Per-line rounding; no invoice-level rounding adjustment. |
| AR-21 | Done | Void only shown when allowed (`canVoidInvoice` / `canVoidCreditNote`), with reason + date dialog. |
| AR-22 | Done | `reverse_journal_on(journal, date, key)`; void dialogs take a date; locked period rejects atomically. |
| AR-23 | Done | Invoice view: company/customer, ordered lines, unit price, discount, tax %, totals, payment history, print stylesheet. |
| AR-24 | Done | "Record receipt" from an invoice passes `contactId` + `invoiceId`, prefilled. |
| AR-25 | Done | Deposit picker lists active bank/cash accounts only; RPC enforces it. |
| AR-26 | Done | `fetchAllPages` paging in overview, statement and as-at report. |
| AR-27 | Done | Lists (invoices, quotes, receipts, credit notes): server search (escaped), status, date, overdue, sort, page size, CSV export. |
| AR-28 | Done | Recurring: multi-line, tax, edit, delete (never-run only), end date, max count, customer terms. |
| AR-29 | Done | Finished schedules are deactivated and the v2 schedule paused. |
| AR-30 | Not done | Lives in `src/lib/create-new/*` (out of scope). Refund balance should include `partly_paid` credit notes. |
| AR-31 | Done | Demo volume seed is draft-only (verified). Migration 110100 adds `sales_invoices_draft_has_no_payments`; it is left `NOT VALID` with a NOTICE if dirty drafts exist. Existing dirty rows are **not** auto-cleaned (see limitations). |
| AR-32 | Done | Invoice numbers with links in allocations; statuses relabelled "Awaiting allocation / Partly applied / Fully applied". |
| AR-33 | Partial | Recurring save validates the customer belongs to the company and is a customer. Contact fields (address, credit limit) not extended. |
| AR-34 | Partial | "Mark as sent", "Copy invoice" and print added. Email delivery stays an honest "unavailable". |

## Migrations to apply (in order)

1. `20261024110000_reverse_journal_on_date.sql` — `reverse_journal_on` with explicit date.
2. `20261024110100_sales_ar_columns.sql` — void metadata, quote dates, FX, tax code on lines, recurring end/terms, allocation reversal columns, search indexes, draft CHECK constraint.
3. `20261024110200_sales_ar_receipt_credit_rpcs.sql` — `record_customer_receipt`, `allocate_sales_credit_note`.
4. `20261024110300_sales_ar_correction_rpcs.sql` — unallocate / void receipt, void credit note, void invoice, remove credit allocation.
5. `20261024110400_sales_ar_save_document_rpc.sql` — `save_sales_document_draft`, `delete_draft_sales_document`.
6. `20261024110500_sales_recurring_delete.sql` — `delete_sales_recurring_invoice`.
7. `20261024110600_sales_posted_document_guard.sql` — posted invoice / credit note guard triggers.

Apply 1 and 2 first; the app falls back to compensated TS paths for the receipt, credit-allocation and
draft-save RPCs if 3–5 are missing, but correction features (void receipt, unallocate, void credit note,
remove allocation, delete recurring) need 4 and 6.

## Files changed

- Migrations: the seven files above.
- Server: `src/lib/sales/{sales.functions,sales-receipts.functions,sales-credits.functions,sales-recurring.functions,sales-statements.functions,sales-config.functions,ar-reports.functions}.ts`, `sales-common.ts`, `doc-save.ts`, `tax-codes.ts`, `posting.ts`, `line-helpers.ts`.
- New pure helpers (with tests): `line-math-rounded`, `quote-status`, `allocation-rules`, `ar-asat`, `statement`, `rpc`, `fetch-all`, `ar-accounts`, `list-filters`, `csv`, `dates`, `recurring-end`.
- Recurring: `src/lib/recurring/generate-sales-invoice.ts`, `v2-sync-sales.ts`.
- UI components: `src/components/sales/{SalesDocumentEditor,SalesDocumentLines,ListKit,ReasonDialog,sales-form-utils}`.
- Routes under `src/routes/_authenticated/sales/`: invoices (list, new, `$invoiceId` layout + index + edit), quotes (same), credit notes (same), receipts (list, new, new `$receiptId`), recurring, statements, index. `src/routeTree.gen.ts` regenerated by `vite build`.
- Test change: `posting.test.ts` gained one `vi.mock` for `ar-accounts`; no assertion changed.

## Shared helper files created (outside pure sales UI)

- `src/lib/sales/sales-common.ts` (line parsing, tax-treatment, company defaults/timezone, reason/date asserts)
- `src/lib/sales/tax-codes.ts`, `src/lib/sales/fetch-all.ts`, `src/lib/sales/csv.ts`, `src/lib/sales/rpc.ts`
- `src/components/sales/ListKit.tsx` (reusable list toolbar/sort/pager/CSV helper — purchases could reuse it)
- `reverse_journal_on` (SQL) is generic and can be reused by purchases.

## Notes for other workstreams

- **Reports:** switch the Aged Receivables report to `getAgedReceivablesAsAt` (`src/lib/sales/ar-reports.functions.ts`). The old report in `accounting.functions.ts` still uses current status.
- **Create-new:** `NewInvoice`, `NewQuote`, `NewReceipt`, `NewCredit` exports are kept; `RecurringInvoices` too.
- AR-30 is in `create-new/money-documents.functions.ts`.

## Manual test steps (accountant)

1. Create an invoice with two lines (one taxed, one discounted). Check totals; Save & authorise; confirm one invoice number and one journal.
2. Make authorise fail (lock the period) — the draft stays, no duplicate on retry.
3. Invoice page -> Record receipt: customer and invoice are prefilled; AR is not offered as deposit account. Pay part, then the rest.
4. Receipt detail: Unallocate one invoice with a reason and date; the invoice reopens. Void the receipt; bank/AR journal is reversed on the date chosen.
5. Credit from invoice: credit note prefilled; authorise; apply to an open invoice; remove the application; void the credit note.
6. Void an authorised unpaid invoice; confirm Void is hidden once it is paid or credited.
7. Quote: send, accept, convert; the invoice uses today's date and customer terms; second convert is blocked.
8. Customer statement with a `from` date: opening balance appears; foreign currency shown separately.
9. Lists: search, status, overdue, sort, page size, CSV export on all four lists.
10. Recurring: create two-line taxed template with end date; Generate now until finished; delete a never-run template.
11. Print an invoice: sidebar/buttons hidden.

## Known limitations

- Correction RPC features have no TS fallback; they need migrations 4 and 6.
- Recurring invoices are base currency only.
- Email sending, payment links, reminders, attachments: unavailable (not faked).
- Void entries before migration 2 have no `void_date`; those legacy voids are omitted from as-at reports and statements.
- Existing Demo Company drafts that carry paid amounts are not cleaned by migration; the CHECK stays `NOT VALID` until they are fixed (`UPDATE sales_invoices SET amount_paid_minor = 0 WHERE status = 'draft'` after review, then `VALIDATE CONSTRAINT`).
- AR-02 guard covers posted amounts/dates/numbers only (see table).
- Rounding is per line; no invoice-level rounding line.
- No FX gain/loss on receipts in a different rate than the invoice.
- Browser flows are not click-tested.
- `customers.tsx` and `settings.tsx` already fail prettier on main; left untouched.
