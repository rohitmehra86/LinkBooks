# LinkBooks — Feature Implementation Matrix

**Audit date:** 19 Oct 2026  
**Classification rules:**

| Label | Meaning |
|-------|---------|
| **Implemented and tested** | End-to-end supported by code **and** automated or documented test evidence |
| **Partially implemented** | Real backend and/or UI paths exist; incomplete wiring, gaps, or no tests |
| **UI only** | Screens/copy/empty states; no durable data or business logic |
| **Backend only** | Schema and/or server functions exist; no (or stub) product UI |
| **Not implemented** | Absent from schema, server, and meaningful UI |

**Global note:** There is **no** `test` / e2e script and no ledger tests. Therefore **no accounting feature** can be marked “Implemented and tested.” Auth and tenancy have code evidence only — classified as **Partially implemented** unless noted.

**Requirements file** “LinkBooks — Full Product Scope and Implementation Standard.md” was **not found**. Matrix uses `roadmap.md`, `.lovable/plan.md`, and the audit brief module list.

---

## Cross-cutting platform

| Feature | Class | Evidence |
|---------|-------|----------|
| Email/password sign-up / sign-in | Partially implemented | `src/routes/auth.tsx`; Supabase Auth; no automated tests |
| Forgot / reset password | Partially implemented | `forgot-password.tsx`, `reset-password.tsx` |
| Client session gate | Partially implemented | `_authenticated/route.tsx` (UX only; RLS is real enforcer) |
| Profile view / update | Partially implemented | `profile.tsx` + `profile.functions.ts` |
| Multi-company tenancy schema + RLS | Partially implemented | Migrations `20261003014249_*`, `20261003014326_*`; types.ts |
| Create company / demo company RPCs | Backend only (UI missing) | SQL `create_company`, `create_demo_company`; `company.functions.ts` |
| Active company context API | Partially implemented | `getCompanyContext`, `setActiveCompany`, `useActiveCompany` |
| Company switcher in chrome | UI only (hard-coded) | `AppShell.tsx` L156–169 “Demo Company Ltd” — not calling APIs |
| Onboarding (first company) | Not implemented | Plan describes; no dedicated route/flow found |
| Member invite / accept | Backend only | `company_invitations` table + RLS; no invite UI found |
| Role permissions matrix | Backend only | `role_permissions` seeded in migration; unused by app UI |
| Service-role admin client | Partially implemented (risk) | `client.server.ts`; must stay server-only |
| Automated tests | Not implemented | No test runner config / scripts |
| TypeScript clean build | Not implemented | `tsc` fails (`accounting.tsx` missing import; `company-empty` exactOptional) |

---

## Dashboard

| Feature | Class | Evidence |
|---------|-------|----------|
| Dashboard route + KPIs placeholders | UI only | `index.tsx` — `NO_FIGURE` / empty states |
| Live balances / aging / cash | Not implemented | No ledger/invoice data sources |
| Demo banner | UI only | `AppShell` “Demo data — no real financial records” |

---

## Sales

| Feature | Class | Evidence |
|---------|-------|----------|
| Sales page shell | UI only | `sales.tsx` — empty + “not yet enabled” messaging |
| Customers / invoices / credit notes | Not implemented | No tables or server functions |
| Post invoice to AR / revenue | Not implemented | Explicitly deferred in UI copy |

---

## Purchases

| Feature | Class | Evidence |
|---------|-------|----------|
| Purchases page shell | UI only | `purchases.tsx` |
| Suppliers / bills / expense claims | Not implemented | No schema |
| Post bill to AP / expense | Not implemented | Deferred in UI copy |

---

## Banking

| Feature | Class | Evidence |
|---------|-------|----------|
| Banking page shell | UI only | `banking.tsx` |
| Bank accounts / feed / reconcile | Not implemented | No schema |
| Bank → ledger clearing | Not implemented | Deferred in UI copy |

---

## Contacts

| Feature | Class | Evidence |
|---------|-------|----------|
| Contacts page shell | UI only | `contacts.tsx` |
| Contact CRUD / party master | Not implemented | No `contacts` table; sales/purchases not linked |

---

## Chart of Accounts / Journals / Ledger / Periods

| Feature | Class | Evidence |
|---------|-------|----------|
| Accounting tabs UI | UI only | `accounting.tsx` — CoA, journals, GL, periods tabs |
| CoA data model | Not implemented | Alert: “Engine not yet enabled” |
| Manual journals + double-entry | Not implemented | No journal tables / validators |
| Posting / reverse / adjust | Not implemented | — |
| Period lock / FY | Not implemented (FY fields on company only) | `companies.fiscal_year_end_*` exist; no period table |
| Compile safety of page | Broken | Missing `CompanyEmptyState` import (tsc error) |

---

## Reports

| Feature | Class | Evidence |
|---------|-------|----------|
| Report list (P&L, BS, TB, …) | UI only | `reports.tsx` static cards/names |
| Trial Balance / P&L / Balance Sheet calc | Not implemented | No journal source |
| Export PDF/CSV | Not implemented | — |

---

## Tax configuration

| Feature | Class | Evidence |
|---------|-------|----------|
| `company_tax_settings` row on company create | Partially implemented | Migration + `create_company` / `create_demo_company` |
| Tax rates / codes / returns UI | Not implemented | Settings “Organisation” uses Demo defaults; no tax screens |
| Tax on documents / posting | Not implemented | No documents |

---

## Products and Services

| Feature | Class | Evidence |
|---------|-------|----------|
| Page shell | UI only | `products-services.tsx` |
| Product master / inventory / income accounts | Not implemented | No schema |

---

## Accountant tools / Firm & client management

| Feature | Class | Evidence |
|---------|-------|----------|
| Practice firm entity | Not implemented | Not in schema or nav |
| Multi-client switchboard for accountants | Not implemented | Company membership is SMB multi-org only |
| External accountant role workflows | Backend stub only | Role enum includes accountant-like roles in migration — verify against `.lovable/plan.md`; **no dedicated tools UI** |

---

## Settings

| Feature | Class | Evidence |
|---------|-------|----------|
| Settings page layout | UI only / partial | `settings.tsx` — Demo Company Ltd defaults |
| Persist org settings via API | Not implemented in UI | `updateCompany` / `getCompanyDetails` exist but not wired here |
| Users & roles management UI | Not implemented | `listCompanyMembers` backend only |
| Billing | Not implemented | — |

---

## AI Assistance

| Feature | Class | Evidence |
|---------|-------|----------|
| AI Assistant page | UI only | `ai-assistant.tsx` — placeholder / marketing copy |
| LLM integration / tools over ledger | Not implemented | No edge functions / API keys pattern for AI found |

---

## Demo Company

| Feature | Class | Evidence |
|---------|-------|----------|
| `is_demo` flag + `create_demo_company` | Partially implemented | Migration + `openDemoCompany` server fn |
| AGENTS.md rule: demo must share same engine | Policy documented | No engine yet — rule cannot be validated in practice |
| UI “Demo Company Ltd” switcher items | UI only | Hard-coded; not RPC-backed |
| Seeded demo transactions | Not implemented | Demo create inserts company + tax + membership only |

---

## Help / Profile

| Feature | Class | Evidence |
|---------|-------|----------|
| Help page | UI only / content | `help.tsx` |
| Profile | Partially implemented | Wired to profile functions |

---

## Summary counts (approximate, by feature rows above)

| Class | Rough count |
|-------|-------------|
| Implemented and tested | **0** |
| Partially implemented | ~10 |
| Backend only | ~5 |
| UI only | ~20+ |
| Not implemented | Majority of accounting product |

**Bottom line:** LinkBooks today is a **Lovable UI shell + Supabase Auth + Phase 2 company tenancy foundation**. It is **not** yet a production accounting platform.
