# CTO programme status

**Updated:** 2026-10-23  
**Branch:** `cto-master-programme` (from `main` @ `f50fe31`)

## Checkpoint

| Milestone | Status |
|-----------|--------|
| M0 Discovery + audit docs | **DONE** |
| M1 Critical integrity repair (demo AR/GL) | **DONE** (live SQL + seed code) |
| M2 Design/nav flyover foundations | NEXT |
| M3–M13 | Pending per directive |

## Evidence this checkpoint
- Pulled `main` fast-forward to Create New + enterprise CoA.
- Audit pack under `docs/audit/*`.
- Tests: **236 passed** (after `npm install` restored `rrule`).
- Live demo AR open = AR GL = 480000 after repair.

## Files changed (this checkpoint)
- `src/lib/demo/seed-demo.ts` — link journals; INV-1003 draft
- `src/lib/demo/seed-demo-volume.ts` — draft-only shells
- `docs/audit/*`, `docs/plans/*`
- `package-lock.json` (npm install)

## Blockers
None blocking M2. External: email/bank/AI providers remain unconfigured (honest Unavailable).
