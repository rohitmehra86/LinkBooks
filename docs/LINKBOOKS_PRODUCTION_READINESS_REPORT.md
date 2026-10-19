# LinkBooks — Production Readiness Verification Report

| Field | Value |
|-------|-------|
| **Date (UTC)** | 2026-10-19T13:44Z |
| **Branch inspected** | Working tree on `feature/foundational-production-readiness` (uncommitted feature work present) |
| **Verifier method** | Commands run locally + static inspection of `src/`, `supabase/migrations/`, docs |
| **Environments exercised** | Local only. **No staging/production Supabase or Vercel smoke run.** No migrations applied; no destructive ops. |
| **Overall verdict** | **NOT PRODUCTION READY** |

### Critical blockers (must clear before real client money)

1. **No live tenant/RLS isolation test** against a real Supabase project (2-user cross-tenant denial).
2. **No end-to-end workflow tests** (UI → DB → journals → reports) in an isolated staging database.
3. **Migration apply status unknown** for any shared remote project; several additive migrations exist but were not applied in this verification.
4. **No CI gate** (`.github/workflows` absent) enforcing `tsc` / lint / test / build.
5. **Lint currently fails** (`npm run lint` → 1416 errors, mostly Prettier) — blocks a strict lint CI gate.
6. **Backup/restore drill not evidenced**; monitoring/error reporting not configured in-repo.
7. **SECURITY_CHECKLIST.md** still lists unchecked go-live items (staging≠prod, invites, MFA, live RLS test, restore drill).

This report does **not** declare LinkBooks production ready. Scope was not silently reduced to make the checklist pass.

---

## Phase 1 — Build and code quality

| Criterion | Status | Evidence / command | Severity | Impact | Corrective action | Manual review? |
|-----------|--------|-------------------|----------|--------|-------------------|----------------|
| Production build | **Pass** | `npm run build` → exit 0; Nitro/Vercel output under `.vercel/output`; “built in ~812ms” | — | Deployable artifact builds | Keep green in CI | No |
| TypeScript | **Pass** | `npx tsc --noEmit` / `npm run typecheck` → exit 0 | — | Type safety for compile | Add CI job | No |
| Automated unit tests | **Pass** | `npx vitest run` → **18 files, 124 tests, all passed** | — | Pure-function / mocked RPC coverage only | Keep; add integration suite | No |
| Lint | **Fail** | `npm run lint` → exit 1; **1416 errors, 6 warnings** (≈1414 Prettier auto-fixable; also `prefer-const`, `no-control-regex`) | Medium | CI cannot gate on lint today; formatting debt | Run `eslint . --fix` + fix remaining; enforce in CI | Yes (decide lint policy) |
| Dependency vulnerabilities (prod) | **Pass** | `npm audit --omit=dev` → **0 vulnerabilities** | — | Runtime deps clean at audit time | Re-run periodically | No |
| Dependency vulnerabilities (incl. dev) | **Fail** (dev tooling) | `npm audit` → **3 issues** (2 critical, 1 moderate) in **vitest / tinypool / @vitest/mocker** | Medium for CI/dev machines; **Low for production runtime** if Vitest UI not exposed | Dev RCE/path traversal if Vitest UI misused | `npm audit fix` / upgrade vitest ≥ patched; never expose Vitest UI in prod | Yes |
| Distinguish new vs pre-existing | **Pass** (documented) | Build/tsc/tests green. Lint mass-fail is predominantly Prettier across many files (incl. older `auth.tsx`, `reset-password.tsx`) → treat as **pre-existing / accumulated**, not a single new regression from one module. Vitest audit issues are **devDependency**. | — | — | Separate “format baseline” PR from feature work | Yes |

---

## Phase 2 — Accounting tests

Legend: **Pass** = automated evidence in this run; **Partial** = unit/mock/SQL design only; **Not Tested** = no automated or live proof; **Fail** = broken or contradictory.

| Criterion | Status | Evidence / command | Severity | Impact | Corrective action | Manual review? |
|-----------|--------|-------------------|----------|--------|-------------------|----------------|
| Balanced journal enforcement | **Pass** (client) / **Partial** (DB) | `src/lib/accounting/posting-engine.test.ts`, `money.test.ts`; SQL `post_journal` sums debits/credits (`20261019140000_accounting_engine.sql`) | High if DB untested live | Unbalanced post could corrupt books if RPC bypassed | Live integration test calling `post_journal` | Yes |
| Transaction rollback | **Partial** | Postgres function abort on exception (single transaction). **No live harness** proving mid-insert failure rolls back | Critical if wrong | Partial journals | Staging test: force failure after header insert | Yes |
| Duplicate posting prevention | **Partial** | SQL `UNIQUE (company_id, idempotency_key)` + early return; unit simulates duplicate key. **No concurrent live race test** | High | Double-post risk under concurrency | Concurrent integration test | Yes |
| Invoice & bill lifecycle | **Partial** | `sales/posting.test.ts`, `purchases/posting.test.ts` (line balance / mocked RPC); UI routes exist | High | Wrong AR/AP | DB-backed lifecycle tests (draft→authorise→pay→void) | Yes |
| Partial & full payments | **Partial** | `sales/line-helpers.test.ts` outstanding/status; purchase payment line math | High | Misstated open balances | Integration: partial then full receipt/payment | Yes |
| Credit notes & refunds | **Partial** | Sales/purchase credit posting unit tests; demo dataset includes SCN/PCN | High | Wrong revenue/AP | Live credit + allocation tests | Yes |
| Bank transfers & reconciliation | **Partial** | Transfer reject same-account (unit); CSV import + rules tests; reconcile UI exists; **no live reconcile→ledger E2E** | High | Bank GL drift | Staging reconcile session test | Yes |
| Period locks & reversals | **Partial** | SQL rejects non-open periods; immutability triggers; unit mocks locked-period error; reverse journal RPC present | Critical | Post into locked period / edit history | Live lock→post deny; reverse→TB | Yes |
| Trial Balance equality | **Pass** (pure) | `reporting.test.ts`, `reporting-extended.test.ts`, `demo.test.ts` (TB balances; demo TB = 6,755,000) | High if reports diverge from DB | Misleading statements | Compare API TB to SQL aggregates on staging | Yes |
| P&L and Balance Sheet correctness | **Pass** (pure) | Same reporting/demo tests; BS equation holds on golden + demo sets | High | Wrong equity/profit | Staging golden company fixture | Yes |
| Decimal precision & tax rounding | **Pass** (unit) | `money.test.ts`, `tax-math.test.ts`, `fx.test.ts` (half-up / minor units) | High | Rounding drift | Keep; add currency edge cases (JPY/KWD) in integration | No |
| Demo ledger reconciles to known set | **Pass** (unit) | `src/lib/demo/demo.test.ts` vs `DEMO_EXPECTED` | Medium | Demo trust | After migrate: Open Demo / reset & compare snapshot | Yes |

**Accounting phase summary:** Strong **unit/pure-function** coverage and SQL design for the posting engine. **Insufficient for production accounting** without live DB integration proving RPC balance, idempotency races, locks, and document lifecycles.

---

## Phase 3 — Security tests

| Criterion | Status | Evidence / command | Severity | Impact | Corrective action | Manual review? |
|-----------|--------|-------------------|----------|--------|-------------------|----------------|
| Organisation / tenant isolation | **Partial** | Contract tests (`tenant-isolation.test.ts`, `cross-cutting.test.ts`); RLS policies on company tables in migrations. **Live 2-user test Not Tested** | **Critical** | Cross-tenant data leak | Staging: User A/B membership isolation script | **Yes** |
| RLS on exposed data | **Partial** | Migrations enable RLS + policies for accounting, sales, purchases, banking, tax, firm, AI, settings extras | **Critical** if misapplied | Direct PostgREST leak | `supabase db` policy audit + live queries as anon/authenticated | **Yes** |
| Role & permission enforcement | **Partial** | `permissions.ts` matrix + unit tests; server `assertCompanyPermission` / `has_company_permission` RPC | High | Privilege escalation | Live matrix test per role | Yes |
| Authentication boundaries | **Partial** | App pages under `_authenticated`; server fns use `requireSupabaseAuth`. Client gate is UX-only (`AGENTS.md`) | High | Unauthenticated API abuse | Confirm every mutating server fn has middleware | Yes |
| Server-side validation | **Partial** | UUID/company validators; posting balance checks; AI sanitize | Medium | Bad input / injection | Expand fuzz tests; Zod on remaining inputs | No |
| Storage access policies | **Not Tested** / **N/A (MVP)** | No Storage bucket migrations / `storage.from` usage found for documents; logo is URL-only | Medium if Storage added later | File exfiltration | When Storage added: bucket RLS + tests | Yes |
| Secret handling | **Pass** (code) | `.env.example` names only; `env-safety` blocks `VITE_*` service/AI secrets; AI keys server-only | **Critical** if violated in deploy | Key leak | Verify Vercel env: no `VITE_` secrets; rotate if ever exposed | **Yes** |
| Input validation / common web vulns | **Partial** | Sanitization for AI prompts; no dedicated XSS/CSRF suite; React escapes by default | Medium–High | XSS/injection | Security review + CSP headers on Vercel | **Yes** |
| Audit of admin/money actions | **Partial** | `audit_events` + `record_audit_event`; settings/AI/demo write audits | Medium | Forensics gap | Confirm every post/lock/role change audited in staging | Yes |

---

## Phase 4 — End-to-end tests

| Criterion | Status | Evidence / command | Severity | Impact | Corrective action | Manual review? |
|-----------|--------|-------------------|----------|--------|-------------------|----------------|
| Realistic workflow E2E (UI→DB→journal→report) | **Not Tested** | No Playwright/Cypress suite; no staging credentials used | **Critical** | Undetected workflow breaks | Add staging E2E: create invoice→authorise→receipt→TB | **Yes** |
| Isolated non-production data only | **Pass** (this run) | Verification used local unit tests only; no remote mutate | — | — | Keep policy; use staging project | No |
| Demo seed → reports path | **Not Tested** (live) | Code path exists (`seedDemoCompanyData` + `getDemoLedgerSnapshot`); requires migrations + Open Demo | High | Demo AC unmet live | After migrate: reset demo; assert `matchesCanonicalDemoExpected` | Yes |

---

## Phase 5 — Vercel and Supabase release readiness

| Criterion | Status | Evidence / command | Severity | Impact | Corrective action | Manual review? |
|-----------|--------|-------------------|----------|--------|-------------------|----------------|
| Production build & deploy config | **Partial** | `npm run build` emits `.vercel/output` (TanStack Start / Nitro). No `vercel.json` in repo; Lovable/Vercel project assumed external | Medium | Misconfigured routes/env | Document Vercel project settings; preview vs prod | Yes |
| Required env var **names** (no values printed) | **Pass** | Documented in `docs/ENV_AND_DEPLOYMENT.md` / `.env.example`: `VITE_SUPABASE_*`, `SUPABASE_*`, `SUPABASE_SERVICE_ROLE_KEY`, `AI_API_KEY`, `LOVABLE_CRON_SECRET`, optional AI limits | Critical if wrong names | App/auth failure | Confirm set in Vercel Production + Preview | **Yes** |
| Database migration sequence | **Partial** (in-repo) / **Blocked** (remote) | 12 files under `supabase/migrations/` ordered by timestamp through `20261019220000_*`. **Apply status on remote: unknown; not applied in this verification** | **Critical** | Schema drift / missing tables | Apply to **staging first** with approval; never prod without approval | **Yes** |
| Backup & restore plan | **Fail** (not evidenced) | Docs mention PITR/forward-fix; `SECURITY_CHECKLIST` unchecked “restore drill” | **Critical** | Irrecoverable data loss | Enable PITR/backups; document + run one restore drill | **Yes** |
| Monitoring & error reporting | **Fail** / **Not Tested** | No Sentry/Datadog/etc. wiring found in app | High | Blind outages | Add error tracking + uptime checks | Yes |
| Rollback procedure | **Partial** | Documented preference: forward-fix migration / PITR (`ENV_AND_DEPLOYMENT.md`). No runbook rehearsal | High | Failed release stuck | Write ops runbook; rehearse on staging | Yes |
| Auth & redirect configuration | **Partial** | Docs list Site URL + `/auth`, `/reset-password`. **Not verified against live Supabase dashboard** | High | Login/reset broken in prod | Checklist against each deployed host | **Yes** |
| Smoke tests vs intended deployment | **Not Tested** | No deployment smoke executed (by design / no approval) | **Critical** | Ship broken site | Staging smoke: auth, company switch, post journal, TB | **Yes** |
| CI/CD | **Fail** | No `.github/workflows` (or equivalent) found | High | Regressions merge unchecked | Add CI: typecheck, test, build; decide lint gate | Yes |

### Migration inventory (in-repo order)

1. `20260930110603_*` / `20260930110624_*` — foundation  
2. `20261003014249_*` / `20261003014326_*` — company guards  
3. `20261019120000_permissions_expand_and_indexes.sql`  
4. `20261019140000_accounting_engine.sql`  
5. `20261019160000_purchases_module.sql`  
6. `20261019180000_sales_banking_contacts.sql`  
7. `20261019190000_reports_tax_accountant.sql`  
8. `20261019200000_cross_cutting_settings_fx_demo.sql`  
9. `20261019210000_ai_assistant.sql`  
10. `20261019220000_demo_company_guards.sql`  

**Do not apply to production without explicit approval.**

---

## Honest feature gaps (not checklist gaming)

| Area | Status |
|------|--------|
| Products & Services | Shell — labelled unfinished |
| Email invites | Not connected |
| Bank feeds | No fake “connected” status; CSV path only |
| AI | Honest “not configured” without `AI_API_KEY` |
| Help | Placeholder FAQ |
| Notification toggles | Disabled placeholders |

---

## Commands run (this verification)

```bash
npx tsc --noEmit                          # exit 0
npx vitest run                            # 124 passed
npm run build                             # exit 0
npm run lint                              # exit 1 (1416 errors)
npm audit --omit=dev                      # 0 vulnerabilities
npm audit                                 # 3 vulns in vitest toolchain
```

**Not run (blocked / policy):** remote `supabase db push`, production deploy, destructive reset against shared data, live 2-user RLS, Playwright E2E, Vercel production smoke.

---

## Final recommendation

| Question | Answer |
|----------|--------|
| Is LinkBooks production ready for real customer money? | **No** |
| Can development / Demo exploration continue on staging? | **Yes**, after migrations are applied to an **isolated staging** project and Demo reseed verified |
| Minimum before “accounting production” claim | Clear all **Critical** rows above: live RLS, staging E2E golden path, migrations applied+verified, backups+restore drill, auth URL smoke, CI green (at least tsc+test+build) |

**Manual review required** for: staging env strategy, lint policy, Vitest upgrade, Supabase dashboard auth URLs, Vercel env names, and approval to apply any migration remotely.
