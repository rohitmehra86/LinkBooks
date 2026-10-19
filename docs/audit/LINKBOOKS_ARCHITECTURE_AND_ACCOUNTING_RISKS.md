# LinkBooks — Architecture and Accounting Risks

**Audit date:** 19 Oct 2026  
**Mode:** Evidence-based risk register from repository inspection only.

---

## 1. Critical — Accounting integrity

| ID | Risk | Why it matters | Evidence | Mitigation direction |
|----|------|----------------|----------|----------------------|
| A1 | **No general ledger** | Cannot produce trial balance, P&L, or balance sheet from postings | No CoA/journal tables in migrations or `types.ts`; `accounting.tsx` states engine not enabled | Design double-entry schema before Sales/Purchases UI polish |
| A2 | **No double-entry validation** | Unbalanced books, silent errors | No journal_line model or DB constraint `SUM(debit)=SUM(credit)` | Enforce at DB + posting service |
| A3 | **No posting / reverse / adjust workflow** | Auditability and corrections impossible | No status fields, no reverse-of links | Immutable posted journals + reversing entries |
| A4 | **Documents cannot post** | Invoices/bills would be cosmetic | Sales/Purchases explicitly defer posting | Documents must create balanced journals atomically |
| A5 | **Reports without ledger** | Misleading “report” UI | `reports.tsx` static names only | Hide or gate reports until TB works |
| A6 | **`is_demo` engine split risk** | Fake math for demo vs real companies | `AGENTS.md` forbids gating posting by `is_demo`; no engine yet | Keep rule; seed demo **data**, not alternate code paths |
| A7 | **FY fields without periods** | Locking/reporting dates undefined | `companies.fiscal_year_end_*` only | Add `accounting_periods` + lock flags |
| A8 | **Currency / rounding** | Multi-currency and money precision errors | `base_currency` on company; no money type standards in ledger | Use integer minor units or `numeric` with fixed scale; document rounding |

---

## 2. Critical — Security and tenancy

| ID | Risk | Why it matters | Evidence | Mitigation direction |
|----|------|----------------|----------|----------------------|
| S1 | **Service-role bypass** | Full data access if leaked or client-imported | `src/integrations/supabase/client.server.ts` | Bundle-guard; never `VITE_*`; audit imports |
| S2 | **Client auth gate only** | Users could hit routes without server check on data | `_authenticated/route.tsx` + `AGENTS.md` | All reads/writes via RLS + `requireSupabaseAuth` |
| S3 | **Phase 2 UI vs RLS mismatch** | Users see fake orgs; real data isolation untested in UI | Hard-coded switcher `AppShell.tsx`; APIs unused | Wire switcher; isolation test 2×2 |
| S4 | **Invitation / role escalation** | Invite acceptance / role changes need careful RLS | `company_invitations`, `role_permissions` present | Complete invite flow with policies review |
| S5 | **Historical secret exposure** | `.env` was tracked upstream historically | Prior session gitignore/untrack | Rotate Supabase keys if ever public |
| S6 | **Missing storage policies** | Future file uploads (receipts) easy to misconfigure | No buckets in migrations | Bucket-per-company + RLS before uploads |
| S7 | **Cron secret surface** | Misconfigured cron could call privileged paths | `cron-auth.ts` / `LOVABLE_CRON_SECRET` | Keep cron routes narrow; no finance mutations without auth |

---

## 3. High — Architecture / delivery

| ID | Risk | Evidence | Mitigation |
|----|------|----------|------------|
| D1 | **TypeScript build broken** | `accounting.tsx` missing import; `company-empty` optional props | Fix before any release gate |
| D2 | **No automated tests** | No test scripts | Unit (posting), RLS integration, E2E happy paths |
| D3 | **Lint debt (433)** | `npm run lint` | Format CI; fail on errors only initially |
| D4 | **Requirements doc missing** | Scope MD not in repo | Import and version as product SSR |
| D5 | **Migration workflow manual** | Applied via SQL editor for new project | Formalize `supabase db push` / CI |
| D6 | **Single Supabase project for all envs** | Ops not documented for staging | Separate staging project before real money |
| D7 | **Vercel Auth redirect config** | Friend cannot complete email flow without URLs | Document in `docs/VERCEL.md` / Supabase Auth settings |
| D8 | **Lovable ↔ Cursor dual edit** | `AGENTS.md` history rewrite warning | Avoid force-push; sync via PR |

---

## 4. Medium — Product / UX honesty

| ID | Risk | Evidence | Mitigation |
|----|------|----------|------------|
| U1 | **Demo chrome implies real multi-org** | “Demo Company Ltd” / “Northgate Consulting” fake menu | Replace with live `getCompanyContext` list |
| U2 | **Settings “save” toast without persistence** | Settings demo-only behavior | Wire `updateCompany` or remove Save |
| U3 | **Search / New / Notifications inert** | `AppShell` controls | Disable until implemented |
| U4 | **AI page implies capability** | `ai-assistant.tsx` | Label as preview / hide until backend |

---

## 5. Architecture snapshot (as-is)

```
Browser (Vite / TanStack Start)
  ├─ Auth pages → Supabase Auth (anon/publishable)
  ├─ AppShell (hard-coded org) → empty module pages
  └─ Server functions (company/profile)
        ├─ User-scoped Supabase client (RLS)
        └─ Admin client (service role) — high risk if misused

Postgres (Supabase)
  ├─ profiles, companies, members, invitations, tax_settings, role_permissions
  └─ [MISSING] accounts, journals, lines, documents, bank, audit_log
```

**Target architecture (recommended):** keep Supabase; add ledger as first-class domain with RLS on `company_id`; post documents via SECURITY DEFINER or constrained RPCs that enforce balance; never compute reports from document tables alone.

---

## 6. Highest-priority blockers before production

1. **A1–A5** — Build and prove the accounting engine.  
2. **S1–S3** — Prove tenancy isolation with wired UI + RLS tests.  
3. **D1–D2** — Green `tsc` + minimum test suite.  
4. **D4** — Import full product scope standard.  
5. **D6–D7** — Staging + Auth/env ops for real users.

Any “go live” marketing of LinkBooks as bookkeeping software before A1–A5 is a **data-integrity and trust failure**, not a cosmetic gap.
