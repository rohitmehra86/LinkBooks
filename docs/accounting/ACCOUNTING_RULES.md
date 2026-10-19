# LinkBooks — Accounting rules (implemented)

**Authority:** Postgres RPC `post_journal` (+ TypeScript `postJournal` wrapper).  
**Money:** integer **minor units** (`BIGINT`). No IEEE float for ledger totals.

## Journal lifecycle

| Status | Meaning |
|--------|---------|
| `draft` | Reserved for future UI drafts (engine posts atomically as `posted`) |
| `posted` | Immutable; on the books |
| `voided` | Reserved for never-posted abandonment |
| Reversal | New posted journal with swapped debits/credits; links via `reverses_journal_id` / `reversed_by_journal_id` |

## Balance

- ≥ 2 lines  
- Each line: exactly one of `debit_minor` / `credit_minor` > 0  
- `SUM(debit_minor) = SUM(credit_minor)` enforced in RPC; failure raises and rolls back  

## Idempotency

- Unique `(company_id, idempotency_key)`  
- Retries / concurrent races return the existing journal id  

## Periods

- Posting date must fall in an `open` `accounting_periods` row  
- `lock_accounting_period` / `unlock_accounting_period` with permission checks + audit  

## Immutability

- Triggers block UPDATE/DELETE on posted journals/lines unless `linkbooks.trusted=on` (RPC only)  

## Reports

- TB / P&L / BS / GL built only from `journal_lines` joined to `journals` with `status = posted`  

## Bank reconciliation

- Categorisation posts **one** journal via `post_journal`  
- `reconciliation_links` ties `bank_transactions` → `journal_lines` (unique each side) so no duplicate movements  

## Demo

- Same tables, RPC, and report code; `is_demo` does not fork posting logic  
