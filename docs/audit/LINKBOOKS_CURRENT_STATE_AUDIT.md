# LinkBooks — Current State Audit

**Audit date:** 19 Oct 2026  
**Scope:** Repository `/Users/rohitm/paxaris-repos/LinkBooks` (fork `rohitmehra86/LinkBooks`)  
**Mode:** Read-only inspection. No application, schema, or deployment changes made during this audit.  
**Tests run:** `npx tsc --noEmit`, `npm run lint` (evidence below). No E2E or accounting tests exist or were executed.

## Requirements baseline note

The file **"LinkBooks — Full Product Scope and Implementation Standard.md"** was **not found** in the repository, Desktop, Downloads, or a shallow home search.  

**Proxies used as product baseline:**

- `roadmap.md` (Phase 2 company/tenant)
- `.lovable/plan.md` (Phase 2 architecture design)
- Module list supplied in the audit brief (Dashboard, Sales, Purchases, Banking, Contacts, Chart of Accounts, Journals, Reports, Tax, Products & Services, Accountant Tools, Firm/Client, Settings, AI, Demo Company)

**Action required:** Place the authoritative scope document in `docs/` and re-diff this audit against it.

---

## A. Application structure

### Stack (from repo evidence)

| Layer | Evidence |
|-------|----------|
| Language | TypeScript (`typescript` ^5.8.3, `tsconfig.json`) |
| UI | React 19 (`react` ^19.2.0) |
| Routing / SSR | TanStack Router + TanStack Start (`@tanstack/react-router` 1.170.41, `@tanstack/react-start` 1.168.60) |
| Build | Vite 8.1.5 + `@lovable.dev/vite-tanstack-config` 2.25.2; Nitro preset override for Vercel in `vite.config.ts` |
| Styling | Tailwind CSS 4 + Radix/shadcn-style `src/components/ui/*` |
| Data / Auth | `@supabase/supabase-js` ^2.117.2 |
| Forms / validation | `react-hook-form`, `zod` |
| Server RPC | TanStack `createServerFn` in `src/lib/company.functions.ts`, `src/lib/profile.functions.ts` |
| Origin | Lovable-generated (`README.md`, `AGENTS.md`, `.lovable/`) |

### Entry points and routing

| Path | Role |
|------|------|
| `src/router.tsx`, `src/routeTree.gen.ts` | Router generation |
| `src/routes/__root.tsx` | Root layout, meta, error reporting hook |
| `src/routes/_authenticated/route.tsx` | Client session gate (`ssr: false`); redirects to `/auth` |
| `src/routes/auth.tsx` | Sign-in / sign-up |
| `src/routes/forgot-password.tsx`, `reset-password.tsx` | Password recovery |
| `src/start.ts`, `src/server.ts` | Start/SSR server entry |
| `src/components/layout/AppShell.tsx` | Authenticated chrome (nav, fake org switcher) |

**Authenticated page routes** (`src/routes/_authenticated/`):  
`index` (Dashboard), `banking`, `sales`, `purchases`, `contacts`, `products-services`, `accounting`, `reports`, `ai-assistant`, `settings`, `profile`, `help`.

**Navigation source of truth:** `src/lib/nav.ts` (11 app modules + Help).

### Auth / data access pattern

- **UX gate only:** `_authenticated/route.tsx` uses `supabase.auth.getUser()` client-side (`AGENTS.md` documents this deliberately).
- **Server auth:** `src/integrations/supabase/auth-middleware.ts` (`requireSupabaseAuth` pattern for server functions).
- **Browser client:** `src/integrations/supabase/client.ts` (publishable key).
- **Admin client (RLS bypass):** `src/integrations/supabase/client.server.ts` — requires `SUPABASE_SERVICE_ROLE_KEY`; comments warn not to import into client bundles.

### Company tenancy (backend present, UI incomplete)

| Symbol | File | Status |
|--------|------|--------|
| `getCompanyContext` | `company.functions.ts` | Implemented server-side |
| `setActiveCompany` | same | Implemented server-side |
| `createCompany` → RPC `create_company` | same | Implemented server-side |
| `openDemoCompany` → RPC `create_demo_company` | same | Implemented server-side |
| `getCompanyDetails`, `updateCompany`, `listCompanyMembers` | same | Implemented server-side |
| `useActiveCompany` | `hooks/use-active-company.ts` | Hook exists; used by `CompanyEmptyState` only |
| Company switcher / onboarding UI | — | **Not wired** (hard-coded “Demo Company Ltd” in `AppShell.tsx` L156–169) |

### Error / loading / validation

- Loading: `_authenticated` pending spinner; `LoadingState` / `EmptyState` in `components/common/states.tsx`
- Toasts: `sonner` (e.g. settings “demo only” save)
- Recovery: `src/lib/recovery.tsx` (stale asset reload)
- Lovable error reporting: `src/lib/lovable-error-reporting.ts`
- Forms: zod + RHF on auth flows; settings forms are uncontrolled defaults (not persisted)

### Scripts and quality tooling

| Script | Present |
|--------|---------|
| `dev` / `build` / `preview` | Yes |
| `lint` / `format` | Yes |
| `test` / e2e | **No** |

**tsc (`npx tsc --noEmit`) failures observed:**

- `src/components/common/company-empty.tsx` — `exactOptionalPropertyTypes` mismatch
- `src/routes/_authenticated/accounting.tsx` — `CompanyEmptyState` used **without import** (compile error)

**lint:** `npm run lint` reported **433 problems** (majority Prettier auto-fixable; not treated as product proof).

---

## B. Supabase architecture

### Migrations present

| Migration | Purpose |
|-----------|---------|
| `20260930110603_…sql` | `profiles` + RLS + signup trigger |
| `20260930110624_…sql` | (supporting / follow-on — inspect for grants) |
| `20261003014249_…sql` | companies, members, invitations, tax settings, role_permissions, helpers, RLS, `create_company`, `create_demo_company`, guards |
| `20261003014326_…sql` | `shares_company_with` + profile SELECT policy across company peers |

Generated types: `src/integrations/supabase/types.ts` — tables match Phase 2 only (**no** ledger/invoice tables).

### Tables (public)

`profiles`, `companies`, `company_members`, `company_tax_settings`, `company_invitations`, `role_permissions`.

**Missing for accounting product:** chart of accounts, journals/journal lines, invoices, bills, payments, bank accounts/transactions, tax filings, audit_log, fiscal periods, products, contacts as first-class entities, firms/clients, etc.

### RLS / security helpers (Phase 2)

Documented and present in migrations: `is_company_member`, role checks, create-company SECURITY DEFINER path, last-owner protection triggers, `profiles_last_company_guard`.

**Not verified live against production DB in this audit** (no production DB connection per safety rules). Schema evidence is migration + types only.

### Storage / Edge / Cron

- No `supabase/functions/` directory
- No storage bucket migrations found
- `src/integrations/supabase/cron-auth.ts` references `LOVABLE_CRON_SECRET` — Lovable cron auth helper; no scheduled jobs defined in-repo

### Key / secret risks

| Risk | Evidence |
|------|----------|
| Service role client exists | `client.server.ts` — bypasses RLS if misused |
| Service role may be unset on Vercel | Deploy used publishable/URL env; service role not confirmed in audit |
| `.env` historically committed on upstream | Prior session removed tracking; rotate keys if ever public |
| Publishable keys in `VITE_*` | Expected for browser; never put service role in `VITE_*` |

---

## C. Accounting engine

**Status: Not implemented.**

- UI copy in `accounting.tsx` explicitly states: “Engine not yet enabled… No accounts or entries exist for any company yet.”
- No DB tables for accounts, journals, lines, or balances
- No double-entry validation, posting, reversal, period lock, or report generation code
- Sales/Purchases/Banking pages state ledger posting is a later phase
- Reports page lists P&L / Balance Sheet / Trial Balance as **names only** (`reports.tsx` static array)

**Critical blocker for “production accounting SaaS”:** there is no ledger.

---

## D. Modules (summary)

See `LINKBOOKS_FEATURE_IMPLEMENTATION_MATRIX.md` for full classification.

**Headline:** Most product modules are **UI shells / empty states**. Company multi-tenancy is **backend partial**. Auth is **working (UI + Supabase Auth)**. Accounting engine is **absent**.

---

## E. Deployment and ops

| Item | Finding |
|------|---------|
| Host | Vercel project `paxaris/linkbooks`; production URL documented in `docs/VERCEL.md` as `https://linkbooks-navy.vercel.app` |
| Config | No `vercel.json`; Nitro `preset: "vercel"` in `vite.config.ts` |
| Env separation | Local `.env` + Vercel Production/Preview env vars (set in prior session); no formal staging Supabase project documented |
| Migrations workflow | SQL files in repo; applied manually via dashboard for new project; CLI link/login incomplete historically |
| Backups | Not defined in-repo (rely on Supabase plan defaults — not verified) |
| Monitoring | Lovable error reporting hooks; no Sentry/Datadog config found |
| Automated tests | None |
| Build health | TypeScript errors and large lint debt — production risk |

---

## Critical blockers (ordered)

1. **No accounting engine / ledger schema** — cannot be an accounting product in production.
2. **Phase 2 UI unfinished** — company switcher, onboarding, settings still demo/hard-coded; server APIs unused by shell.
3. **Broken compile path** — `accounting.tsx` missing `CompanyEmptyState` import; `tsc` fails.
4. **No automated tests** — cannot claim “implemented and tested” for any financial flow.
5. **Auth URL / env ops** — friend-facing Vercel requires correct Supabase redirect URLs (ops, not code).
6. **Service-role / admin client surface** — misuse risk if imported into shared bundles.
7. **Requirements doc missing from repo** — cannot close gaps against author’s full standard without it.

---

## What is already working (evidence-based)

- Auth pages and Supabase email/password flow (`auth.tsx`, forgot/reset)
- Client session gate for app pages
- Profile read/update server functions
- Company tenancy **database** model + RLS helpers + create/demo RPCs
- Company **server functions** (not fully wired to chrome)
- Empty-state UX across modules acknowledging incomplete engine
- Vercel deploy path for public preview of the UI shell

## What is incomplete or only visual

- All transactional modules (Sales, Purchases, Banking, Contacts, Products, Reports, AI)
- Real company switcher / onboarding
- Settings persistence
- Chart of accounts / journals / periods
- Firm/client (accountant practice) features — not in nav/schema
- Tax configuration beyond empty `company_tax_settings` foundation

## Must correct before production (accounting SaaS)

1. Import authoritative scope MD into repo  
2. Fix TypeScript build errors  
3. Finish Phase 2 UI + isolation tests (2 users × 2 companies)  
4. Design and implement ledger + posting rules with RLS  
5. Wire Sales/Purchases/Banking to ledger  
6. Reports from posted journals  
7. Audit trail, period locks, backups, staging, automated tests  

See roadmap document for recommended order.
