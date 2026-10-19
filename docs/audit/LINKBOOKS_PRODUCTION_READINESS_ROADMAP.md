# LinkBooks — Production Readiness Roadmap

**Audit date:** 19 Oct 2026  
**Constraint:** This document proposes order of work only. **No fixes were implemented** in the audit.

**Baseline:** Requirements MD not found in repo — import it as **Phase 0** before treating this roadmap as final.

---

## Verdict

LinkBooks is **not production-ready** as an accounting SaaS. It is a **UI shell + Auth + company tenancy foundation**. Ship a production *accounting* product only after Phase 3+ below.

---

## What is already working

- Supabase Auth (sign-in / sign-up / password recovery UI)
- Authenticated app chrome and empty module pages
- Profiles CRUD (server functions)
- Company / membership / tax_settings / invitations **schema + RLS helpers**
- Server functions for company context, create, demo, members list
- Vercel deploy path for the UI
- Honest empty-state messaging on ledger modules

## What is incomplete or only visual

- Company switcher, onboarding, settings persistence
- Sales, Purchases, Banking, Contacts, Products, Reports, AI
- Entire chart of accounts / journals / posting / reports engine
- Firm/client practice tooling
- Automated tests, clean TypeScript build, staging ops

## Must correct before production

1. Authoritative product scope in-repo  
2. Green production build (`tsc` + deploy)  
3. Wired Phase 2 tenancy UI + isolation proof  
4. Double-entry ledger with RLS and posting invariants  
5. At least one document type posting end-to-end (e.g. sales invoice)  
6. Trial Balance + P&L + Balance Sheet from posted journals  
7. Audit trail, period locks, backup/recovery, staging env  
8. Automated regression tests for posting and RLS  

---

## Recommended implementation order

### Phase 0 — Align requirements (1–2 days)

| Work | Depends on |
|------|------------|
| Add “Full Product Scope…” MD under `docs/` | File from author |
| Diff scope vs this audit; update matrix | Scope MD |
| Decide MVP cut (e.g. UK VAT SMB vs firm portal) | Product owner |

**Exit:** Single SSR for MVP vs later phases.

---

### Phase 1 — Stabilize platform (3–5 days)

| Work | Depends on | Evidence target |
|------|------------|-----------------|
| Fix `accounting.tsx` missing import + `company-empty` types | — | `tsc --noEmit` passes |
| Lint gate (errors only) in CI | — | `npm run lint` CI job |
| Confirm Vercel env: URL, publishable, **service role server-only** | Deploy | Smoke load `/auth` |
| Supabase Auth redirect URLs for Vercel prod + preview | Project settings | Email confirm works |
| Document backup/recovery (Supabase PITR / dumps) | Plan tier | `docs/ops` note |

**Exit:** Green build; friend can sign in on Vercel.

---

### Phase 2 — Finish tenancy product surface (1–2 weeks)

| Work | Depends on | Evidence target |
|------|------------|-----------------|
| Onboarding: create company or open demo | Phase 1 | First login lands in real company |
| Wire `AppShell` switcher to `getCompanyContext` / `setActiveCompany` | APIs exist | No hard-coded orgs |
| Settings: load/save via `getCompanyDetails` / `updateCompany` | — | Persist name/currency/FY |
| Members list + invite UI | `listCompanyMembers`, invitations | Invite email accept flow |
| Enforce `is_demo` only for reset/billing/indicators | `AGENTS.md` | Code review checklist |
| Isolation tests: User A cannot read Company B | RLS | Integration test suite |

**Exit:** Multi-company UX matches DB; 2×2 isolation test green.

---

### Phase 3 — Accounting engine core (3–6 weeks) — **critical path**

| Work | Depends on | Evidence target |
|------|------------|-----------------|
| Schema: `accounts`, `journals`, `journal_lines`, `accounting_periods`, `audit_events` | Phase 2 company_id | Migrations + RLS |
| CoA seed templates by country | Schema | Demo + real company share engine |
| Manual journal create/post with balance constraint | Schema | Unbalanced post rejected |
| Reverse / void posted journals | Posting | Reversing entry links |
| Period open/lock | Periods table | Locked period rejects post |
| Money precision + base currency | Company | Documented rules |
| CoA / Journals / GL UI wired to data | APIs | Replace empty states |

**Exit:** Trial Balance from posted manual journals only.

**Do not** start polished Sales UI before CoA + journal post works.

---

### Phase 4 — Operational documents (4–8 weeks)

| Work | Depends on | Evidence target |
|------|------------|-----------------|
| Contacts (customers/suppliers) | Phase 3 | CRUD + RLS |
| Sales invoices + credit notes → AR journals | Contacts + CoA | Post creates balanced JE |
| Purchases / bills → AP journals | Same | Same |
| Payments / allocation | Invoices/bills | Clears balances |
| Banking accounts + manual bank lines | CoA | Reconcile later |
| Products & Services optional for invoice lines | CoA | — |
| Tax codes applied on lines | `company_tax_settings` | VAT math tests |

**Exit:** One company can invoice, bill, pay, and TB still balances.

---

### Phase 5 — Reports and tax (2–4 weeks)

| Work | Depends on | Evidence target |
|------|------------|-----------------|
| Trial Balance, P&L, Balance Sheet | Posted journals | Numbers match manual check |
| Date ranges / FY boundaries | Periods | Locked period reports stable |
| Tax summary / draft return (MVP) | Tax settings | Golden-file fixtures |

**Exit:** Reports page computes; no static placeholders for core three.

---

### Phase 6 — Hardening & ops (ongoing, gate before paid users)

| Work | Depends on |
|------|------------|
| Staging Supabase project + migration CI | Phase 1+ |
| Monitoring (Sentry or equivalent) | Deploy |
| Dependency audit (`npm audit`) + patch policy | — |
| Backup restore drill | Ops |
| Security review of service-role usage | S1 |
| Performance indexes on `company_id` + journal date | Load tests |
| Firm/client portal (if in scope) | After SMB MVP |
| AI assistant (read-only over reports first) | After Phase 5 |

---

## Dependency graph (simplified)

```
Phase 0 Scope
    → Phase 1 Build/Auth/Ops
        → Phase 2 Tenancy UI + RLS tests
            → Phase 3 Ledger (BLOCKS everything financial)
                → Phase 4 Documents + Banking
                    → Phase 5 Reports + Tax
                        → Phase 6 Hardening / Firm / AI
```

---

## Tests needed to verify completion

| Layer | Minimum suite |
|-------|----------------|
| Unit | Journal balance validator; tax calc; money rounding |
| DB / RLS | Migration apply on fresh DB; member isolation; non-member denied; last-owner protect |
| Integration | `create_company` → CoA seed → post journal → TB totals |
| Document E2E | Create invoice → post → payment → AR = 0 |
| Report golden | Fixed seed → P&L / BS / TB match fixtures |
| Auth E2E | Sign-up, confirm, reset password on preview URL |
| Regression | `tsc --noEmit`, lint errors, `npm run build` on CI |
| Ops | Restore from backup into staging; smoke auth + TB |

**Rule:** A feature may be marked **Implemented and tested** in the matrix only after the relevant tests above exist and pass in CI.

---

## Suggested near-term sprint (post-audit approval)

1. Drop scope MD into `docs/`  
2. Fix TypeScript errors (no feature work)  
3. Wire company switcher + onboarding to existing server functions  
4. Write RLS isolation tests  
5. Spec ledger schema in a design ADR under `docs/` (still no code until approved)

---

## Document index

| Deliverable | Path |
|-------------|------|
| Current state | `docs/audit/LINKBOOKS_CURRENT_STATE_AUDIT.md` |
| Feature matrix | `docs/audit/LINKBOOKS_FEATURE_IMPLEMENTATION_MATRIX.md` |
| Risks | `docs/audit/LINKBOOKS_ARCHITECTURE_AND_ACCOUNTING_RISKS.md` |
| This roadmap | `docs/audit/LINKBOOKS_PRODUCTION_READINESS_ROADMAP.md` |

**No application code, schemas, or deployments were modified to produce these documents.**
