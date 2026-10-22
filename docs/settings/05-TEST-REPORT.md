# Settings Centre — test report

**Date:** 2026-10-22

## Suite
```
Test Files  30 passed (30)
Tests       193 passed (193)
```

## New / updated coverage
- `dependency-engine.test.ts` — lock policy, multicurrency block, dimension preserve, approvals
- `feature-catalog.test.ts` — five-state model including Unavailable
- `sales/posting.test.ts` — fixed mocks for tax account resolution (pre-existing failure)

## Not yet automated (tracked)
- Cross-tenant RLS attack attempts against new settings tables (manual / follow-up)
- Browser E2E: Feature Manager disable Classes → New Bill hides class field
- axe accessibility sweep of Settings Centre

## Accounting integrity
- Lock dates enforced via `assert_journal_date_unlocked` + `journals_lock_dates_trg` on insert
- Preferences do not rewrite journals; cash basis is reporting-view config only
