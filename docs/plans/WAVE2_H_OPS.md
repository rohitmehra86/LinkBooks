# Wave 2 H: operations leftovers

Branch `wave2-H-ops` (from main `516360f`). Nothing here is applied to the live database yet.
Every new database function is optional for the app: the pages say "needs a database update" instead of failing.

## Migrations, in apply order

All are additive and idempotent. Apply the whole list in this order.

1. `20261025300000_ops_sales_ar_lockdown.sql` (AR-02): clients can no longer write paid/credited columns, lines or allocations of sales documents; a refunded credit cannot be voided.
2. `20261025300100_ops_money_documents_rpcs.sql` (AR-30): `post_money_document`, `void_money_document`, `write_off_bad_debt`, control-account helpers, FX helpers.
3. `20261025300200_ops_purchases_payments_fx.sql` (P-06, P-16, C-09, batch payments): `record_supplier_payment`, `record_supplier_payment_batch`, `reverse_supplier_payment`, attachment-delete guard, `find_duplicate_contacts`, `purchase_credit_notes.fx_rate_to_base`.
4. `20261025300300_ops_recurring_journals.sql`: `run_due_recurring_journals`, `post_recurring_journal_now`, `process_all_due_recurring_journals` (service role only).
5. `20261025300400_ops_banking.sql` (BK-05, BK-10, BK-16): `create_bank_transfer_fx`, `bank_integrity_check`, `bank_account_details` table with `save_bank_account_details` / `list_bank_account_details`, `is_valid_iban`.
6. `20261025300500_ops_projects.sql`: `project_id` on invoice, credit note and bill lines and on bank transactions, `set_document_project`, `project_profitability`.

## What changed

### Purchases
- **P-06** Supplier payments post in the base currency. A different rate on the payment than on the bill posts the difference to FX gain (7700) or loss (7710). Rate = typed rate, else the bill's rate, else the stored rate for the date; no rate means a clear error.
- **P-14** `/purchases/credit-notes/new`: many lines, "Credit from a bill" (copies lines, applies up to what the bill still owes on authorise), exchange rate for foreign currency. "Credit this bill" button on the bill page. The credit journal now carries the rate like bills do.
- **P-16** Recurring bills never copy the supplier invoice number; generated bills get a bill number.
- **P-29** Bill prev/next uses keyset lookups (no 500-bill cap).
- **P-30** Projects (see below). Tax-per-code reverse-charge posting is not done.
- **P-31** AP control account is found by role (`system_key = 'ap'`), then code 2000.
- **C-09** Duplicate contact finder runs in SQL.
- Batch payment page `/purchases/payments/batch` (all-or-nothing, replay-safe), payment reversal, prepayments (unallocated supplier payments can fund a supplier refund).
- Attachments (P-34) still stored as base64 in Postgres. Delete is blocked once a bill is posted.

### Sales
- **AR-30** Create-New money documents (receipts, refunds, deposits, card payments, adjustments) use the atomic RPCs; refund balance includes part-used credit notes and consumes the credit so it cannot be used twice.
- **AR-02** Paid/credited columns and line tables are not client-writable. Obsolete TS fallback writes removed.
- Bad-debt write-off: button on the invoice page, posts a credit note against the bad-debt account (permission `sales.void`).
- **AR-33 / AR-34** Already partial before this wave (company/customer checks, mark as sent, copy, print). Email stays an honest "unavailable". Contact credit-limit warnings are not added.
- "Run due now" on the recurring invoice and bill pages.

### Banking
- **BK-04** Chart of accounts balances come from the `ledger_balances` RPC (no 1000-row cap).
- **BK-05** `bank_integrity_check` plus a banner on `/banking`. It shows nothing when clean, lists findings when not, and says so when the function is missing.
- **BK-10** `/banking/transfers` accepts two currencies: enter the amount received; the difference to the stored rates goes to FX gain/loss. History shows both sides.
- **BK-16** "Details" on each bank account: account number, sort code, IBAN, BIC, opening statement balance. Validated (IBAN mod-97, sort code) and shown masked (last 4 only).
- Bank rules, CSV mapping and duplicate detection already existed and were checked. The feeds page already says live feeds are not connected.

### Projects (create action `project`)
- Tag an invoice, bill (all lines) or a matched bank line from its own screen. `set_document_project` also takes `line_ids` for per-line tags.
- `/projects`: profit by project (also listed in Reports as Project Profitability) with date range, budget used, and a count of foreign-currency documents left out for lack of a rate.
- Counts authorised documents net of tax less credit notes, plus income/expense postings of tagged bank lines and Create-New documents. Drafts and void are excluded.
- Create menu entry `project` is now ready. `document_upload` is untouched.

### Recurring journals
- `/recurring-journals` page: run due now, post next now, pause/resume, interval, max occurrences, last error.
- Scheduler hook: `select public.process_all_due_recurring_journals(current_date);` (service role). The pg_cron example is in the migration header. The HTTP cron `runRecurringScheduler` also calls it.

## Manual verification

1. Apply the migrations in order on a copy; each should run twice without error.
2. Banking: open `/banking` (no banner when clean). Add details to an account, reopen: only `••••1234` is shown. Try an IBAN with one wrong digit: rejected.
3. Transfers: GBP to USD account, enter received amount; check one journal with a 7700/7710 line when the amount differs from the stored rate. With no stored rate you get a clear error.
4. Purchases: pay a EUR bill at a different rate than the bill, check the 7700/7710 line. Run a batch payment with one bad row: nothing is saved. Reverse a payment.
5. Credit note: open a posted bill, "Credit this bill", authorise: bill balance drops and the credit shows as applied.
6. Sales: write off part of an invoice; refund a part-used credit note from Create → Customer refund and check the credit can no longer be applied.
7. Projects: create a project, tag an authorised invoice and a bill, open `/projects`: revenue and cost match the net amounts.
8. Recurring journals: create one due in the past, "Run due now": one journal per missed period; run again: none.

Local verification used a scratch Postgres 16 with all migrations: money documents, supplier payments (loss/gain/prepayment/batch/reversal), recurring journals (catch-up, cap, error capture, client blocked), FX transfers, IBAN/sort code/masking, integrity findings, projects (invoice, bill, money document, bank line, date filter, missing rate). Everything balanced (0 unbalanced journals).

## Still open

- Recurring invoice and bill generation cannot run from the server cron yet: the generators check permission with the user's session. Only "Run due now" works for them. Recurring journals can be scheduled.
- Bill approval workflow beyond the existing `awaiting_approval` status; purchase order to bill conversion; bill-level FX revaluation.
- P-30 reverse charge and tax-per-code GL posting; project tags per line in the editors (the RPC supports it, the UI tags whole documents). The old per-line "project option" (tracking categories) and the new projects are separate and not yet unified. If a live `purchase_bill_lines.project_id` already holds other ids they will not match any project.
- P-34 attachments in object storage.
- AR-33 credit-limit warnings and extra contact fields; AR-34 email delivery and reminders.
- Refund links on the receipt and credit-note pages (refunds work from Create → Customer refund).
- Projects report ignores manual journals and supplier-payment FX.
- Bank rules "suggested matches" were already in place; no further rule engine work.
