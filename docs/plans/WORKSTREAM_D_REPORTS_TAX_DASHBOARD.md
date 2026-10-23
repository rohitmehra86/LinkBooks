# Workstream D: Reports, Tax, Dashboard, formatting and UX

Branch: `workstream-d-reports-tax-dashboard` (commits `def9fd2` … `ea50ec2`, nothing pushed).
Source audits: `docs/audit/BUGS_BANKING_REPORTS.md` (RP, AC, TX) and `docs/audit/BUGS_PURCHASES_UX.md` section C (U).

## How this was verified

- `npx tsc --noEmit`, `npx vitest run` (59 files, 343 tests) and `npx vite build` all pass on the final commit.
- Eslint reports no non-formatting errors in files this workstream changed. The repo has pre-existing prettier drift in files owned by other workstreams (banking, create-new, demo-dataset, `tax-accounts.ts`, `country-packs.ts`, `tax-math.ts`); I did not reformat those.
- The three migrations were run **only on a scratch local Postgres 16** with stubbed tables, twice each, to prove they apply and are idempotent. They were **not applied to the live Supabase project**.
- The new server functions (reports, dashboard, year-end, period close, tax returns) were **not executed against the live database**. They are type-checked, and their calculations are covered by unit tests. Run the manual steps below after applying the migrations.

## Findings status

### Reports (RP)

| ID    | Status  | Notes                                                                                                                                                                                                                                          |
| ----- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RP-01 | Done    | Ledger reports use SQL aggregate RPCs plus a paged fetch ordered by id (`fetch-all.ts`, `ledger-data.ts`). No 1000-row cap. Falls back to the pager if the RPCs are missing.                                                                   |
| RP-02 | Done    | Journal report filters by date in the database and orders newest first, with paging.                                                                                                                                                           |
| RP-03 | Done    | Cash flow classifies each bank journal by all its counterpart lines into operating, investing and financing.                                                                                                                                   |
| RP-04 | Done    | Fiscal year comes from `companies.fiscal_year_end_*`. The balance sheet splits current-year earnings from retained earnings. P&L excludes year-end closing journals. Year-end close is a preview then explicit confirm.                        |
| RP-05 | Done    | Account codes in TB, P&L and BS link to the General Ledger report for that account.                                                                                                                                                            |
| RP-06 | Done    | P&L is sectioned: revenue, cost of sales, gross profit, operating expenses, other, net profit.                                                                                                                                                 |
| RP-07 | Done    | One decimal-aware converter (`convertMinorToBase`) is used on every report path. The old test expectation for JPY→USD changed from 700 to 670 on purpose, because the old value ignored decimal places.                                        |
| RP-08 | Done    | CSV export on every report (`csv.ts`, with metadata header).                                                                                                                                                                                   |
| RP-09 | Done    | Comparison with prior period or prior year, and a by-quarter option (see the report toolbar).                                                                                                                                                  |
| RP-10 | Partial | Added all-accounts General Ledger and Statement of Changes in Equity; empty categories are hidden. Still "depends" with no runner: Budget vs Actual and Fixed Asset Register. Bank reconciliation and statements link to the existing screens. |
| RP-11 | Done    | Account transactions show a running balance in the account's natural direction. Journal numbers and source documents are linkable.                                                                                                             |
| RP-12 | Done    | Control accounts are found by role (`control-accounts.ts`), not by hard-coded code.                                                                                                                                                            |
| RP-13 | Done    | The audit report shows actor, details and paging.                                                                                                                                                                                              |
| RP-14 | Done    | Only the selected report loads; the page title is the report name.                                                                                                                                                                             |
| RP-15 | Done    | `useFormat` / `format.ts`: thousands separators, currency, brackets for negatives, locale dates.                                                                                                                                               |

### Accounting (AC)

| ID    | Status       | Notes                                                                                                                                                                                                                         |
| ----- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-01 | Done         | "Financial years" tab creates a full year of periods (`createFinancialYear`, permission `accounting.post`). `postJournal` also creates the missing period on first posting (`ensure_fiscal_period_for_date`).                 |
| AC-02 | **Not done** | Conversion/opening balances. This needs a dedicated opening-balance posting flow and a conversion date, which I did not build.                                                                                                |
| AC-03 | Done         | Saving a system account no longer wipes fields. Locked fields (type, currency, control flags) are blocked once an account has activity (`lockedFieldChanges`).                                                                |
| AC-04 | Not changed  | `JournalsPanel` only shows Reverse when `canReverseHere` allows it. I did not re-audit this finding beyond reading the code.                                                                                                  |
| AC-05 | Partial      | The existing multi-line manual journal panel is kept. **Auto-reverse journals are not built** (needs a scheduler).                                                                                                            |
| AC-06 | Done         | Chart balances are financial-year-to-date for income/expense and all-time for balance-sheet accounts, in base currency.                                                                                                       |
| AC-07 | Done         | Income and expense accounts can be archived when they have no current-year activity (year-end closing journals ignored). Balance-sheet accounts still need a zero balance. Enforced in the database and in `archiveDecision`. |
| AC-08 | Not done     | Account merge still posts one journal dated today.                                                                                                                                                                            |
| AC-09 | Done         | "Period close" tab: checklist (bank, drafts, AR/AP tie-out, opening balance equity, tax return filed, year-end journal), optional year-end close, then lock with acknowledgement.                                             |

### Tax (TX)

| ID    | Status                      | Notes                                                                                                                                                                                                                                                                                                                       |
| ----- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TX-01 | Done (internal filing only) | Tax → Returns tab. Boxes are totalled from document tax lines by tax code. Accrual or cash basis. Draft → file and lock (database triggers freeze it). Optional settlement journal (`tax_adjustment`) only after explicit confirmation. UK VAT100 labels for GB, whole-pound filing amounts for boxes 6-9. See limitations. |
| TX-02 | Done                        | Tax settings save only the fields sent. Filing frequency has a select. Non-recoverable tax account added.                                                                                                                                                                                                                   |
| TX-03 | Done                        | Tax adjustment journals use a real UUID `source_id` (or null for manual ones), never free text.                                                                                                                                                                                                                             |
| TX-04 | Partial                     | The cash basis is honoured **in the return** (payments dated in the period, pro rata). The older "Tax summary" report still reads the ledger by posting date.                                                                                                                                                               |
| TX-05 | Done                        | Rates and codes can be edited, end-dated and deactivated (`rate-status.ts`, `TaxRatesPanel`, `TaxCodesPanel`).                                                                                                                                                                                                              |
| TX-06 | Done                        | Tax account pickers show only valid account types (`account-pickers.ts`).                                                                                                                                                                                                                                                   |

### Dashboard, formatting and UX (U)

| ID   | Status   | Notes                                                                                                                                                                                       |
| ---- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U-01 | Done     | Dashboard reads real data for every company. `is_demo` does not change any calculation.                                                                                                     |
| U-02 | Done     | Cash, receivables and payables use control accounts by role and honour the as-at date.                                                                                                      |
| U-03 | Done     | Server-side aggregation and paging. No row-cap truncation.                                                                                                                                  |
| U-04 | Done     | The period-close card shows real task counts from the database.                                                                                                                             |
| U-05 | Done     | Bank balances with "reconcile N items" links, receivables and payables ageing per currency, 12-month cash chart, profit vs last year, approvals, watchlist, tasks, and a New bill shortcut. |
| U-06 | Done     | The permanently disabled bell is hidden.                                                                                                                                                    |
| U-07 | Done     | Global search is now a command palette (`cmdk`) with keyboard navigation and quick links to pages and reports.                                                                              |
| U-08 | Done     | Shared money/date formatting through `useFormat`, used on the dashboard, reports, tax and accounting. Not rolled out to sales, purchases and banking screens (other workstreams own them).  |
| U-09 | Done     | Help centre with search and current articles.                                                                                                                                               |
| U-10 | Not done | Bills Capture/Import buttons are in purchases (not my scope).                                                                                                                               |
| U-11 | Not done | List-page tooling for other modules (not my scope). A shared `sortable-head` and `sort.ts` are available for them.                                                                          |
| U-12 | Not done | Numeric inputs in purchases forms (not my scope).                                                                                                                                           |
| U-13 | Done     | `aria-sort` on the shared sortable header; the palette uses `cmdk`, which manages the active option for assistive tech.                                                                     |
| U-14 | Not done | The Create-new flyover is in `src/lib/create-new/*` / `CreateNewMenu.tsx`, owned by another workstream.                                                                                     |

## Migration files (apply in this order)

1. `20261024130000_reporting_ledger_rpcs.sql`: SQL aggregate functions for TB, P&L, BS, GL and balances, used by all ledger reports. The app falls back to paged reads if missing.
2. `20261024130100_fiscal_periods_and_archive.sql`: `fiscal_year_for_date`, `ensure_fiscal_period_for_date` (auto-creates a financial-year period when posting) and the new archive rule for income/expense accounts.
3. `20261024130200_tax_returns.sql`: `tax_returns` and `tax_return_lines` (RLS select-only for members), freeze triggers for filed returns, overlap guard, and the RPCs `save_tax_return_draft`, `delete_draft_tax_return`, `file_tax_return`, `set_tax_return_settlement`. Without it, returns can be calculated but not saved or filed (the UI says so).

All three are idempotent and additive; none edits posted journals.

## Files changed

Run `git diff --name-status ac71c4d HEAD` for the full list. Main areas:

- Reports: `src/lib/reports/*`, `src/components/reports/*` (the old `FinancialReportsWorkspace.tsx` was replaced), `src/routes/_authenticated/reports/*`.
- Ledger and accounting: `src/lib/accounting/` (`fetch-all`, `ledger-data`, `fiscal-year`, `year-end`, `period-close(.functions)`, `control-accounts`, `account-rules`, `chart.functions`, `accounting.functions`, `reporting`, `fx`, `posting-engine`), `src/components/accounting/*`, `src/routes/_authenticated/accounting.tsx`.
- Tax: `src/lib/tax/` (`vat-return`, `return-periods`, `tax-return-data`, `tax-return.functions`, `rate-status`, `account-pickers`, `tax-settings-patch`, `tax-adjustment`, `tax.functions`), `src/components/tax/*`, `src/routes/_authenticated/tax.tsx`.
- Dashboard and shell: `src/lib/dashboard/*`, `src/components/dashboard/DashboardWidgets.tsx`, `src/routes/_authenticated/index.tsx`, `src/components/layout/*`, `src/lib/search/*`, `src/lib/help/*`, `help.tsx`, `src/lib/format/*`, `src/hooks/use-format.ts`, `src/lib/sort.ts`, `src/components/common/sortable-head.tsx`, `src/styles.css`.
- `src/lib/company.functions.ts` now returns the company `locale` and `date_format` so `useFormat` can apply them.
- Migrations: the three files above.

## Manual test steps for an accountant

Apply the three migrations to a staging database first.

1. **Large ledger**: on a company with more than 1,000 journal lines, open Reports → Trial balance. Totals must balance, and match the sum of the General Ledger.
2. **Fiscal year**: set the fiscal year end in company settings. Open the Balance sheet at a date in the second year. "Current year earnings" and "Retained earnings" must be separate rows.
3. **Financial years**: Accounting → Financial years → create the next year. Post a journal dated in a year with no periods; it should post and create a period.
4. **Year-end close**: Accounting → Period close → Year-end → Preview. Check the closing lines, confirm, then re-run the P&L for that year. It must be unchanged (closing journals are excluded) and income/expense accounts can now be archived.
5. **Period close**: work through the checklist, then lock the period. Posting into it must fail.
6. **Cash flow**: record a customer receipt and a supplier payment. Both must appear under operating activities.
7. **Drill-down**: click an account code in the P&L. The General Ledger opens on that account; click a journal number to open the journal.
8. **Foreign currency**: post a JPY or USD invoice. The TB, account transactions and aged AR must agree.
9. **Dashboard**: confirm bank balances, ageing and the 12-month chart against the reports. The same numbers must show for a demo and a real company.
10. **Tax settings**: change only the filing frequency, save, reload. Other fields must keep their values.
11. **Tax rates and codes**: edit a rate, end-date it, deactivate a code. Output and input pickers must list only liability/asset accounts.
12. **VAT return**: Tax → Returns. Choose a quarter, Calculate, and compare box 1 and box 4 with the Tax summary report and with a hand total of the invoices and bills. Save as draft, then mark as filed. Try editing a document dated in the period; the return should show "figures have changed since filing" while the filed boxes stay the same.
13. **Settlement**: on a filed return, choose a settlement account and date, tick the confirmation and post. Open the journal link. It must be a tax adjustment journal that clears output and input tax.
14. **Cash basis**: calculate the same period on the cash basis and check that unpaid invoices drop out.
15. **Search and shell**: press Ctrl/Cmd+K, use arrow keys and Enter; open Help and search an article.

## Known limitations

- Returns are internal records. LinkBooks does not submit to HMRC (MTD), BAS, GSTN, IRS or any other authority.
- Reverse-charge VAT is counted and flagged but not calculated. Boxes 2, 8 and 9 (EU acquisitions and dispatches) are always 0.
- Credit notes and expenses use their own date even on the cash basis.
- Sales credit note lines have no tax code, so they are classified by amounts. The return warns about uncoded lines.
- Foreign-currency documents convert at their posted journal's rate; documents without one are skipped and counted in a warning.
- Not built: AC-02 (conversion balances), AC-05 auto-reverse, AC-08 merge date, Budget vs Actual and Fixed Asset Register reports, U-10/U-11/U-12 (other workstreams' screens).
- No suspense-account check in the period close checklist, because the chart has no suspense system key.
- Money/date formatting is applied only in screens owned by this workstream.
- U-14 (Create-new flyover) belongs to another workstream and was not changed.
- Migrations and server functions have not been run on the live database (see above).
