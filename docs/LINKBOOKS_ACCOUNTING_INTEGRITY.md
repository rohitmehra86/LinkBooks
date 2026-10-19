# LinkBooks — Accounting Integrity (Owner Audit)

| Field | Value |
|-------|-------|
| **Date** | 2026-10-19 |
| **Scope** | Ledger correctness, immutability, demo parity, test evidence |
| **Supersedes** | Informal “single engine” notes; partial tables in [LINKBOOKS_PRODUCTION_READINESS_REPORT.md](./LINKBOOKS_PRODUCTION_READINESS_REPORT.md) |

## Architecture (authoritative path)

All modules that move the general ledger must use one client service and one database RPC:

1. **`postJournal()`** — `src/lib/accounting/posting-engine.ts` — validates date format, `assertLinesBalance()`, builds JSON payload.
2. **`post_journal(payload JSONB)`** — `supabase/migrations/20261019140000_accounting_engine.sql` — membership, permissions, period, balance, insert journal + lines in one transaction.

Supporting RPCs (same migration family): `reverse_journal`, `seed_default_chart_of_accounts`, `seed_default_accounting_periods`, demo company helpers.

**Migrations applied (owner-verified on prod project `ipxflpzfcqwtenodbxwc`):**

| Timestamp | File |
|-----------|------|
| 20261019120000 | `permissions_expand_and_indexes.sql` |
| 20261019140000 | `accounting_engine.sql` |
| 20261019160000 | `purchases_module.sql` |
| 20261019180000 | `sales_banking_contacts.sql` |
| 20261019190000 | `reports_tax_accountant.sql` |
| 20261019200000 | `cross_cutting_settings_fx_demo.sql` |
| 20261019210000 | `ai_assistant.sql` |
| 20261019220000 | `demo_company_guards.sql` |

---

## Posting rules (enforced)

| Rule | Client | Database (`post_journal`) |
|------|--------|---------------------------|
| Authenticated user | Supabase session | `auth.uid()` not null |
| Company membership | Passed `company_id` | `is_company_member(company_id)` |
| Permission | Server fns call permission checks | `accounting.post` OR `journals.manual` |
| ≥ 2 lines | `assertLinesBalance` | Array length ≥ 2 |
| Debits = credits | `assertLinesBalance` | Sum debit_minor = sum credit_minor |
| Posting date in open period | — | Period covering `journal_date`; status = `open` |
| Supported currency | Optional code | `currency_decimals` lookup; FX rate > 0 |
| Account belongs to company | — | Account validation in RPC loop |
| Idempotency | Optional `idempotency_key` | `UNIQUE (company_id, idempotency_key)`; returns existing journal id |

Document modules (sales/purchases/banking/tax/demo) build line drafts then call `postJournal` — no parallel “demo ledger.”

---

## Immutability

Posted journals and lines are protected by triggers using session flag `linkbooks.trusted`:

- Direct **UPDATE/DELETE** on posted `journals` / `journal_lines` rejected unless `linkbooks.trusted = on` (set only inside SECURITY DEFINER RPCs such as `post_journal`, `reverse_journal`, trusted seed paths).
- Reversal flow: `reverse_journal` creates offsetting posted journal; links `reverses_journal_id` / `reversed_by_journal_id` under trusted context.

**Live-proof gap:** Triggers exist in SQL; no automated test has forced a client-side UPDATE on posted rows against live Postgres.

---

## Idempotency

- Design: duplicate `idempotency_key` for same company returns existing journal UUID without double insert.
- Unit tests mock RPC behaviour; **no concurrent live race test** (see G-008 in Gap Register).

---

## `is_demo` rule (non-negotiable)

Per `AGENTS.md` and code review:

- `is_demo` may gate **reset**, destructive guards, **billing**, external **integrations**, demo badges, onboarding — **not** posting validation, balance rules, or report logic.
- Demo seed (`src/lib/demo/seed-demo.ts`, `demo-dataset.ts`) uses **PostingEngine** with the same rules as production companies.
- **Mandate change (2026-10-19):** Richer demo dataset seeded through PostingEngine (modified `demo-dataset.ts`, `seed-demo.ts`); golden expectations in `demo.test.ts` / `DEMO_EXPECTED`.

---

## Minor units & tax math

- Amounts stored as **integer minor units** (BIGINT in DB; safe integer checks on JSON transport).
- Rounding: `money.test.ts`, `tax-math.test.ts`, `fx.test.ts` (half-up / bps).
- **Gap:** Invoice/bill lines use **tax rate bps** on the form, not persisted tax code references on every line — tax reporting may not match code-level configuration until G-017 closed.

---

## Reporting integrity

Reports (TB, P&L, BS, GL, aging, tax summary) are implemented as **pure functions** over posted line sets in TypeScript (`reporting.test.ts`, `reporting-extended.test.ts`).

| Claim | Status |
|-------|--------|
| Golden fixtures balance | **Verified** (unit) |
| Demo TB matches canonical set | **Verified** (unit): 6,755,000 minor units total debits = credits |
| Production UI equals SQL `SUM()` on remote DB | **Not verified** (G-011) |

---

## Automated test evidence

| Concern | Evidence | Live DB? |
|---------|----------|----------|
| Balanced lines | `posting-engine.test.ts`, `money.test.ts` | No |
| Sales invoice / credit posting shapes | `sales/posting.test.ts` | Mocked RPC |
| Purchase bill / payment shapes | `purchases/posting.test.ts` | Mocked RPC |
| TB / P&L / BS / aging | `reporting*.test.ts` | Pure |
| Demo ledger golden | `demo.test.ts` | Pure |
| Period lock error path | Unit mocks SQL message | No |
| Transaction rollback on failure | SQL single-function transaction | **Not harnessed** |

**Summary:** **124** unit tests green (2026-10-19). Integrity **design is strong**; **operational proof** for production accounting SaaS remains **incomplete** without staging integration tests.

---

## Remaining live-proof gaps (checklist)

1. Call `post_journal` with unbalanced payload → must fail with no partial rows.
2. Two parallel posts with same idempotency key → exactly one journal.
3. Post on locked period → reject.
4. Authorise invoice → receipt → TB movement matches expected accounts.
5. Demo reset on deployed app → TB matches `DEMO_EXPECTED`.
6. `reverse_journal` → original marked reversed; TB net zero effect.

---

## Related documents

- [LINKBOOKS_FEATURE_CATALOG.md](./LINKBOOKS_FEATURE_CATALOG.md)
- [LINKBOOKS_GAP_REGISTER.md](./LINKBOOKS_GAP_REGISTER.md)
- [LINKBOOKS_SECURITY_REVIEW.md](./LINKBOOKS_SECURITY_REVIEW.md)
- [ARCHITECTURE_MVP.md](./ARCHITECTURE_MVP.md)
