# Accounting engine — acceptance criteria report

**Date:** 19 Oct 2026  
**Branch:** `feature/foundational-production-readiness`  
**Inspection:** No prior engine existed (`docs/accounting/ENGINE_INSPECTION.md`). Implemented new engine per plan; nothing replaced.

## Migration status

| Item | Status |
|------|--------|
| `20261019140000_accounting_engine.sql` created | Yes |
| Applied to remote DB | **No** — awaiting explicit approval (dev/staging only) |

Until applied, live UI/RPC calls against Supabase will fail for missing relations/functions.

## Automated tests run

```
npm run typecheck  → pass
npm test           → 7 files, 38 tests passed
```

## Criteria matrix

| # | Requirement | Result | Evidence |
|---|-------------|--------|----------|
| 1 | Chart of accounts (code, name, type, normal balance, active, org, control) | **PASS (schema+UI)** | Migration `accounts`; UI CoA tab; seed template |
| 2 | Journal headers/lines with account, DR/CR, currency, source, date, period, creator, audit | **PASS (schema+RPC)** | `journals`, `journal_lines`, `audit_events`; `post_journal` |
| 3 | Balanced posting enforced server/DB atomically | **PASS (code)** / **PENDING (live DB)** | RPC raises if unbalanced; TS `assertLinesBalance`; unit tests |
| 4 | Single posting service validates before post | **PASS** | `src/lib/accounting/posting-engine.ts` + RPC checks membership, permissions, accounts, period |
| 5 | Transactional rollback + idempotency | **PASS (SQL design)** / **PENDING (live concurrent)** | Exception aborts function; UNIQUE idempotency + race handler; unit simulates dup key |
| 6 | Posted history immutable; reverse/replace; audit | **PASS (schema+RPC)** | Triggers; `reverse_journal`; audit insert on post/lock |
| 7 | Fiscal periods + locks + authorized unlock | **PASS (schema+RPC+UI)** | `accounting_periods`; lock/unlock RPCs; Periods tab |
| 8 | TB, GL, P&L, BS from posted ledger | **PASS (calc+UI)** | `reporting.ts` + reports route; unit tests for calc |
| 9 | Reconciliation links bank txn ↔ journal line without duplicate movement | **PASS (schema+helper)** | `reconciliation_links`; `categoriseBankTransaction` |
| 10a | Tests: balanced/unbalanced | **PASS** | `money.test.ts` |
| 10b | Duplicate posting attempts | **PASS (simulated)** | `posting-engine.test.ts` idempotency |
| 10c | Concurrent posting attempts | **PARTIAL** | DB UNIQUE + exception path coded; **no live concurrent DB test** |
| 10d | Transaction rollback | **PARTIAL** | Implied by Postgres function abort; **no live integration harness** |
| 10e | Invalid accounts / unauthorized orgs | **PASS (simulated RPC errors)** | `posting-engine.test.ts` |
| 10f | Reversals / corrected entries | **PASS (RPC+UI)** | `reverse_journal`; Reverse button; unit OB/report |
| 10g | Locked periods | **PASS (simulated)** | RPC error contract test |
| 10h | Opening balances | **PASS (unit)** | reporting OB fixture |
| 10i | Report calculations | **PASS** | `reporting.test.ts` |
| 10j | Decimal precision / rounding | **PASS** | `money.test.ts` half-up minor units |

## Known gaps (not fabricated as done)

1. Migration not applied → end-to-end against real Supabase not verified this session.  
2. No pgTAP / live concurrent load test.  
3. Manual journal UI is a **two-line helper** (not full multi-line journal editor).  
4. Bank categorisation UI not wired (helper + tables only).  
5. `draft`/`approved` workflow not separate from immediate post (engine posts atomically as `posted`).  
6. Generated `Database` types not fully regenerated for new tables (runtime uses RPC/`as never` casts).

## Next steps

1. Approve apply of `20261019140000_accounting_engine.sql` (+ prior permissions migration) on **dev**.  
2. Smoke: Ensure CoA → post journal → TB balances → reverse → lock period → post fails.  
3. Add CI integration job with service-role test user once staging exists.  
4. Multi-line journal editor + bank categorisation UI.  
