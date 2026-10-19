# LinkBooks — Feature Catalog (Owner Audit)

| Field | Value |
|-------|-------|
| **Date** | 2026-10-19 |
| **Supersedes** | Ad-hoc nav/route notes; informal “done” claims in chat |
| **Evidence** | Repo `src/`, `supabase/migrations/`, `npx vitest run` (124 passed), 54 files under `src/routes/_authenticated/` |
| **Remote DB** | Supabase project `ipxflpzfcqwtenodbxwc` — eight `20261019*` migrations **applied** (owner-verified; not re-run in this doc pass) |
| **Deploy** | Friend demo: https://linkbooks-navy.vercel.app (Demo Company only; not commercial production) |

## Status legend

| Status | Meaning |
|--------|---------|
| **Complete and verified** | Code + unit/golden tests; live proof where stated |
| **Implemented but incompletely verified** | Real code paths; missing live E2E / staging tie-out |
| **Partially implemented** | Core flows exist; depth, edge cases, or integrations missing |
| **UI-only or mock** | Route/shell without ledger or persistence |
| **Missing** | Not built |
| **Blocked** | Blocked by process, evidence, or external dependency |

## Ledger impact legend

| Code | Meaning |
|------|---------|
| **L** | Posts via `PostingEngine` → `post_journal` RPC |
| **R** | Reads posted `journal_lines` / reports only |
| **M** | Master data; may not post alone |
| **—** | No ledger effect |

---

## Platform & shell

| Module | Nav path | Status | Ledger | Tests / evidence |
|--------|----------|--------|--------|------------------|
| Auth (sign-in, session gate) | `/auth`, `/forgot-password`, `/reset-password` | Implemented but incompletely verified | — | Routes + `requireSupabaseAuth`; live redirect URLs not evidenced |
| Authenticated app shell | `/_authenticated/*` (54 route files) | Implemented but incompletely verified | — | `src/lib/nav.ts` top-level nav |
| Dashboard | `/` | Implemented but incompletely verified | R | Ledger widgets when data exists |
| Onboarding | `/onboarding` | Implemented but incompletely verified | M | Company create + demo open |
| Profile | `/profile` | Partially implemented | M | Basic profile UI |

---

## Sales

| Feature | Nav path | Status | Ledger | Tests / evidence |
|---------|----------|--------|--------|------------------|
| Overview | `/sales` | Implemented but incompletely verified | R | Route |
| Invoices (create, authorise, list, detail) | `/sales/invoices`, `/sales/invoices/new`, `/sales/invoices/$invoiceId` | Implemented but incompletely verified | L | `sales/posting.test.ts`, `line-helpers.test.ts` |
| Quotes | `/sales/quotes` | Partially implemented | — / draft only | Routes; no full quote→invoice E2E |
| Receipts (customer payments) | `/sales/receipts` | Implemented but incompletely verified | L | Posting helpers + routes |
| Credit notes | `/sales/credit-notes` | Implemented but incompletely verified | L | `sales/posting.test.ts` |
| Recurring invoices | `/sales/recurring` | Partially implemented | L (manual generation) | No scheduler/cron evidenced |
| Customer statements | `/sales/statements` | Partially implemented | R | UI; no email delivery |
| Customers (contact subset) | `/sales/customers` | Implemented but incompletely verified | M | Contacts integration |

**Gap (document lines):** Tax on lines uses **rate bps** fields, not selectable **tax codes** from Tax module → see Gap Register.

---

## Purchases

| Feature | Nav path | Status | Ledger | Tests / evidence |
|---------|----------|--------|--------|------------------|
| Overview | `/purchases` | Implemented but incompletely verified | R | Route |
| Bills | `/purchases/bills` | Implemented but incompletely verified | L | `purchases/posting.test.ts`, `line-math.test.ts` |
| Expenses | `/purchases/expenses` | Implemented but incompletely verified | L | Same |
| Supplier payments | `/purchases/payments` | Implemented but incompletely verified | L | Posting tests |
| Purchase credit notes | `/purchases/credit-notes` | Implemented but incompletely verified | L | Posting tests |
| Purchase orders | `/purchases/orders` | Partially implemented | M / limited L | Routes; PO→bill depth not E2E-proven |
| Recurring bills | `/purchases/recurring` | Partially implemented | L (manual) | No automated runner |
| Employee expense claims | `/purchases/employee-expenses` | Partially implemented | L | UI + schema; approval depth unverified live |
| Supplier statements | `/purchases/statements` | Partially implemented | R | No email |
| Suppliers | `/purchases/suppliers` | Implemented but incompletely verified | M | Contacts |

---

## Banking

| Feature | Nav path | Status | Ledger | Tests / evidence |
|---------|----------|--------|--------|------------------|
| Bank accounts | `/banking` | Implemented but incompletely verified | M | |
| Transactions | `/banking/transactions` | Implemented but incompletely verified | R / L on categorise | |
| CSV import | `/banking/import` | Implemented but incompletely verified | M | `banking/csv-import.test.ts` |
| Transfers | `/banking/transfers` | Implemented but incompletely verified | L | Unit reject same-account |
| Reconcile | `/banking/reconcile` | Implemented but incompletely verified | L | No live reconcile→TB E2E |
| Bank rules | `/banking/rules` | Implemented but incompletely verified | M | |
| **Live bank feeds** | — | **Missing** | — | Honest non-connected |

---

## Contacts

| Feature | Nav path | Status | Ledger | Tests / evidence |
|---------|----------|--------|--------|------------------|
| Contact list | `/contacts` | Implemented but incompletely verified | M | |
| Contact detail | `/contacts/$contactId` | Implemented but incompletely verified | M | Live tenant isolation **not** proven |

---

## Accounting

| Feature | Nav path | Status | Ledger | Tests / evidence |
|---------|----------|--------|--------|------------------|
| Chart of accounts | `/accounting` | Partially implemented | M | **Read-only seeded CoA**; no CoA CRUD UI |
| Manual journals | `/accounting` | Implemented but incompletely verified | L | `posting-engine.test.ts`, SQL `post_journal` |
| Accounting periods | `/accounting` | Implemented but incompletely verified | M | Period lock in SQL; live deny not evidenced |
| Posting engine (shared) | (all modules) | **Complete and verified** (design + unit) | L | `posting-engine.ts`, `20261019140000_accounting_engine.sql` |

---

## Reports

| Feature | Nav path | Status | Ledger | Tests / evidence |
|---------|----------|--------|--------|------------------|
| Trial Balance | `/reports` | Implemented but incompletely verified | R | `reporting.test.ts`, `reporting-extended.test.ts` |
| P&L | `/reports` | Implemented but incompletely verified | R | Same |
| Balance Sheet | `/reports` | Implemented but incompletely verified | R | Same |
| GL detail | `/reports` | Implemented but incompletely verified | R | Same |
| AR/AP aging | `/reports` | Implemented but incompletely verified | R | Extended reporting tests |
| Tax summary | `/reports` | Implemented but incompletely verified | R | From ledger + tax config |

**Gap:** No staging SQL aggregate tie-out vs UI reports.

---

## Tax

| Feature | Nav path | Status | Ledger | Tests / evidence |
|---------|----------|--------|--------|------------------|
| Rates, codes, accounts UI | `/tax` | Implemented but incompletely verified | M / L (adjustments) | `tax-math.test.ts`, `tax.functions.ts` |
| Period-end tax adjustment journal | `/tax` | Implemented but incompletely verified | L | Posts via PostingEngine |
| Filing / MTD / submissions | — | **Missing** | — | |

---

## Settings & FX

| Feature | Nav path | Status | Ledger | Tests / evidence |
|---------|----------|--------|--------|------------------|
| Organisation, FY, members, roles | `/settings` | Implemented but incompletely verified | M | `permissions.test.ts`, `cross-cutting.test.ts` |
| Document sequences / branding | `/settings` | Partially implemented | M | |
| FX rates | `/settings` | Implemented but incompletely verified | M | `fx.test.ts` |
| Email invites | — | **Missing** | — | |

---

## Demo Company

| Feature | Nav path | Status | Ledger | Tests / evidence |
|---------|----------|--------|--------|------------------|
| Open Demo / badge / reset+reseed | Settings / onboarding | Implemented but incompletely verified | L | **Same engine as production**; `demo.test.ts` vs `DEMO_EXPECTED`; **rich seed** updated in mandate (`demo-dataset.ts`, `seed-demo.ts`) |
| `is_demo` guards (billing, integrations) | Various | Implemented but incompletely verified | — | Must not alter posting rules (`AGENTS.md`) |

---

## Firm & Accountant

| Feature | Nav path | Status | Ledger | Tests / evidence |
|---------|----------|--------|--------|------------------|
| Accountant checklist | `/accountant` | Partially implemented | R | Checklist UI only |
| Firm / client link | `/firm` | Partially implemented | M | Basic UI; firm isolation not live-proven |

---

## AI Assistant

| Feature | Nav path | Status | Ledger | Tests / evidence |
|---------|----------|--------|--------|------------------|
| Chat + suggestions | `/ai-assistant` | Partially implemented | — | `ai.test.ts`; **optional `AI_API_KEY`** |
| Apply suggestion → journal | `/ai-assistant` | Implemented but incompletely verified | L | Requires confirm + permission; **no auto-post** |

---

## Shells & missing modules

| Module | Nav path | Status | Ledger | Notes |
|--------|----------|--------|--------|-------|
| Products & Services | `/products-services` | **UI-only or mock** | — | Explicit empty state: “not fully wired” |
| Help | `/help` | **Partially implemented** | — | Static FAQs; not a support desk |
| Global search / notifications / quick create | (disabled in shell) | **Missing** / stub | — | |
| Attachments / OCR / document storage | — | **Missing** | — | No Storage bucket migrations |
| Inventory | — | **Missing** | — | |
| Payroll | — | **Missing** | — | |
| Fixed assets | — | **Missing** | — | |
| Budgets / projects | — | **Missing** | — | |
| Customer billing / subscriptions | — | **Missing** | — | |
| CI pipeline | — | **Blocked** | — | No `.github/workflows` |

---

## Test inventory (automated)

| Area | File(s) | Count (approx.) |
|------|---------|-----------------|
| Posting / money | `posting-engine.test.ts`, `money.test.ts` | Core engine |
| Sales / purchases | `sales/*`, `purchases/*` | Posting + line math |
| Reporting | `reporting*.test.ts` | TB, P&L, BS, aging |
| Demo golden | `demo.test.ts` | TB = 6,755,000 minor units |
| Tenant contracts | `tenant-isolation.test.ts` | **Not live RLS** |
| Permissions / env | `permissions.test.ts`, `env-safety.test.ts` | |
| Banking CSV | `csv-import.test.ts` | |
| Tax / FX / AI | `tax-math.test.ts`, `fx.test.ts`, `ai.test.ts` | |
| **Total** | 18 files | **124 tests, all green** (2026-10-19 local run) |

---

## Related documents

- [LINKBOOKS_GAP_REGISTER.md](./LINKBOOKS_GAP_REGISTER.md)
- [LINKBOOKS_ACCOUNTING_INTEGRITY.md](./LINKBOOKS_ACCOUNTING_INTEGRITY.md)
- [LINKBOOKS_PRODUCTION_READINESS.md](./LINKBOOKS_PRODUCTION_READINESS.md)
- [LINKBOOKS_RELEASE_DECISION.md](./LINKBOOKS_RELEASE_DECISION.md)
