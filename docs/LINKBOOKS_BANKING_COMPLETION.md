# LinkBooks — Banking module upgrade completion

**Date:** 20 Oct 2026

## Retained
- Bank accounts + GL mapping
- CSV import + duplicate external_id + import history
- Single-offset categorise via `categoriseBankTransaction` (shared posting engine)
- Simple bank rules + apply-to-uncategorised
- Transfers (one journal) + reconcile session completion
- Honest disconnected bank feeds

## Implemented this increment
| Workspace | Route / behaviour |
|-----------|-------------------|
| Accounts | `/banking` |
| For review | `/banking/transactions?status=uncategorised` + counts |
| Cash coding | `/banking/cash-coding` — multi-select bulk post / exclude |
| All / Posted / Reconciled / Unreconciled / Excluded | Status filters + `statusGroup` |
| Transfers | Create + **history + void** |
| Reconcile | Existing completion (unchanged engine) |
| Rules | Existing + schema for compound conditions |
| Import CSV | Existing |
| Feeds | `/banking/feeds` — honest “no provider” + status badges |

### Integrity
- **Exclude / restore** — no journal on exclude; restore only if no recon link; audited
- **Suggestions** — local history + rules only; no cross-tenant; external research marked unavailable
- **Journal link** on matched rows → Accounting
- **Bulk categorise** — per-row outcomes, idempotent keys
- Migration `20261020220000_banking_workspaces.sql`

## Not live (honest)
- Live bank feed providers (TrueLayer/Plaid etc.)
- Match statement line → invoice/bill UI (API `matchBankTransaction` exists)
- Split coding UI
- Full AND/OR rule builder UI (DB columns ready)
- Email / AI merchant lookup

## Tests
- `suggestions.test.ts`
- Existing banking/csv tests if present

## Manual checks
1. For review → Post one line → status matched + journal link
2. Cash coding → select 3 → post → counts drop
3. Exclude → Excluded tab → Restore → For review
4. Feeds page says provider not configured
