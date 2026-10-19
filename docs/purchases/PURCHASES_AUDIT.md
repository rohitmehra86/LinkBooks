# Purchases module — pre-implementation audit

**Date:** 19 Oct 2026  
**Screen:** `src/routes/_authenticated/purchases.tsx`

## Feature classification (before this work)

| Feature | Class | Evidence |
|---------|-------|----------|
| Purchases hub / tabs | UI only | Empty states; New bill/expense buttons do nothing |
| Bills | Missing | No table, API, posting |
| Expenses | Missing | EmptyState only |
| Suppliers | Missing | Contacts page also empty; no `contacts` table |
| Supplier payments | UI only | Placeholder card copy |
| Supplier credit notes | Missing | Not in UI |
| Purchase orders | Missing | Planned LATER in nav tree |
| Recurring bills | Missing | Planned LATER |
| Employee expenses | Missing | Planned LATER; included here per product request |
| Supplier statements / purchase reports | Missing | — |
| Ledger integration | Missing | Depends on accounting engine migration |

## Architecture conflicts (reported, not silently changed)

1. **Accounting engine migration not applied** — Purchases posting requires `post_journal`, AP account `2000`, etc. Code targets that engine; live E2E needs migrations applied on **dev**.
2. **Nav plan vs request** — `01_NAVIGATION_TREE.md` marks PO / recurring / employee expenses as LATER. This delivery implements them with correct semantics (PO does **not** post; recurring generates **draft** bills by default).
3. **Existing purchases.tsx** — Replaced by a real route tree; no working backend to preserve.
4. **Decorative toasts** — Removed; only real server outcomes surface success/error.

## Money & posting (locked)

- Minor units (`BIGINT`) via shared PostingEngine  
- Bill authorise → DR expense/asset (+ tax recoverable), CR AP  
- Payment → DR AP, CR bank  
- Credit note → reverse of bill pattern  
- Direct expense → DR expense (+ tax), CR bank (immediate)  
- PO → no ledger post until bill conversion  
