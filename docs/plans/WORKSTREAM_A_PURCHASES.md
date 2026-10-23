# Workstream A — Purchases, Contacts, Products

Branch: `workstream-a-purchases` (worktree `LinkBooks-wsA`, based on `ac71c4d`). Not pushed.
Source: `docs/audit/BUGS_PURCHASES_UX.md`.

**Verification run:** `tsc --noEmit` clean, `vitest run` 50 files / 291 tests pass, eslint clean on touched files, `vite build` passes. No routes were added, so `routeTree.gen.ts` is unchanged.
**Not verified:** nothing here was run against a database or in a browser. All three migrations are unapplied and untested against Postgres.

## Finding status

| ID | Status | Notes |
|---|---|---|
| P-01 | Done | Editor hydrates and sends full bill state (`bill-save-payload.ts`). |
| P-02 | Done | Authorise saves only if dirty; duplicate warning needs acknowledgement. |
| P-03 | Done | `tryParseMinor` in `money-input.ts`; used in payments, payment panel, credit notes, expenses, products. |
| P-04 | Done | Open bills paged on the server. |
| P-05 | Done | Bank/cash-only pickers and server `requireBankAccount`. |
| P-06 | Not done | FX gain/loss posting is a posting-engine change; out of scope. |
| P-07 | Done | Currency selector; mismatched currency rejected; allocation lists are per currency. |
| P-08 | Done (code) / unverified | Checked writes with compensation. Atomic RPC `replace_purchase_bill_lines` is a migration; TS falls back if it is missing. |
| P-09 | Done | `allocateSupplierPayment` + UI on the payment page. |
| P-10 | Done | Credits allocate only to authorised/partly-paid bills. |
| P-11 | Done | Unallocate and void credit note, with UI. |
| P-12 | Done (needs migration) | Own numbering for POs and credit notes; draft → authorise workflow. |
| P-13 | Done | Shared status helper (`status.ts`). |
| P-14 | Not done | Credit note form still has one line with typed net and tax. |
| P-15 | Partial | PO save/convert rewritten (`po-convert.ts`). Not every sub-point re-checked. |
| P-16 | Not done | Needs `pg_cron` or scheduler; DB-side. |
| P-17 | Partial | Self-approval block, tax, claimant, visibility, bank-only account. No separate approve-then-pay step. |
| P-18 | Done | Expense post / delete draft fixed. |
| P-19 | Done | Search by supplier name and escaping in bills, suppliers, products, contacts. |
| P-20 | Done | Selection clears on page/tab/filter change; bulk actions report per row. |
| P-21 | Done | Server totals per currency (bills list and overview). |
| P-22 | Partial | Overview uses server totals; other list counts not all reworked. |
| P-23 | Done | Server-side CSV of all matching bills. |
| P-24 | Done | Statement opening balance, per currency. |
| P-25 | Done | Void button hidden on paid, part-paid and credited bills. |
| P-26 | Partial | `useCan` gating on pages touched. Not on `recurring`, `settings`, `orders.index`. UI hint only; server checks are the enforcement. |
| P-27 | Done | Mis-encoded characters fixed. |
| P-28 | Done | Reversal memo uses a name, not a UUID prefix. |
| P-29 | Not done | Bill prev/next still uses latest 500 bills. |
| P-30 | Not done | Needs `journal_lines` dimensions; schema + engine. |
| P-31 | Not done | Hard-coded AP code `2000` lives in `src/lib/accounting/*` (other workstream). |
| P-32 | Done | Duplicate-supplier-invoice check escapes `%` and `_`. |
| P-33 | Partial | Payment account placeholder and labels fixed; payment-date vs period checks not added. |
| P-34 | Not done | Attachments still stored as base64 in Postgres. |
| C-01 | Done (needs migration) | `merge_contacts` RPC; TS falls back to checked multi-step updates. |
| C-02 | Done | View ordering fixed. |
| C-03 | Partial | Paging (to 500) only. No balance columns, sort or bulk actions. |
| C-04 | Done | Balances from all open docs, per currency. |
| C-05 | Done | Payment terms 0 is kept. |
| C-06 | Done | Router navigation instead of full reload. |
| C-07 | Done | Archive blocked while open invoices/bills exist. |
| C-08 | Partial | Invalid `kind` and bad terms now error. No field mapping, addresses, update-existing or preview. |
| C-09 | Not done | Duplicate finder still in app code. |
| C-10 | Partial | Account-type validation, escaped search, tax-code select, paging, safe money, friendly duplicate-code error. `help.tsx` still calls Products a "shell" (file is outside this scope; not edited). |

## Migrations to apply (in order)

1. `20261024100000_purchases_document_prefixes.sql` — separate prefixes for PO and purchase credit notes (P-12). Bills keep `PUR-`. **Redefines `allocate_document_number`; check no other workstream redefines it.**
2. `20261024100100_replace_purchase_bill_lines.sql` — atomic bill line replace RPC (P-08).
3. `20261024100200_merge_contacts_rpc.sql` — transactional `merge_contacts`, FK-driven table discovery (C-01). **Never executed; test on a copy first.**

All are meant to be idempotent and additive. SECURITY DEFINER functions set `search_path = public`, check `auth.uid()` and permissions, and grant EXECUTE to `authenticated` only.

## Manual test steps (accountant)

1. Create a bill with several lines, tax and a duplicate supplier invoice number. Save, reload, confirm all fields persist. Authorise without edits; confirm no duplicate error.
2. Enter `1,2.50` or `abc` as an amount. Expect an inline error, not a crash.
3. Pay a bill from the payment page: only bank/cash accounts appear. Pay in a different currency; expect a clear rejection or the currency selector.
4. With 150+ bills open, confirm the supplier's older bills appear on New payment.
5. Credit note: create draft, authorise, allocate to an authorised bill, unallocate, void. Confirm bill balances and statuses each step.
6. Overpay a bill; use "Allocate" on the payment page to apply the remainder.
7. Bills list: select rows, change page, confirm selection clears. Bulk authorise; check per-row results. Export CSV with filters; confirm it covers all matches.
8. Supplier statement with a From date: opening balance equals prior activity.
9. Contacts: archive a supplier with open bills (expect block). Set terms to 0. Merge two contacts and check bills, payments and credit notes moved.
10. Products: pick a tax rate, enter an invalid price, search for `100%`.
11. Sign in as a user without purchases permissions; confirm actions are hidden and that server calls still fail if forced.

## Known limitations

- Migrations unapplied; RPC paths are untested against Postgres. TS fallbacks are in place for missing RPCs (PGRST202/42883).
- Without the RPCs, multi-step writes are checked and compensated, not atomic.
- No UI/browser testing was run; only types, lint, unit tests and build.
- Prettier was run on every touched file, so some diffs include format-only changes.
- Pure-logic tests were added (money, allocation, status, search, bank rules, bill payload, db-safety, PO convert, balances, product rules). Server functions and pages have no new tests.
- FX gain/loss, dimensions on journal lines, recurring generation and attachment storage remain open.

## Files changed

- `src/components/purchases/BillMakePaymentPanel.tsx`
- `src/hooks/use-can.ts`
- `src/lib/contacts/balances.test.ts`
- `src/lib/contacts/balances.ts`
- `src/lib/contacts/contacts.functions.ts`
- `src/lib/products/product-rules.test.ts`
- `src/lib/products/product-rules.ts`
- `src/lib/products/products.functions.ts`
- `src/lib/purchases/accounts.ts`
- `src/lib/purchases/allocation.test.ts`
- `src/lib/purchases/allocation.ts`
- `src/lib/purchases/bank-account-rules.test.ts`
- `src/lib/purchases/bank-account-rules.ts`
- `src/lib/purchases/bill-form-helpers.test.ts`
- `src/lib/purchases/bill-form-helpers.ts`
- `src/lib/purchases/bill-history.ts`
- `src/lib/purchases/bill-save-payload.test.ts`
- `src/lib/purchases/bill-save-payload.ts`
- `src/lib/purchases/db-safety.test.ts`
- `src/lib/purchases/db-safety.ts`
- `src/lib/purchases/line-math.ts`
- `src/lib/purchases/money-input.test.ts`
- `src/lib/purchases/money-input.ts`
- `src/lib/purchases/po-convert.test.ts`
- `src/lib/purchases/po-convert.ts`
- `src/lib/purchases/posting.ts`
- `src/lib/purchases/purchases.functions.ts`
- `src/lib/purchases/search-terms.test.ts`
- `src/lib/purchases/search-terms.ts`
- `src/lib/purchases/status.test.ts`
- `src/lib/purchases/status.ts`
- `src/routes/_authenticated/contacts/$contactId.tsx`
- `src/routes/_authenticated/contacts/duplicates.tsx`
- `src/routes/_authenticated/contacts/index.tsx`
- `src/routes/_authenticated/products-services.tsx`
- `src/routes/_authenticated/purchases/bills.$billId.tsx`
- `src/routes/_authenticated/purchases/bills.index.tsx`
- `src/routes/_authenticated/purchases/credit-notes.$creditNoteId.tsx`
- `src/routes/_authenticated/purchases/credit-notes.new.tsx`
- `src/routes/_authenticated/purchases/employee-expenses.tsx`
- `src/routes/_authenticated/purchases/expenses.$expenseId.tsx`
- `src/routes/_authenticated/purchases/expenses.new.tsx`
- `src/routes/_authenticated/purchases/index.tsx`
- `src/routes/_authenticated/purchases/orders.new.tsx`
- `src/routes/_authenticated/purchases/payments.$paymentId.tsx`
- `src/routes/_authenticated/purchases/payments.new.tsx`
- `src/routes/_authenticated/purchases/statements.tsx`
- `src/routes/_authenticated/purchases/suppliers.tsx`
- `supabase/migrations/20261024100000_purchases_document_prefixes.sql`
- `supabase/migrations/20261024100100_replace_purchase_bill_lines.sql`
- `supabase/migrations/20261024100200_merge_contacts_rpc.sql`

