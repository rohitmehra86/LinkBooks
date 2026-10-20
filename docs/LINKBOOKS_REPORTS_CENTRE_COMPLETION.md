# LinkBooks — Reports Centre & accounting integrity completion

**Date:** 20 Oct 2026

## Defects found and fixed

| Defect | Root cause | Fix |
|--------|------------|-----|
| Audit log `payload does not exist` | Schema column is `details`; `getAuditReport` selected `payload` | Select `details` |
| AR ageing ≫ AR control | Volume demo `INV-V*` shells marked `authorised` **without** `posted_journal_id` | Ageing uses posted journals only; demote shells; volume seed no longer authorises unposted docs |
| AP ageing ≫ AP control | Same for `BILL-V*` | Same pattern |
| Cash flow opening = 0 despite £50k open | Opening-balance journal on period start was classified as period inflow (or excluded from opening) | `source_type = opening_balance` adds to opening cash; closing reconciled to bank ledger |

## Implemented

- **Reports Centre** at `/reports` — searchable catalogue, categories, quick links, honest “Depends” labels
- **Dedicated routes** `/reports/$reportId` with deep links and refresh
- Reusable **FinancialReportsWorkspace** (filters, tabs, CSV, print, AR/AP variance + cash reconcile badges)
- **Saved views** table + server functions (`report_saved_views`)
- P&L gross profit (from prior CoA work) retained in report API
- Migration `20261020210000_reports_centre_integrity.sql`

## Not claimed (honest depends)

- Budgets / budget vs actual
- Fixed asset register
- Full IAS 7 statutory cash flow
- Bank recon summary runner (use Banking module)
- Customer/supplier statement deep-link runners (exist under Sales/Purchases)
- XLSX library export, email scheduling (no delivery stack claimed)
- Tracking-dimension columns on journal lines

## Tests

- Catalogue unit tests
- Cash-flow opening_balance unit test
- Existing TB/P&L/BS/ageing reporting tests

## Manual checks after deploy

1. Demo Company → Reports Centre → Aged Receivables ties to AR control (or shows precise variance).
2. Cash flow FY range shows opening ≈ £50,000 and reconciles badge green.
3. Audit Log loads without schema error.
4. Deep link `/reports/profit-and-loss` opens P&L tab.
