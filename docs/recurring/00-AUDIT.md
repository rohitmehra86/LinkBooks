# LinkBooks — Recurring Transactions Engine V2  
## Stage 0: Repository & architecture audit (read-only)

| Field | Value |
|-------|--------|
| **Date** | 2026-10-22 |
| **Scope** | Existing recurring bills/invoices, platform stack, posting engine, settings, jobs |
| **Method** | Source + migration inspection; no schema or product code changed for this document |
| **Gate** | Stage 0 — priorities from Section 14 gap analysis require product owner approval before Stage 1 |

---

## 1. Verified stack and versions

| Layer | Verified (from `package.json`, `tsconfig.json`, `vite.config.ts`) |
|-------|---------------------------------------------------------------------|
| **Runtime / UI** | React **19.2.x**, React DOM **19.2.x** |
| **Language** | TypeScript **5.8.x**, **`strict: true`**, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature` |
| **Build** | Vite **8.1.5**, `@vitejs/plugin-react` **5.2.x** |
| **App framework** | TanStack Start **1.168.60**, TanStack Router **1.170.41**, TanStack Query **5.101.x** |
| **Styling** | Tailwind CSS **4.2.x** (`@tailwindcss/vite`), `tw-animate-css`, shadcn-style Radix primitives under `src/components/ui/` |
| **Forms** | React Hook Form **7.71.x**, Zod **3.25.x**, `@hookform/resolvers` |
| **Backend / data** | Supabase JS **2.117.x**; Postgres schema via `supabase/migrations/`; server functions via `createServerFn` + `requireSupabaseAuth` |
| **Deploy** | Nitro **3.0.x** preset **vercel** (`vite.config.ts`); production host documented in `docs/VERCEL.md` |
| **Tests** | Vitest **3.2.x** (`npm test`); no property-based / recurrence library in dependencies today |
| **Dates** | `date-fns` **4.1.x** only — **no RFC 5545 / RRULE library** installed |

**Assumption check:** Brief’s “React 19, TS strict, Vite, TanStack Start, Tailwind v4, shadcn/Radix, RHF+Zod, Supabase” — **confirmed**.

---

## 2. Existing recurring module (purchases + sales)

### 2.1 Data model

**Purchases — `recurring_bills`** (`20261019160000_purchases_module.sql`):

- Columns: `company_id`, `contact_id`, `name`, `frequency` (`recurrence_frequency` enum), `next_due_date`, optional `day_of_month` (1–28, **unused in app code today**), `currency_code`, `is_active`, `auto_authorise`, `last_generated_on`, `last_error`, `template` **JSONB**, audit columns.
- **Template storage:** single JSON blob `{ lines[], subtotal_minor, tax_minor, total_minor }` — not normalised line table.
- **Idempotency guard:** partial unique index `recurring_bills_gen_guard_uidx` on `(id, last_generated_on)` when `last_generated_on IS NOT NULL` — **not** a deterministic `(schedule_id, occurrence_key)` model.
- RLS: policy `recurring_bills_write` (member write pattern on purchases module).

**Sales — `sales_recurring_invoices` + `sales_recurring_invoice_lines`** (`20261019180000_sales_banking_contacts.sql`):

- Header similar to bills (no JSONB template); **normalised lines** table.
- Links `last_invoice_id` to generated invoice.
- Same enum frequencies; same active / auto_authorise / last_generated_on / last_error pattern.

**Shared enum `recurrence_frequency`:** `weekly | monthly | quarterly | yearly` only.

### 2.2 Server APIs (TanStack Start server functions)

| Function | Module | Permission (typical) | Behaviour summary |
|----------|--------|----------------------|-------------------|
| `listRecurringBills` | `purchases.functions.ts` | `purchases.view` | List ≤100, join contact name |
| `saveRecurringBill` | same | `purchases.draft` | Insert template + JSON lines via `validateBillLines` |
| `generateRecurringBill` | same | `purchases.draft` | Manual generation only; see §2.4 |
| `setRecurringBillActive` | same | `purchases.draft` | Pause/resume |
| `listRecurringInvoices` | `sales.functions.ts` | company member | List ≤100 |
| `saveRecurringInvoice` | same | `sales.draft` | Insert header + lines |
| `generateRecurringInvoice` | same | `sales.draft` | Manual generation; tax via `loadTaxTreatment` + `validateSalesLines` |
| `setRecurringActive` | same | `sales.draft` | Pause/resume |

**Not present:** update/edit recurring template, duplicate, archive, skip occurrence, version history, occurrence ledger, exception centre, forecast RPCs, bulk actions, or scheduler-triggered entry points.

### 2.3 UI surfaces

| Route | Implementation | UX pattern |
|-------|----------------|------------|
| `/purchases/recurring` | `src/routes/_authenticated/purchases/recurring.tsx` | **Full page** — inline create form (single line), table, Generate / Pause |
| `/sales/recurring` | `src/routes/_authenticated/sales/recurring.tsx` | **Full page** — similar simplified create |
| `/purchases/bills` tab `recurring` | `bills.index.tsx` → `RecurringPane` | Read-only list + link to module |
| `/purchases/bills/new` | “Make recurring” | **Small `Dialog`** — name, frequency, next date, auto-authorise; copies **current lines** via `saveRecurringBill` then navigates away |

**Gap vs V2 brief:** No premium overlay, no deep-linked overlay route, no seven tabs, no management workspace with server pagination/filters/saved views.

### 2.4 Schedule execution model (critical)

| Question | Finding |
|----------|---------|
| **Cron / pg_cron / queue?** | **None in repo.** `src/integrations/supabase/cron-auth.ts` validates `LOVABLE_CRON_SECRET` for hypothetical cron HTTP calls — **no scheduled job definitions**, edge functions, or Vercel crons wired to recurring generation. |
| **Who runs generation?** | **Authenticated user** calling `generateRecurringBill` / `generateRecurringInvoice` from UI (or future API). |
| **Date math** | **Hand-rolled** in TS: `Date` UTC add 7 days / 1 month / 3 months / 1 year (`purchases.functions.ts`, `nextDate()` in sales). **No anchor-based month-end rules**, no business-day adjustment, no DST/org-TZ policy. |
| **Concurrency** | Application check: `last_generated_on === next_due_date` → error. **No row locking**, no materialised occurrence row, no `FOR UPDATE SKIP LOCKED` worker. Race: two parallel “Generate” clicks can still double-insert bills before `last_generated_on` updates (TOCTOU). |
| **Default posting policy** | **Draft bills/invoices** unless `auto_authorise` true; then calls `authoriseBillInternal` / `postInvoiceAuthorisation` → existing posting engine. Documented in UI copy on purchases recurring page. |

### 2.5 Tests

- **`src/lib/purchases/posting.test.ts`:** policy assertion only (`auto_authorise: false`) — **not** an integration test of generation.
- **No dedicated recurring schedule tests**, no concurrency tests, no recurrence date tests.
- Sales/purchases completion docs explicitly note: **“no cron auto-run”** (`LINKBOOKS_SALES_RECEIVABLES_COMPLETION.md`).

### 2.6 Migration compatibility requirement (V2)

Existing rows in `recurring_bills` / `sales_recurring_invoices` must remain valid. Stage 1 must:

- Either wrap legacy tables in a compatibility view/adapter, or migrate row-by-row into new `recurring_*` schema with **preserved generation behaviour** until cutover.
- Preserve JSONB templates for bills (including lines shape consumed by `generateRecurringBill`).

---

## 3. Standard document forms (reuse targets)

### 3.1 New Bill (`/purchases/bills/new`)

Documented in `docs/LINKBOOKS_NEW_BILL_COMPLETION.md`. Full workspace includes:

- Supplier search/quick-add, header (dates, terms, supplier invoice #, currency, tax mode exclusive/inclusive/none), duplicate soft-check, rich line grid (product, account, tax codes, **class/location/project**, billable, drag reorder), attachments (`document_attachments`), internal notes, audit via `record_audit_event`, FX display, Save draft / Save & authorise / Make recurring dialog.

**Recurring template today captures only:** description, accountId, qty, unitPriceMinor, discountMinor, taxRateBps — **drops** productId, taxCodeId, dimensions, billable, header fields (supplier invoice #, terms, tax calculation mode, attachments, etc.).

### 3.2 Sales Invoice (`/sales/invoices/new` and related)

Sales module supports invoices, quotes, credit notes with shared line helpers (`validateSalesLines`, tax treatment). Recurring invoice create UI uses **simplified single-line form**, not invoice-new parity.

**Recurring generation** uses stored line tax BPS and `loadTaxTreatment` at generation time — partial alignment with effective-dated tax intent; **does not** resolve tax **codes** from template (lines have no `tax_code_id` in recurring line table).

### 3.3 Other document families (existence)

| Family | Status in LinkBooks | Recurring today |
|--------|---------------------|-----------------|
| Purchase bills | Yes | Partial (purchases recurring) |
| Sales invoices | Yes | Partial (sales recurring) |
| Purchase/sales credit notes | Yes | No |
| Expenses / claims | Yes | No |
| Purchase orders | Yes | No |
| Manual journals | Yes (`postManualJournal`, `/accounting`) | No |
| Bank transfers / deposits | Banking module | No |
| Quotes | Sales quotes routes | No |

---

## 4. Platform systems the engine must consume

### 4.1 Tax

- Country packs, effective-dated rates, GL mapping (`src/lib/tax/`, migrations `20261020250000_tax_multi_country.sql`).
- Bill lines support tax calculation modes via `computeBillLine` / `validateBillLines`.
- **Generation-time effective dating** for recurring is **partial** (sales reloads treatment; bills use stored BPS in JSON).

### 4.2 FX

- Document FX on bills (`fx_rate_to_base`, org settings) — see `docs/settings-fx-firm/FX_ACCOUNTING_POLICY.md`.
- Recurring templates store **currency_code** only; generation sets bill/invoice dates but **does not** replicate full New Bill FX policy fields.

### 4.3 Contacts

- Unified contacts centre; suppliers/customers on bills/invoices.

### 4.4 Chart of accounts & dimensions

- CoA via `accounts`; dimensions via `tracking_categories` / `tracking_options`, assignments (`20261020240000_settings_governance_dimensions.sql`).
- **Bill line validation supports dimensions**; recurring bill JSON **does not persist** them today.

### 4.5 Approvals

- Bills: `awaiting_approval` workflow (submit/approve/reject) in `purchases.functions.ts`; migration `20261021140000_bills_workspace_approval.sql`.
- Recurring **auto_authorise** bypasses approval queue and posts directly when true — **no** threshold, multi-level, or segregation-of-duties on templates.

### 4.6 Numbering

- `allocate_document_number` for bills/invoices when blank (`settings` governance doc).

### 4.7 Permissions

- Company-scoped permissions via `assertCompanyPermission` / RLS (`has_company_permission`, role_permissions).
- Recurring uses coarse keys: `purchases.view|draft`, `sales.draft`, `sales.authorise` (when auto-post invoices).

### 4.8 Audit & notifications

- `record_audit_event` RPC used on bill lifecycle; **no audit** on recurring template CRUD/generation today (except bill history after generation).
- **Email:** honestly **unavailable** in settings (`LINKBOOKS_SETTINGS_GOVERNANCE_COMPLETION.md`) — approve-and-email recurring delivery **blocked** until provider exists.

### 4.9 Attachments

- `document_attachments` with base64 storage on bills — not linked to recurring templates.

---

## 5. Authoritative posting engine & accounting invariants

**Path (documented in `docs/LINKBOOKS_ACCOUNTING_INTEGRITY.md`):**

1. Client/service: `postJournal()` — `src/lib/accounting/posting-engine.ts`
2. Database: `post_journal(payload JSONB)` — `20261019140000_accounting_engine.sql`

**Enforced:** membership, permissions (`accounting.post` / module authorise paths), balanced lines, **open accounting period** for `journal_date`, idempotency `(company_id, idempotency_key)`, immutability triggers (`linkbooks.trusted`).

**Purchases authorise:** `postBillAuthorisation` → posting engine with idempotency `purchase_bill:{id}:authorise`.

**Recurring relevance:**

- Draft generation **must not** call `postJournal` (current default — **good**).
- Auto-authorise path **must** keep using module authorise functions (current — **good**).
- **Locked period:** generation on a locked `bill_date`/`invoice_date` will fail at post time — **no** template-level policy (block vs draft-in-open-period) today.
- **Idempotency:** recurring uses `last_generated_on` date match, **not** posting-engine occurrence keys.

---

## 6. Reusable UI primitives

| Primitive | Location | Recurring V2 fit |
|-----------|----------|------------------|
| `Dialog` | `src/components/ui/dialog.tsx` | Used for “Make recurring” — basis for modal, not full overlay |
| `Sheet` / `Drawer` | `sheet.tsx`, `drawer.tsx`, `vaul` | Candidate mobile bottom sheet |
| Tables, Select, Tabs | `src/components/ui/*` | Management table + overlay tabs |
| Page states | `src/components/common/states.tsx` | Loading/error/empty |
| Bill workspace | `bills.new.tsx`, `BillRelatedFilesOverlay.tsx` | **Reuse line grid / supplier patterns** for editor parity |
| Sales lines | `SalesDocumentLines.tsx` | Invoice recurring editor target |

**Not found:** shared “premium overlay shell” with URL sync, focus trap wrapper, or recurring-specific components.

---

## 7. Migrations & background job deployment

- **23** timestamped SQL migrations under `supabase/migrations/` (company tenancy, engine, purchases, sales, banking, tax, settings, bills workspace).
- **No** `pg_cron` extension migration, **no** Supabase Edge Function sources in repo for recurring.
- **Vercel:** serverless Nitro output; long-running scheduler **cannot** rely on browser; needs **Supabase cron → HTTP** (with `LOVABLE_CRON_SECRET`), **pg_cron + SQL worker**, or external queue — **must be designed in Stage 1** and documented for ops.

**Environment names** (no values): see `docs/ENV_AND_DEPLOYMENT.md` — `LOVABLE_CRON_SECRET` reserved for cron auth.

---

## 8. Settings Centre relationship

Route: `/settings` — tabs Organisation, Financial, Dimensions, Documents, Currencies, Users, Automation, Integrations, Audit, Demo (`LINKBOOKS_SETTINGS_GOVERNANCE_COMPLETION.md`).

| Setting area | Recurring V2 must consume |
|--------------|---------------------------|
| Financial / periods | Lock dates via open periods on post |
| Tax | Effective-dated codes/rates at **document date** |
| Dimensions | Mandatory-dimension rules at generation (APIs exist; line UI partial on standard forms) |
| Documents / numbering | Generated doc numbers |
| Automation tab | Workflow defaults (terms, PO policy) — **not** wired to recurring |
| Integrations | Email/FX/bank — mostly unavailable |
| Notifications | **No central notification router** evidenced for recurring failures |
| Feature Manager (5-state) | **Not implemented** as a platform module — only informal feature docs |

Purchases/sales **module settings** routes: `/purchases/settings`, `/sales/settings` — defaults for new docs; should feed templates, not be duplicated.

---

## 9. Gap analysis summary (detail in `02-GAP-ANALYSIS.md`)

Priorities for Stage 1+ planning:

| Priority | Theme | Today | Target |
|----------|-------|-------|--------|
| **P0** | Non-destructive migration + RLS + no duplicate occurrences under concurrency | Weak idempotency; legacy tables | Materialised occurrences + unique keys + worker locks |
| **P0** | Draft-default generation; no silent post | Mostly met | Preserve; add explicit auto-authorise permission |
| **P0** | Posting only via existing engine | Met for auto_authorise path | Extend to all families |
| **P1** | RRULE + business-day/holiday calendars | Hand-rolled 4 frequencies | RFC 5545 library + settings-backed holidays |
| **P1** | Full New Bill / Invoice editor parity in templates | Partial JSON / single-line UI | Shared form components + versioned template rows |
| **P1** | Scheduled / reminder / on-demand modes | Scheduled manual only | Three modes + notifications |
| **P1** | Server-side scheduler | None | pg_cron or secured cron HTTP + worker |
| **P2** | Forecast, exception centre, firm template packs, amortisation | None | Stage 6–7 |

---

## 10. Stage 0 gate — recommended next step

1. **Product owner approves** P0/P1 ordering in `docs/recurring/02-GAP-ANALYSIS.md`.
2. **Stage 1 technical spike decisions** (record in Stage 1 design note before coding):
   - Target schema names (`recurring_templates`, `recurring_schedules`, `recurring_occurrences`, …) vs extend legacy tables.
   - Scheduler deployment choice (Supabase scheduled function vs Vercel cron invoking Start route with `LOVABLE_CRON_SECRET`).
   - RRULE library selection (e.g. `rrule` npm + wrapper for business-day extension).
3. **Do not start UI overlay** until Stage 1 occurrence + recurrence tests pass (including property-based dates).

---

## 11. Evidence references (files)

| Area | Primary paths |
|------|----------------|
| Recurring bills API | `src/lib/purchases/purchases.functions.ts` (~2306+) |
| Recurring invoices API | `src/lib/sales/sales.functions.ts` (~1204+) |
| Purchases UI | `src/routes/_authenticated/purchases/recurring.tsx`, `bills.new.tsx`, `bills.index.tsx` |
| Sales UI | `src/routes/_authenticated/sales/recurring.tsx` |
| Schema | `supabase/migrations/20261019160000_purchases_module.sql`, `20261019180000_sales_banking_contacts.sql` |
| Posting | `src/lib/accounting/posting-engine.ts`, `20261019140000_accounting_engine.sql` |
| Cron auth stub | `src/integrations/supabase/cron-auth.ts` |
| Integrity doc | `docs/LINKBOOKS_ACCOUNTING_INTEGRITY.md` |

---

*End of Stage 0 audit — no application code modified for this deliverable.*
