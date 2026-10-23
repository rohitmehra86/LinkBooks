# Demo Company integrity audit (live DB)

**Date:** 2026-10-23  
**Project:** `ipxflpzfcqwtenodbxwc`  
**Companies:** two `is_demo=true` rows both named “Demo Company Ltd”.

## Ledger balance (posted journals)

| Company id (prefix) | Posted journals | Debits | Credits | Balanced |
|---------------------|----------------:|-------:|--------:|----------|
| `78250720…` | 20 | 15,409,500 | 15,409,500 | **yes** |
| `25197bd0…` | 16 | 15,362,500 | 15,362,500 | **yes** |

Unbalanced journals: **0**.  
Trial-balance style sum of all account nets: **0** (equation holds).

Natural signs example (`25197bd0`):
- Assets 9,032,500 = Liabilities 3,355,000 + Equity 5,000,000 + NI 677,500

## Critical defect found (repaired)

**Symptom:** AR/AP document open balances ≠ GL control accounts when including authorised docs without `posted_journal_id`.

**Root cause:**
1. Canonical seed created INV/BILL as authorised/paid and posted matching journals separately **without linking** `posted_journal_id`.
2. Volume seeder created `paid` invoice/bill shells without journals (UI/perf only). Aging already filtered by `posted_journal_id`, but list UI showed misleading statuses.

**Repair applied (live + code):**
1. SQL: link INV-1001/1002, BILL-2001/2002, SCN-1, RCP-1001 to journals by idempotency key; demote orphan authorised/paid docs without journals → `draft`.
2. Code: `linkDemoDocumentsToJournals` after seed post; volume shells draft-only; INV-1003 seeded as draft.

**Post-repair check (both demos):**
- `ar_open` (authorised+partly_paid with journal) = **480000**
- `ar_gl` (account 1100) = **480000**
- Orphan authorised invoices = **0**

## Preservation
Original posted journals **not rewritten**. Repair only updated document linkage/status metadata.

## Follow-up
- Prefer single demo company long-term (dedupe second demo on controlled reset).
- Optional: add journal for INV-1003 if product wants overdue AR sample in GL.
