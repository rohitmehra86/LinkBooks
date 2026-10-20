# LinkBooks — Industry CoA library completion report

**Date:** 20 Oct 2026  
**Catalog version:** `2026.10.20.1`

## Principle

**Maximum capability, minimum unnecessary complexity.** Level A (system seed) stays lean for every org. Industries add Level B recommendations. Level C optional library and manual add remain available. Applying templates is additive and never rewrites posted history.

## Deliverables

| # | Deliverable | Location / status |
|---|-------------|-------------------|
| 1 | 50-company benchmark | `docs/LINKBOOKS_COA_50_COMPANY_BENCHMARK.md` — **done** |
| 2 | FS category → LinkBooks matrix | Same doc + `fs_line` on library accounts — **done** |
| 3 | Industry catalogue | `src/lib/accounting/coa-library/catalog.ts` — **40 industries**, **15 families** |
| 4 | Account counts | See `catalogStats()` — library ~55 accounts; industries reuse shared keys |
| 5 | Migration | `supabase/migrations/20261020200000_industry_coa_library.sql` |
| 6 | Major modules | `coa-library/*`, `coa.functions.ts`, `IndustryCoaPanel.tsx`, `reporting.ts` P&L sections |
| 7 | P&L / BS integration | P&L now exposes revenue, COGS, gross profit, sections; BS still subtype-driven |
| 8 | Tests | `coa-library/apply.test.ts`, extended `reporting.test.ts` |
| 9 | Security | RLS on settings/tracking/apply events; system-account UPDATE trigger |
| 10 | Limitations | See below |

## Architecture (three levels)

| Level | What | How |
|-------|------|-----|
| **A — Basic** | Existing `seed_default_chart_of_accounts` | Unchanged; control AR/AP/tax/bank/RE |
| **B — Recommended** | Industry packs × simple/standard/detailed | Preview + apply (additive) |
| **C — Optional** | Full library search + manual create | `addOptionalLibraryAccounts` / `createManualAccount` |

## Implemented workflows

- Multi-industry selection with search
- Simple / Standard / Detailed preview before apply
- Idempotent re-apply (matches `catalog_key` or code)
- Conflict detection (same code, incompatible type)
- Church / charity tracking categories (Fund, Mission, Ministry, Campus, Department, Project)
- Add optional accounts from library
- Add new account (closes former G-018 read-only CoA gap for creates)
- Apply audit in `coa_apply_events`
- P&L gross profit / COGS sectioning in reporting engine + Reports UI

## Not claimed / remaining

| Gap | Status |
|-----|--------|
| Full parent/subaccount hierarchy UI | Not built — flat CoA with `fs_line` |
| Journal-line tracking dimension posting UI | Categories seeded; line allocation UI deferred |
| Country-specific statutory CoA packs | Structure ready; GB-style codes remain default |
| OCR / inventory valuation / payroll | Out of CoA scope — feature-dependent accounts flagged only |
| Automatic deletion when lowering detail level | Intentionally refused (preserve history) |
| Playwright E2E for apply | Unit tests only in this increment |

## Preservation

- Existing accounts, journal lines, and demo seed codes are untouched by apply.
- System/control codes cannot change type/code via trigger.
- Seed RPC still upserts Level A only; industry apply inserts non-system rows.

## Acceptance checklist (owner)

- [x] Benchmark documented (50 companies)
- [x] Industry coverage across required families
- [x] Church-specific template + dimensions
- [x] Preview / apply / optional / manual
- [x] P&L mapping improved (COGS / gross profit)
- [x] Migration + RLS
- [x] Automated tests for catalogue + apply + P&L
- [ ] Tracking on transaction forms (follow-up)
- [ ] Jurisdictional tax code packs (follow-up)
