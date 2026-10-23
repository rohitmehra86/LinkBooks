# Workstream C — Banking (BK-01 … BK-19)

Branch: `workstream-c-banking` (not pushed). Source audit: `docs/audit/BUGS_BANKING_REPORTS.md`.

## Status per bug

| ID | Status | What changed |
|---|---|---|
| BK-01 | **Done** | `unmatch_bank_transaction` RPC (reverses only bank-coded journals, removes links, resets status, audits). Server fn `unmatchBankTransaction`. "Unmatch" / "Remove & redo" buttons with confirm. Shows "Unavailable until database update is applied" if the RPC is missing. Re-coding uses a generation-suffixed idempotency key. |
| BK-02 | **Done** | Match panel per line: candidates by amount ± N days, one-to-many and many-to-one, `match_bank_transaction` / `match_bank_transactions_to_journal_line` RPCs, "Create transfer from this line" (pre-fills `/banking/transfers`). |
| BK-03 | **Done** (see limitations) | Tick-based reconcile: opening balance, closing balance, live difference, session lines, history with Report and Reopen, printable report route. RPCs `complete_reconciliation_session`, `void_reconciliation_session`. |
| BK-04 | **Partial** | `fetchAllPages` helper and `account_balance_as_of` RPC used by banking and reconciliation. Chart-of-accounts balances (`src/lib/accounting/chart.functions.ts`) are out of scope and **not fixed**. |
| BK-05 | **Partial** | Demo bank lines are now seeded `uncategorised` (both seed files). `docs/plans/sql/demo-bank-cleanup.sql` resets existing orphan Demo lines (**not applied**). Not done: re-coding Demo lines through the engine at seed time; startup integrity check. |
| BK-06 | **Done** | Coding panel: contact, split lines (account, tax code, description), reference. One balanced journal via `post_journal`, idempotent. |
| BK-07 | **Done** | Column mapping + preview, date formats, amount modes (single / debit-credit / in-out), decimal separator, trailing minus, per-account saved mapping (server + local). Tolerant `tryParseMinor`. |
| BK-08 | **Done** | SHA-256 hash with ordinal for repeated identical rows. Duplicate preview and confirmation. Reference and payee stored. |
| BK-09 | **Done** | Real pagination (10–200), filters (account, status, direction, dates, search), stable order, server-side "code all N matching" in batches of 300. |
| BK-10 | **Partial** | Bank-account currency is chosen at creation and used for display and transfer validation. **No FX posting; cross-currency transfers are rejected.** |
| BK-11 | **Done** | `create_bank_transfer` RPC posts and inserts in one transaction (no phantom 'posted' row). Transfer history shows From/To. |
| BK-12 | **Done** | Rules: create, edit, delete, enable/disable, priority, account scope, direction, amount range. Rules **suggest**; the user confirms (single or bulk). Nothing auto-posts. |
| BK-13 | **Done** | Exclude/restore audit goes through `record_audit_event`. |
| BK-14 | **Done** | Control accounts (`is_control`), inactive, unpostable and the bank GL itself are excluded in the UI and rejected on the server. |
| BK-15 | **Done** | `bump_bank_coding_history` increments `times_used` instead of overwriting. |
| BK-16 | **Partial** | Account cards (ledger balance, last reconciliation, unreconciled count), rename, archive/restore. Not done: account number, sort code, opening statement balance. |
| BK-17 | **Done in Banking** | `MoneyField` accepts thousands separators on all banking inputs. `toMinorUnits` in `src/lib/accounting/money.ts` is untouched (out of scope). |
| BK-18 | **Done** | Account cards link to that account's lines. Journal links open `/banking/journal/$journalId`. |
| BK-19 | **Done** | Import record is written first, rows go in chunks of 500, the record is finalised with counts. |

## Migrations (apply in this order, none applied to live)

1. `20261024120000_bank_matching_schema.sql` — columns, many-to-many links, session lines, mappings, rule columns, UPDATE policies.
2. `20261024120100_bank_match_unmatch_rpcs.sql`
3. `20261024120200_bank_reconciliation_rpcs.sql`
4. `20261024120300_bank_transfer_and_coding_rpcs.sql`
5. Optional, after review: `docs/plans/sql/demo-bank-cleanup.sql` (Demo only).

The app degrades gracefully before they are applied: missing RPCs show "Unavailable until database update is applied"; missing columns fall back to the old behaviour.

### How they were checked

- Applied to a scratch Postgres 16 with stubs of the existing engine, **twice** (idempotent).
- `docs/plans/sql/scratch-verify/stubs.sql` + `scenario.sql` exercise: wrong-total match rejected, one-to-many and many-to-one match, double-match rejected, complete (blocked by uncoded line, wrong difference, correct), opening-balance continuity, unmatch blocked when reconciled, reopen, unmatch of non-bank journal (not reversed), unmatch of bank-coded journal (reversed once), group unmatch, transfers (same account, zero, currency mismatch), history counter, non-member rejected.
- Not run against the real `post_journal` (period, lock-date and control-account checks are stubbed). Do this on staging first.

## Files

- Server: `src/lib/banking/{banking,matching,reconcile,import,coding,rules,journal}.functions.ts`, `coding-server.ts`, `server-helpers.ts`, `rpc.ts`, `txn-filter.ts`.
- Pure logic (tested): `money-input`, `fetch-all`, `matching`, `recon-math`, `csv-mapping`, `coding`, `rules`, `txn-filter`.
- UI: `src/components/banking/{MoneyField,ConfirmButton,BankCodingPanel,BankMatchPanel}.tsx`.
- Routes: `banking/{index,transactions,cash-coding,import,reconcile,rules,transfers}.tsx`; new `banking/journal.$journalId.tsx`, `banking/reconciliation-report.$sessionId.tsx`; `src/routeTree.gen.ts` regenerated by `vite build`.
- Demo: bank-line blocks only in `src/lib/demo/seed-demo.ts` and `seed-demo-volume.ts`.

## Accountant manual test steps

1. Apply the 4 migrations on staging. Open **Banking** — account cards show balances.
2. **Import**: upload a CSV, map columns, check the preview, import. Import it again — duplicates are flagged and need confirmation.
3. **For review**: code one line with a tax code and contact (check the journal in Journal detail). Code a split line (two accounts) — totals must balance.
4. **Match**: record a customer receipt first, then open its statement line > Match — the receipt appears; match. Try a wrong total — it is rejected.
5. **Unmatch / Remove & redo** on a coded line: the journal is reversed, the line returns to review, re-code works.
6. **Bulk**: filter, then "Code all N matching" — counts reconcile with the list.
7. **Rules**: create a rule, run **Review suggestions**, accept some. Nothing posts until you confirm.
8. **Transfer**: create A→B. Both ledgers move; history shows From/To. Same account or zero amount is rejected.
9. **Reconcile**: choose account and statement date, enter opening and closing balance, tick items. Difference must reach 0 to complete. Open **Report** and print it. **Reopen** the latest session.

## Known limitations

- **First reconciliation opening balance.** The first session takes the opening balance you enter. Enter `0` to reconcile from the beginning of the ledger, or the statement's opening balance; the report shows any "unexplained difference". Later sessions must continue from the previous closing balance.
- Only the latest completed session can be reopened.
- Cross-currency transfers and FX posting are not supported (BK-10).
- One import request is limited to about 20,000 rows / 5 MB.
- Ticked statement groups must be ticked together (a match group is cleared as a unit).
- Chart-of-accounts balances still load unpaged (BK-04, out of scope).
- `eslint` warnings only: `MoneyField.tsx` exports a helper next to the component (fast-refresh).
