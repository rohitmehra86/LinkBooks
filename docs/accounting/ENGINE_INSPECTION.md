# Accounting engine inspection (before implementation)

**Date:** 19 Oct 2026  
**Branch:** `feature/foundational-production-readiness`

## Finding

| Area | Status | Evidence |
|------|--------|----------|
| CoA tables / APIs | **Absent** | No `accounts` in migrations or `types.ts` |
| Journals / lines | **Absent** | No ledger tables |
| PostingEngine | **Absent** | No `src/lib/*posting*` |
| Reports from ledger | **UI only** | `reports.tsx` static card names |
| Accounting page | **UI shell** | Empty states + “Engine not yet enabled” |
| Reusable to keep | Auth, company tenancy, RLS helpers, permissions catalogue, serverFn patterns | Phase 2 foundation |

## Decision

**No existing accounting engine to preserve or replace.**  
Implement the authoritative double-entry engine per `docs/plan/03_ACCOUNTING_POSTING_RULES.md` and this delivery, without changing Phase 2 tenancy semantics.

**Money strategy (locked for this implementation):** integer **minor units** (`BIGINT`) for all authoritative ledger amounts. Display conversion uses currency decimal places. No IEEE floating-point for totals.
