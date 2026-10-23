# Wave 2 / I: budgets, fixed assets, report quality

Branch `wave2-I-planning` (from main 516360f). Nothing here has been applied to the live Supabase
project: the four migrations were only run against a scratch local Postgres.

## 1. What changed

### Budgets
- Tables `budgets` and `budget_lines` (per account, per month, per financial year). RLS lets members read;
  all writes go through RPCs `save_budget`, `save_budget_lines`, `delete_budget` (permission
  `accounts.manage`, audit events, validate-before-write, financial year frozen once lines exist).
- Editor at `/budgets/$budgetId`: spreadsheet-style grid, per-row **Fill right**, **Uplift %** on all
  rows, **Copy last year's actuals** (from `ledger_monthly_activity`), editing a row's **Year** total
  spreads it evenly (remainder in the last month), **CSV export / import** (import validates every row
  and rejects the whole file on any problem). List at `/budgets`.
- Report **Budget versus Actual** (`/reports/budget-vs-actual`): monthly, quarterly or year-to-date
  columns, variance and variance %, favourable / unfavourable colouring, drill-down to account
  transactions, CSV and print. Actuals come from the SQL aggregate (no 1000-row cap).
- Pure logic: `src/lib/budgets/*` (`budget-math`, `budget-report`, `budget-csv`), 23 tests.

### Fixed assets
- Tables `asset_types`, `fixed_assets`, `asset_depreciation_runs`, `asset_depreciation_entries`
  (unique per asset + period). Journal source types `depreciation` and `asset_disposal` added in their
  own migration (an enum value cannot be used in the transaction that adds it).
- RPCs: `save_asset_type`, `save_fixed_asset` (auto `FA-0001` numbers, terms frozen after the first
  depreciation, optional link to a bill line with a cost cap), `delete_fixed_asset`,
  `run_depreciation(company, period_end, preview)`, `dispose_fixed_asset`,
  `report_fixed_asset_register`, `report_depreciation_schedule`.
- Depreciation posts one journal per month through `post_journal` (so period status and lock dates
  apply), is **previewed first**, is idempotent per asset + period (advisory lock, row locks, unique
  entry, `depreciated_through`) and must run in order per asset. Disposal posts a balanced journal with
  gain / loss.
- UI at `/fixed-assets`: Register (add / edit / dispose / delete), Run depreciation (preview, post one
  month, or post all outstanding months, stopping at the first failure), Asset types, and **Capitalise
  from a bill** (pre-fills an asset from a posted bill line coded to an asset account).
- Reports: **Fixed Asset Register**, **Depreciation Schedule**.
- Pure logic: `src/lib/fixed-assets/depreciation.ts` (mirrors SQL `fa_month_amount`; checked against
  the SQL on 3000 random cases), 19 tests including last-period remainder and rounding.

### Report quality
- New SQL-backed reports (no row cap), migration `20261025400000`: Executive Summary, Cash Summary,
  General Ledger Summary, Sales by Contact, Sales by Item, Purchases by Supplier, Bank Reconciliation
  Summary, plus `ledger_monthly_activity`.
- **Cash Flow (indirect)**: net profit, depreciation add-back, working-capital movements, investing and
  financing, reconciled to the bank ledger with a visible check. The existing direct cash flow is kept.
- Already present and verified, not rebuilt: Statement of Changes in Equity, P&L comparatives (prior
  period / prior year / by month / by quarter), Balance Sheet comparatives, drill-down links, CSV and
  print layout through the shared `ReportShell`.
- **Saved views** (per-user favourites) in the report shell, using the existing `report_saved_views`
  table. Dates are left out by default so a favourite opens on the current period.
- Pure logic with tests: `executive-summary.ts`, `indirect-cash-flow.ts` (`analysis.test.ts`).

### Audit items U-10 / U-11 / U-12 / U-14
- **U-10**: the permanently disabled Capture and Import buttons on Bills are removed.
- **U-11 (partly)**: Payments, Expenses, Credit notes and Purchase orders now have search and CSV
  export of the rows shown (`ListToolbar`). See "Still open".
- **U-12 (partly)**: the PO form takes tax as a percentage (sent as basis points), with decimal keypads
  and validation on quantity and tax.
- **U-14**: the Create flyover only asks to discard changes after something was edited.

## 2. Migrations, in apply order
1. `supabase/migrations/20261025400000_report_rpcs.sql`
2. `supabase/migrations/20261025400100_budgets.sql`
3. `supabase/migrations/20261025400200_journal_source_types_fixed_assets.sql`
4. `supabase/migrations/20261025400300_fixed_assets.sql`

Each is additive and idempotent. 1 requires `20261024130000_reporting_ledger_rpcs.sql`. 3 must be its own
migration and run before 4. The app degrades gracefully before they are applied: budgets, asset pages
and the new reports show "database update not applied" instead of failing.

## 3. Manual verification (after applying the migrations)
1. **Budgets**: open `/budgets`, create "FY budget", add Sales and an expense account, type monthly
   amounts, Fill right, Save. Reload: amounts persist. Try Uplift 10%, Copy last year's actuals, Export
   CSV, edit it, Import it back. A CSV with an unknown account code must be rejected with row numbers.
2. **Budget versus Actual**: `/reports/budget-vs-actual` switches Monthly / Quarterly / Year to date;
   income above budget is green, expenses above budget red; account links open Account Transactions.
   Post an invoice in the year and see the actual move.
3. **Fixed assets**: create an asset type (Computers, straight line, 36 months, accounts 1500 / 1510 /
   6200), add an asset of 3,600.00 starting this month. Run depreciation: preview shows 100.00, nothing
   posted. Post it: one journal dated month end, memo "Depreciation for ...". Preview again: "Already
   depreciated". Posting a month inside a locked period must fail with nothing stored.
4. **Last-month rounding**: a 1,000.00 asset over 3 months posts 333.33, 333.33, 333.34.
5. **Disposal**: dispose of the asset for 2,000.00; check the loss / gain figure in the dialog matches the
   journal, and the Balance Sheet shows cost and accumulated depreciation removed.
6. **Capitalise from a bill**: code a posted bill line to 1500, open "Capitalise from a bill", pick it;
   cost defaults to the line's net amount. A second asset from the same line is capped.
7. **Reports**: Executive Summary, Cash Summary, GL Summary, Sales by Contact / Item, Purchases by
   Supplier, Bank Reconciliation Summary each load, export CSV and print. Cash Flow (indirect) shows the
   badge "Opening + movements = bank ledger".
8. **Saved views**: on Profit and Loss choose "By month", Save this view, change columns, click the
   saved view: columns return.
9. **U items**: Bills has no Capture / Import buttons; open Create > any form, close it untouched with no
   prompt, type something and close: the prompt appears. PO form takes "20" as 20%.

## 4. Still open
- **Tracking categories on budgets** are not built (budgets are per account and month only).
- **Dashboard budget summary** skipped to avoid clashing with the parallel dashboard restyle.
- **Registering an asset does not post**: the purchase must already be in the ledger. Capitalising by
  reclassifying the bill line's expense into the asset account is not automated.
- **Depreciation convention** is full month in the start month; no daily or mid-month conventions, and
  no revaluation or impairment.
- **Disposal gain / loss in the indirect cash flow** is not split out: the gain stays in net profit and
  the asset's net book value shows under investing.
- **Purchases by Supplier** excludes direct expenses; **Bank Reconciliation Summary** treats
  reconciliations completed before this feature as uncleared.
- **U-11**: contacts, products, sales-side lists and employee claims still lack search / export, and
  none of the lists have sort, column chooser or paging; this is a search + CSV stop-gap, not the shared
  server-paged `DataTable`.
- **U-12**: expenses, credit notes and employee claims still take one line only and free-text amounts.
- **Settings** still lists "Fixed assets" as Unavailable (`UNAVAILABLE_SECTIONS` in `settings.tsx` and the
  `fixed_assets` feature flag); the new page is not gated by that flag. Update it when the module is
  accepted.
- Saved views live per report only; the Reports Centre does not list them yet.
- Generated Supabase types predate the new tables, so server functions use untyped `from()` / `rpc()`
  calls. Regenerate `types.ts` after applying the migrations.
- Foreign-currency bill lines can be capitalised, but the cost cap is only enforced for base-currency
  bills.
