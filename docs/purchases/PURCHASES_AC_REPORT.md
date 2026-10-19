# Purchases module — acceptance report

**Date:** 19 Oct 2026  
**Branch:** `feature/foundational-production-readiness`

## Pre-audit summary

Purchases was **UI only** (decorative buttons). Full audit: `PURCHASES_AUDIT.md`.

## Architecture conflicts (acknowledged)

| Conflict | Resolution |
|----------|------------|
| Accounting engine migration not applied | Purchases code depends on it; **not applied to prod**; needs explicit **dev** approval |
| Nav plan marked PO/recurring/employee as LATER | Implemented with correct semantics per your request |
| Old `purchases.tsx` placeholders | Replaced by real route tree |

## Delivered

| Area | Status |
|------|--------|
| Navigation (all workflows) | Routes + subnav |
| Bills CRUD + authorise/void | Server fns + UI |
| Direct expenses | Distinct from bills; post to bank |
| Suppliers | Contact CRUD |
| Payments + allocation + overpay unallocated | Server + UI |
| Credit notes | Authorise + optional alloc |
| Purchase orders | No ledger until bill authorise |
| Recurring | Generate draft by default; dup due-date guard; error stored |
| Employee expenses | Submit / approve+reimburse |
| Statements | Open balance from bills |
| Ledger integration | Via `post_*` adapters → `post_journal` |
| Migration | `20261019160000_purchases_module.sql` |
| Unit tests | line-math + posting contracts |

## Tests run

```
npm run typecheck  → pass
npm test           → 9 files / 48 tests passed (includes purchase line-math + posting contracts)
```

## Live E2E

**Not claimed complete** until migrations are applied on **dev** and workflows are smoke-tested:

1. Create supplier → bill draft → authorise → TB/AP moves  
2. Partial payment → outstanding updates  
3. Credit note → AP reduction  
4. PO → convert → draft bill (no journal) → authorise  
5. Recurring generate twice same due date → second fails  
6. Direct expense post → bank+expense  
7. Employee claim approve → journal  

## Criteria

| Requirement | Result |
|-------------|--------|
| A Bills | **PASS (code)** / live pending migration |
| B Expenses | **PASS (code)** |
| C Payments | **PASS (code)** |
| D Credit notes | **PASS (code)** |
| E POs no post | **PASS (code)** |
| F Recurring draft default | **PASS (code)** |
| G Suppliers | **PASS (code)** |
| H UX search/filter/status | **PARTIAL** (lists + filters; pagination basic) |
| I Ledger consistency | **PASS (design+unit)** / live pending |
| J Full E2E + isolation | **FAIL until migrations + staging test** |

**Module is not marked production-complete** until live E2E passes.
