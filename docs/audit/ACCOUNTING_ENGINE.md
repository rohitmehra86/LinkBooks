# Accounting engine

## Authority
1. Client validates line balance (`assertLinesBalance`).
2. `postJournal` → RPC `post_journal` (SECURITY DEFINER):
   - membership + `accounting.post` / `journals.manual`
   - period exists and status `open`
   - **two-tier lock dates + conversion date** (`assert_journal_date_unlocked`)
   - idempotency key
   - ≥2 lines, each single-sided, accounts postable/active
   - sum(debits)=sum(credits), non-zero
3. Trigger `journals_lock_dates_trg` re-asserts lock dates on INSERT.
4. Triggers prevent mutation of posted journals/lines.
5. Corrections only via `reverse_journal`.

## Document posting
Sales/Purchases authorise paths call module posting helpers that call `postJournal` and set `posted_journal_id`.

## Cash-basis
Reporting view only — never rewrites posted accrual journals (Settings accounting config).

## Demo canonical
`DEMO_JOURNAL_SPECS` in `demo-dataset.ts` define goldens exercised by `demo.test.ts`. Volume layer must not add journals.
