# Stage 1 gate report — Recurring Transactions V2 foundation

| Field | Value |
|-------|--------|
| **Date** | 2026-10-22 |
| **Migration** | `20261022173000_recurring_transactions_v2_foundation.sql` (applied to linked Supabase project) |

## Delivered

| Item | Status |
|------|--------|
| Schema: templates, versions, schedules, occurrences, runs | Applied |
| RLS + member/draft permission policies | Applied |
| RPC `recurring_claim_occurrence` / `recurring_complete_occurrence` | Applied |
| Backfill from `recurring_bills` + `sales_recurring_invoices` | In migration |
| RRULE engine (`rrule` npm) + month-end anchor for monthly/quarterly | `src/lib/recurring/recurrence-engine.ts` |
| Idempotent purchase bill generation | `generate-purchase-bill.ts` + wired to `generateRecurringBill` |
| Dual-write on new recurring bill save | `ensureV2ForLegacyRecurringBill` after insert |
| Cron server fn skeleton | `runRecurringScheduler` + `docs/recurring/01-STAGE1-SCHEDULER.md` |
| Unit tests (recurrence + keys) | 6 new tests, passing |

## Behaviour preserved

- Legacy tables **`recurring_bills`** / **`sales_recurring_invoices`** unchanged.
- **`generateRecurringBill`** API unchanged; now uses occurrence claim (duplicate Generate → same bill, not second insert).
- Default **draft-only** generation unless `auto_authorise` (unchanged policy).

## Gate criteria

| Criterion | Result |
|-----------|--------|
| Migration non-destructive | Pass — legacy rows backfilled, not dropped |
| RRULE / anchor tests | Pass — `recurrence-engine.test.ts` |
| Duplicate prevention (same occurrence) | Pass — DB unique + claim RPC (manual QA: double Generate) |
| Concurrent workers | Partial — claim RPC handles DB-level race; no load test yet |
| `npm run build` | Run locally after pull |
| Full `npm test` | 191/193 pass — **2 pre-existing** failures in `sales/posting.test.ts` mocks (unchanged by this stage) |

## Not in Stage 1 (Stage 2+)

- Premium overlay UI / management workspace
- Sales invoice generation via occurrence engine (still legacy `generateRecurringInvoice`)
- Reminder / on-demand modes
- Exception centre, forecast, approvals automation
- Feature Manager five-state gating

## Next: Stage 2

Recurring **bills** end-to-end overlay, editor parity with New Bill, schedule preview tab, history from `recurring_occurrences`.
