# CTO programme status

**Updated:** 2026-10-23
**Branch:** `cto-wave2` (from `main` after PR #3)

## Checkpoint

| Milestone | Status |
|-----------|--------|
| M0 Discovery + audit docs | **DONE** |
| M1 Critical integrity repair (demo AR/GL) | **DONE** |
| Wave 1 (A purchases, B sales, C banking, D reports/tax/dashboard) | **DONE**, merged to `main` (PR #3) |
| Wave 2 E: accounting core (opening balances, FX, auto-reverse, merge, reverse-charge, health check) | **DONE**, live |
| Wave 2 F: documents (print/PDF, email, attachments, share links, statements) | **DONE**, live (email needs `RESEND_API_KEY` + `EMAIL_FROM`) |
| Wave 2 G: professional UI (tokens, shell, dashboard, list pages, auth) | **DONE** (bills list + document forms still on old layout) |
| Wave 2 H: ops (AR lockdown, atomic money docs, supplier payments FX, recurring journals, banking, projects) | **DONE**, live |
| Wave 2 I: budgets, fixed assets, new reports | **DONE**, live |

## Evidence
- `tsc` clean, `vitest` 780 tests, `vite build` OK on `cto-wave2`.
- Every wave-2 migration was applied to the live project and exercised under RLS in rolled-back blocks.
- Live `ledger_health_check` passes all 8 checks on both Demo companies.
- Interaction fix: `20261025310000_fx_inline_guard.sql` stops realised FX being posted twice for supplier payments.

## Per-workstream detail
`docs/plans/WAVE2_E_ACCOUNTING.md`, `WAVE2_F_DOCUMENTS.md`, `WAVE2_G_UI.md`, `WAVE2_H_OPS.md`, `WAVE2_I_REPORTS_PLANNING.md`.

## Known limits (honest)
- No live bank feeds, no online payment provider, no electronic tax filing, no server-side PDF generation.
- Automatic schedulers (auto-reversals, recurring journals, reminders) are documented but not installed; they run on demand.
- `ops_record_supplier_payment` leaves `linkbooks.fx_inline` on for the rest of the transaction after an idempotent replay (harmless today).
