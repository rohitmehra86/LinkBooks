# Settings & Configuration Centre — Stage 0 Audit

**Date:** 2026-10-22  
**Scope:** Repository inspection only — **no Settings Centre code changes in this stage.**  
**Gate:** Priorities below require product-owner approval before Stage 1.

---

## 1. Stack (verified from `package.json` + repo layout)

| Layer | Technology | Version (lock / package) |
|-------|------------|---------------------------|
| UI | React + React DOM | ^19.2.0 |
| Language | TypeScript | ^5.8.3 |
| App framework | TanStack Start | 1.168.60 |
| Routing | TanStack Router | 1.170.41 |
| Data | TanStack Query | ^5.101.1 |
| Build | Vite | 8.1.5 |
| CSS | Tailwind CSS + `@tailwindcss/vite` | ^4.2.1 |
| Components | Radix primitives + local shadcn-style UI | multiple @radix-ui/* |
| Forms | React Hook Form + Zod (+ `@hookform/resolvers`) | RHF ^7.71.2, Zod ^3.25.76 |
| Charts | Recharts | ^2.15.4 |
| Backend / DB | Supabase JS client | ^2.117.2 |
| Auth | Supabase Auth (email/password) | via `@supabase/supabase-js` |
| Server | TanStack `createServerFn` + Nitro (devDep) | nitro 3.0.260603-beta |
| Tests | Vitest | ^3.2.4 |
| Hosting | Vercel | production `linkbooks-navy.vercel.app` |
| Design tool sync | Lovable-connected git history | see `AGENTS.md` |

**Not present:** Next.js, Spring Boot, separate Nest API, Redis, dedicated secrets vault product.

---

## 2. Database, RLS, RPCs (high level)

**Migrations:** 23 files under `supabase/migrations/` (through `20261021140000_bills_workspace_approval.sql`).

**Core accounting (authoritative):**
- Tables: `accounts`, `journals`, `journal_lines`, `accounting_periods`, …
- Period status enum: `open` | `locked` | `closed`
- RPC: `post_journal` — balance check, **period lock**, permissions, **idempotency**
- RPC: `reverse_journal` — immutable history via reversing entry
- Client wrapper: `src/lib/accounting/posting-engine.ts` (`postJournal`, `reverseJournal`)
- FX: `exchange_rates` append-only + void; base currency locked after first posting (trigger)
- Audit: `record_audit_event` RPC + `audit_events`

**Settings-related tables (non-exhaustive):**
- `companies` (+ locale, date_format, theme, FY end, tax regime fields)
- `company_branding`, `document_sequences`, `company_currencies`, `exchange_rates`
- `company_workflow_settings` (sales/purchases defaults, journal memo, CSV date format)
- `tracking_categories` / `tracking_options`, `document_tracking_assignments`, `line_tracking_assignments`
- `company_invitations`, `user_ui_preferences` (bill workspace + bills list prefs)
- Tax: country packs / `company_tax_settings` (see tax migrations)
- Bank rules, contacts settings, products — module-owned tables

**RLS:** Enabled on tenant tables with membership / permission helpers (`has_company_permission`, etc.). Settings mutations go through server functions + permission keys such as `company.settings.edit`, `members.manage`, `accounts.manage`, `audit.view`.

**Auth model:** Client route gate under `_authenticated` is UX-only; data access requires `requireSupabaseAuth` + RLS.

---

## 3. Posting / integrity invariants (must not be weakened)

1. All financial posts go through `post_journal` / module helpers that call it.  
2. Posted journals are immutable; corrections use reverse (+ optional repost).  
3. Locked/closed periods reject new posts at DB RPC.  
4. Idempotency keys prevent duplicate journals for the same business event.  
5. `is_demo` must not fork posting/validation/reporting (AGENTS.md).  
6. Preferences / Feature Manager must **never** bypass locks, permissions, or posting.

---

## 4. Existing Settings surfaces

### 4.1 Organisation Settings Centre — `/settings`

Tabs (from `src/routes/_authenticated/settings.tsx`):

| Tab | Status | Storage | Notes |
|-----|--------|---------|-------|
| Organisation | **Implemented** | `companies`, tax fields on company | Name, legal, country, tax regime, registration, prices-include-tax |
| Localisation (within Org) | **Implemented** | `companies.locale`, `date_format`, theme, footer | Via `updateLocalization` |
| Financial | **Implemented (partial vs brief)** | `companies` FY/currency/timezone | Links to `/accounting` for period locks — **not two-tier advisor locks** |
| Dimensions | **Implemented** | tracking tables | Panel CRUD; consume on New Bill when kinds active |
| Documents | **Implemented** | `company_branding`, `document_sequences` | Logo = URL only; live number preview |
| Currencies | **Implemented** | `company_currencies`, `exchange_rates` | Manual rates; live FX feed honestly unavailable |
| Users | **Implemented (partial)** | memberships + invitations | Roles; invite token without outbound email |
| Automation | **Implemented (thin)** | `company_workflow_settings` | Defaults only — not full workflow engine |
| Integrations | **Honest placeholders** | none live | Email, FX feed, bank aggregator, address autocomplete = not configured |
| Audit | **Implemented** | `audit_events` | Filter + list; not hash-chained / not full export product |
| Demo | **Implemented** | demo company + RPC | Only when `is_demo`; reset gated |

### 4.2 Module-specific settings

| Route | Status | Storage |
|-------|--------|---------|
| `/sales/settings` | Implemented | `company_workflow_settings` |
| `/purchases/settings` | Implemented | same |
| `/contacts/settings` | Implemented | contact numbering / defaults |
| `/tax` | Implemented (packs) | tax settings + country packs |
| `/accounting` (Periods) | Implemented | `accounting_periods` lock/unlock |
| `/profile` | User profile | auth user |
| Bill UI prefs | Implemented | `user_ui_preferences` |

### 4.3 Storage classification

| Mechanism | Used for |
|-----------|----------|
| Postgres + RLS | Almost all org settings |
| Server functions | Mutations (no direct client “god” writes for sensitive paths) |
| `user_ui_preferences` | Bill workspace / bills list columns |
| Hard-coded constants | Locales, date formats, role labels (`company-constants`) |
| localStorage | **Not** primary settings store (no settings reliance found in settings modules) |
| Env vars | Supabase keys, optional AI provider (`AI_API_KEY` etc.) |

---

## 5. Related modules (inventory)

| Module | Route area | Maturity (relative) |
|--------|------------|---------------------|
| Dashboard | `/` | Present |
| Banking | `/banking/*` | Strong (import, rules, reconcile, transfers); feeds honestly limited |
| Sales | `/sales/*` | Invoices, quotes, credits, receipts, recurring, statements |
| Purchases | `/purchases/*` | Bills workspace, payments, credits, expenses, POs, recurring |
| Contacts | `/contacts/*` | Centre + duplicates + import |
| Products | `/products-services` | Present |
| Accounting / CoA | `/accounting` | CoA, journals, periods |
| Reports | `/reports/*` | Reports centre |
| Tax | `/tax` | Multi-country packs |
| Accountant / Firm | `/accountant`, `/firm` | Present but practice tooling incomplete vs brief |
| AI Assistant | `/ai-assistant` | Honest “not configured” without provider keys |
| Help | `/help` | Present |
| Demo | Settings Demo tab + seed | Guarded |

---

## 6. New Bill workspace (preserve)

Documented in `docs/LINKBOOKS_NEW_BILL_WORKSPACE.md` and code under `bills.new.tsx` + purchase components:

- Header: status, view modes (Basic / Professional / Custom), Save draft, Save & authorise, Cancel  
- Supplier Intelligence Sidebar (collapse/close/resize; prefs in `user_ui_preferences`)  
- Line items with accounts, tax, class/location/project when dimensions enabled  
- Inline “Add new…” for supplier, product, account, tax, dimensions, payment terms  
- Blank-line cleanup; drafts do not post; authorise uses shared posting engine  
- Attachments, notes, FX rate resolution, duplicate supplier-invoice warnings  

**Do not regress this UI** when adding Settings consumers.

---

## 7. Tests (observed 2026-10-22)

```
Test Files  1 failed | 27 passed (28)
Tests       2 failed | 181 passed (183)
```

- **Failing:** `src/lib/sales/posting.test.ts` (2) — mocks incomplete vs `resolveOutputTaxAccount` needing `supabase.from` (pre-existing vs tax-account resolution; **not introduced by this audit**).  
- Settings-related tests present: `cross-cutting.test.ts`, `dimension-helpers.test.ts`, plus posting/money/fx/tax/permissions suites.  
- Gap: few/no E2E tests that “toggle setting → assert form/API behaviour”; no axe suite in CI from this inventory.

---

## 8. Gap analysis vs 24-category brief (summary)

See full matrix: [`02-GAP-ANALYSIS.md`](./02-GAP-ANALYSIS.md).

**P0 (correctness / security / integrity) — propose for Stages 1–2**
1. Typed settings registry + category schema + RLS-hardened mutation RPCs  
2. Settings change audit (per-key old/new) and optimistic concurrency  
3. Two-tier / advisor period locks (or explicit “Unavailable” until designed against current `accounting_periods`)  
4. Settings Overview + Feature Manager **five-state** engine (honest Unavailable)  
5. Dependency engine skeleton for high-risk toggles (FX off, dimensions off, multicurrency)  
6. Command palette / search shell that deep-links existing tabs (no fake controls)

**P1 (parity with Xero/QBO-class SMB)**
- Reminder schedules, late fees, document themes beyond colour/footer, bank rule config centre, portals (marked Unavailable until built), import/migration hub honesty, firm practice dashboard

**P2 (differentiators)**
- Advanced Zoho-like workflows, fixed assets full module, Akaunting-style marketplace, Wave-style simple mode as first-class path

---

## 9. Duplication / dead / honesty issues

| Issue | Detail |
|-------|--------|
| Split settings UX | Org `/settings` vs `/sales/settings` vs `/purchases/settings` vs `/tax` vs `/accounting` — functional but not a unified IA |
| Automation tab | Overlaps sales/purchases defaults |
| Integrations | Correctly non-operational; must stay honest |
| AI / bank feeds / email | Must remain “not configured” until real |
| Invitation accept UX | Token exists; dedicated accept route incomplete |
| Dimension line UI | APIs ready; not every document form fully wired |

---

## 10. Recommended Stage 1 scope (for approval)

Vertical slice only:

1. Docs + design tokens (`01-DESIGN.md`) if no design-concept file  
2. `settings_registry` / typed category documents **or** validated JSONB per category with Zod  
3. Settings Centre **shell**: nav, Overview, search synonyms, Cmd/Ctrl+K, unsaved guard  
4. Feature Manager five-state for dimensions / multicurrency / inventory / AI / POs (read existing flags first)  
5. Wire **no** fake integrations; migrate **Organisation + Financial read** through new registry without behaviour change  
6. Tests: isolation, permission deny, “disable Classes hides on New Bill professional view”

**Out of Stage 1:** full 24 categories, portals, late fees, migration wizards, SSO.

---

## 11. Blockers / dependencies

- Product decision: two-tier locks vs extend single `accounting_periods.status`  
- Email provider for invites/reminders (external)  
- Bank feed / payment gateway OAuth apps (external)  
- AI provider keys (env)  
- Lovable: no history rewrite on push  

---

*End of Stage 0 audit. Awaiting priority approval to begin Stage 1.*
