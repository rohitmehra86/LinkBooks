# Wave 2 / E: accounting core

Branch `wave2-E-accounting` (from main 516360f). All migrations below are applied to the live Supabase project (verified under RLS in rolled-back tests). On a fresh database apply them in order; until then each screen shows an honest "not available yet" message.

Rules kept: one posting engine (`post_journal`), no `is_demo` logic in posting or reports, money in integer minor units, manual exchange rates only (nothing is fetched from the internet), posted journals are never edited (corrections are reversals).

## Migrations, in apply order

1. `20261025090000_ac_foundation.sql`: `fx_realised` journal source, conversion permissions, conversion-date lock in `assert_journal_date_unlocked`, helpers (`fx_to_base_minor`, `ledger_control_account`, `ensure_fx_account`).
2. `20261025100000_conversion_balances.sql`: `conversion_balance_batches`, `post_conversion_balances`, `reverse_conversion_balances`.
3. `20261025110000_fx_realised_unrealised.sql`: realised-FX triggers, `journal_auto_reversals`, `fx_revaluation_runs`, `post_auto_reversing_journal`, `process_due_auto_reversals(_system)`, `preview_fx_revaluation`, `post_fx_revaluation`.
4. `20261025120000_account_merge_dated.sql`: `preview_account_merge`, `merge_accounts_dated`.
5. `20261025130000_ledger_health_check.sql`: `ledger_health_check`.

All are idempotent (safe to run twice) and were applied to a scratch Postgres 16 twice each, after the full migration history.

## What changed

### AC-02 Conversion / opening balances (Accounting > Opening balances)

- Set a conversion date, enter a trial balance (per account) plus open invoices and bills (per contact). One balanced opening journal is posted the day before the conversion date. A difference can be accepted into opening balance equity, but only explicitly.
- Control accounts (AR/AP) cannot be entered directly: use the per-contact documents so the subledger ties.
- After the conversion date is set, posting before it is blocked (override needs `accounting.conversion.override`). A whole batch can be reversed.
- Files: `conversion-balances.ts`, `conversion.functions.ts`, `ConversionBalancesPanel.tsx`.

### AR-10 FX (Accounting > FX & reversals)

- Realised FX posts automatically when a receipt or supplier payment settles a foreign-currency document (gain to 7700, loss to 7710). Un-allocating or voiding reverses it. Rates come from the document and settlement journals.
- Unrealised revaluation: preview, then post. Open foreign AR/AP and foreign bank balances are revalued at manual rates (typed, or the stored `exchange_rates`). A missing rate stops the run and names the currency. Gain/loss go to 7720/7730. Each journal is scheduled to reverse on the next day.
- Supplier bill/payment posting now looks up the stored manual rate when a foreign currency has no rate typed. If none exists it stops with a clear message (before, it silently used rate 1).
- Files: `fx-reval.ts`, `fx.functions.ts`, `FxPanel.tsx`, `posting-engine.ts` (`resolveFxRate`).

### AC-05 Auto-reversing journals

- Manual journals have an "Auto-reverse on" date. A due reversal is posted through `reverse_journal_on`.
- Run due reversals from Accounting > FX & reversals (the button caps the date at today). Failures are recorded with the reason and retried on the next run.
- Scheduler hook (documented, not installed): `process_due_auto_reversals_system()` is granted to `service_role` only. It acts as the user who scheduled the journal, who must still be an active member with posting rights. To run daily with pg_cron:

  ```sql
  select cron.schedule('linkbooks-auto-reversals', '15 0 * * *',
    $$select public.process_due_auto_reversals_system()$$);
  ```

### AC-08 Account merge with historic dating

- The merge dialog previews one journal per accounting period, each dated inside its period (last day, or today for the current period), so prior-year P&L does not move into this year.
- Locked periods are listed. Merge stays blocked until you unlock them or tick "post the locked periods' share in one journal dated today".
- Same-currency (base) accounts only. If the old account cannot be archived (income/expense account with current-year activity, an existing rule), the balance still moves and the reason is shown.
- Files: `account-merge.ts`, `chart.functions.ts`, `ChartAccountsPanel.tsx`. If the RPC is not installed the old single-journal merge is used.

### TX-04 Tax summary on cash or accrual, reverse charge

- Reports > Tax summary has a Basis choice (default: the company's filing basis). The top figures use the same document-line code as the VAT return (`loadTaxFacts`, `computeReturnTotals`), so they match the return for the same dates and basis. A per-treatment table is shown. The ledger-movement table stays below, labelled by posting date.
- Reverse charge on supplier bills: a line on a `reverse_charge` tax code stores no supplier tax (payable = net) but keeps the code's rate. On authorisation, `postBillAuthorisation` also posts Dr input tax / Cr output tax for the notional tax (a non-recoverable code adds it to the expense instead). The return counts it in box 1 and box 4, so the net effect is zero when fully recoverable.
- Files: `reverse-charge.ts`, `reverse-charge-lines.ts`, `vat-return.ts`, `tax-return-data.ts`, `posting.ts`, `purchases.functions.ts`, `report.functions.ts`, `LedgerViews.tsx`.

### Ledger health check (Settings > Accounting)

Read-only `ledger_health_check`. Press "Run health check". Each check shows pass / needs a look / failed with a short list of offenders:

- Trial balance is zero (a difference within one minor unit per foreign journal is shown as "needs a look", not hidden).
- Every posted journal balances in its own currency.
- No orphan lines (no journal, wrong organisation, missing account) and no posted journals without lines.
- Every issued document has a live posted journal; voided documents do not.
- Receivables and payables equal the control account, per currency, in that currency (open documents, unapplied credits and unallocated payments included; FX adjustment journals left out).
- Period-lock violations: posted after the period or lock date was set, or dated outside the period.
- Auto-reversals that failed or are overdue.

If the migration is missing the panel says "Unavailable". Files: `ledger-health.ts`, `ledger-health.functions.ts`, `LedgerHealthPanel.tsx`.

## Tests

- New unit tests: `conversion-balances`, `fx-reval` (incl. `resolveFxRate`, `postJournal` auto-reverse), `account-merge`, `reverse-charge` (incl. `postBillAuthorisation` journal shape), `tax-return-data` (reverse charge, cash vs accrual), `ledger-health`.
- SQL verified on scratch Postgres (conversion, realised FX both sides with void/unallocate, revaluation + auto-reversal, dated merge, health check on a clean ledger and on a ledger with six injected faults, all detected). Trial balance stayed zero in every scenario.
- Final run: `npx tsc --noEmit` clean, `npx vitest run` 95 files / 632 tests pass, `npx vite build` OK, eslint and prettier clean on every touched file.

## Manual verification (after applying the migrations)

1. Opening balances: Accounting > Opening balances. Enter a balanced trial balance and one open invoice. Post. Check the trial balance report is balanced and the invoice shows in AR. Try posting a journal before the conversion date (blocked). Reverse the batch.
2. Realised FX: raise a EUR invoice at 1.10, receive it at 1.20. Check a "Realised FX" journal (Dr AR, Cr 7700) and that AR is nil in the base currency. Unallocate the receipt: the FX journal reverses.
3. Revaluation: Accounting > FX & reversals, pick a date, type a rate for each currency, preview, post. Next day, run due reversals. Leave a rate blank to see "Rate needed".
4. Auto-reversing journal: post a manual journal with "Auto-reverse on" tomorrow, run due reversals after that date.
5. Merge: merge two expense accounts with prior-year activity. Check one journal per period, dated inside each. Lock a year and try again: it is blocked until you tick the option.
6. Tax: Reports > Tax summary, switch Accrual and Cash. Compare with Tax > Returns for the same period and basis. Enter a bill on a reverse-charge code, authorise it, check journal has input and output tax, and the return shows it in boxes 1 and 4.
7. Health check: Settings > Accounting > Run health check. Expect all pass on a clean company.

## Still open

- Reverse charge on supplier credit notes, bank-coded spend and recurring/PO-created drafts that already carry tax: not calculated. Older reverse-charge bills that stored tax stay input-only and the return says so.
- Credit-note FX (realised or revalued) is not handled.
- Merging foreign-currency accounts is not supported.
- An income/expense account with current-year activity cannot be archived after merge (existing rule); it stays active with a zero balance.
- The pg_cron schedule is documented only. Until it is set up, auto-reversals run when someone presses the button (the health check flags overdue ones).
- Supplier payments in a foreign currency now need a stored or typed manual rate.
- Demo reset does not clear the new side tables (`fx_realised_postings`, `fx_journal_tags`, `journal_auto_reversals`, `fx_revaluation_runs`, `conversion_balance_batches`). The delete trigger is a no-op during reset, so the ledger itself resets cleanly.
- Small rounding residuals can remain where a journal converts debits and credits at one rate. The health check reports them as "needs a look" when within one minor unit per foreign journal.
- The health check's AR/AP tie uses the document tables. Data created outside the app's own posting paths can legitimately show as a failure; each item lists what to review.
