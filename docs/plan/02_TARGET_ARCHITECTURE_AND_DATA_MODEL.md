# LinkBooks — Target Architecture & Database Design

## 1. Stack (preserve unless approved exception)

| Layer | Choice | Notes |
|-------|--------|-------|
| UI | React 19 + TanStack Router/Start + Vite | Existing Lovable/Cursor app |
| Styles | Tailwind + existing UI kit | No redesign required for architecture |
| Hosting | Vercel (Nitro `vercel` preset) | Preview + Production |
| Auth | Supabase Auth | Email/password first; OAuth later via `auth-helpers` |
| DB | Supabase Postgres + RLS | Authoritative security boundary |
| Server logic | TanStack `createServerFn` + optional Edge Functions | Money mutations server-side |
| Storage | Supabase Storage | Receipts, statement files, exports |
| Jobs | Supabase Cron / scheduled Edge (later) | Recurring docs, feeds, depreciation |

**No Java/Paxo rewrite for v1** (`docs/ARCHITECTURE_MVP.md`).

---

## 2. Logical architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Browser                                                      │
│  AppShell + full nav · activeCompanyId (client cache only) │
│  Auth gate = UX; never sole security                         │
└───────────────┬───────────────────────────────┬─────────────┘
                │ publishable key               │ Server Fns
                ▼                               ▼
┌───────────────────────┐         ┌────────────────────────────┐
│ Supabase Auth         │         │ Server (Vercel / Start)    │
│ JWT → auth.uid()      │         │ requireSupabaseAuth        │
└───────────┬───────────┘         │ resolveActiveCompany       │
            │                     │ Permission checks          │
            ▼                     │ ★ PostingEngine (only)     │
┌─────────────────────────────────┴────────────────────────────┐
│ Postgres                                                      │
│  RLS via is_company_member / has_company_permission           │
│  Constraints: balanced journals, period locks, money checks   │
│  SECURITY DEFINER RPCs only for trusted multi-step creates    │
└──────────────────────────────────────────────────────────────┘
```

**Service role** (`client.server.ts`): admin/ops only (invites email, cron). Never import into client bundles. Prefer user-scoped client for CRUD.

---

## 3. Tenancy model

### Organisation types

| Entity | Purpose |
|--------|---------|
| `companies` | Books entity (SMB, freelancer, demo). All ledgers hang off `company_id`. |
| `firms` | Accounting practice (FIRM). Does **not** own journals. |
| `firm_client_links` | Firm ↔ company access; materializes or updates `company_members`. |

### Rules

1. Every financial row has **NOT NULL `company_id`**.
2. Access = active `company_members` row **or** firm path that creates such a membership.
3. Active company: `profiles.last_company_id`, re-validated server-side on every mutation.
4. Switch company: save last_company_id → invalidate React Query cache → reload.
5. A user without membership to company X never reads X’s rows (RLS).

### Demo

- `companies.is_demo = true`, created via `create_demo_company()`.
- Same tables, RLS, PostingEngine, UI.
- Reset allowed only when `is_demo`; never for real companies.

---

## 4. Core domain services (application layer)

| Service | Responsibility |
|---------|----------------|
| `CompanyContext` | Resolve active company + role + permissions |
| `PermissionService` | `has_company_permission` wrapper |
| `PostingEngine` | **Only** writer of posted `journals` / `journal_lines` |
| `DocumentPostingAdapters` | Invoice, bill, payment, bank, tax → journal drafts |
| `PeriodService` | Open/lock; validate posting date |
| `NumberingService` | Document sequences per company |
| `TaxService` | Compute line tax from tax codes (deterministic) |
| `ReportingService` | TB / P&L / BS / GL / aging from **posted** lines only |
| `AuditService` | Append-only `audit_events` |
| `AiAssistService` | Suggest/draft; never calls PostingEngine without user confirm + validation |

---

## 5. Target database relationship design

### Existing (keep)

```
auth.users 1─1 profiles
profiles.last_company_id → companies
companies 1─N company_members N─1 auth.users
companies 1─1 company_tax_settings
companies 1─N company_invitations
role_permissions (role, permission)
```

### Firm (add)

```
firms 1─N firm_members N─1 auth.users
firms 1─N firm_client_links N─1 companies
  → on accept: upsert company_members with role mapped from access_level
```

### Master data

```
companies 1─N contacts (type: customer|supplier|both|employee)
companies 1─N products
companies 1─N tax_rates / tax_codes
companies 1─N document_sequences
companies 1─N currencies_enabled (base on companies.base_currency)
companies 1─N accounting_periods
companies 1─N accounts (chart of accounts)
```

### Ledger (authoritative money)

```
companies 1─N journals 1─N journal_lines N─1 accounts
journals.source_type + source_id → originating document (nullable for pure manuals)
journals.reverses_journal_id → journals (nullable)
journal_lines: debit, credit, contact_id?, tax_code_id?, product_id?
```

### Operational documents (post via adapters)

```
sales_quotes, sales_invoices, sales_credit_notes, customer_payments, payment_allocations
purchase_bills, purchase_credit_notes, expenses, supplier_payments, purchase_orders
bank_accounts, bank_transactions, bank_transfers, reconciliations, bank_rules
recurring_* schedules (later)
fixed_assets (later)
```

### Cross-cutting

```
attachments (storage path + company_id + entity ref)
audit_events (append-only)
ai_suggestions (draft payloads; not ledger)
```

---

## 6. Key table sketches (logical)

### `accounts`
`id`, `company_id`, `code`, `name`, `account_type` (asset|liability|equity|income|expense|…), `subtype`, `tax_code_id?`, `is_system`, `is_postable`, `archived_at`, unique `(company_id, code)`

### `accounting_periods`
`id`, `company_id`, `name`, `start_date`, `end_date`, `status` (`open`|`locked`|`closed`), unique non-overlap per company

### `journals`
`id`, `company_id`, `journal_number`, `journal_date`, `period_id`, `status` (`draft`|`approved`|`posted`|`voided`),  
`source_type`, `source_id`, `idempotency_key` unique `(company_id, idempotency_key)`,  
`memo`, `posted_at`, `posted_by`, `reverses_journal_id`, `reversed_by_journal_id`,  
`currency_code`, `fx_rate` (to base), `created_by`

### `journal_lines`
`id`, `journal_id`, `company_id`, `line_no`, `account_id`,  
`debit` NUMERIC, `credit` NUMERIC, CHECK (exactly one of debit/credit > 0 XOR both 0 forbidden),  
`contact_id?`, `tax_code_id?`, `description`, `product_id?`

**DB constraints (required):**
- Per journal when status=`posted`: `SUM(debit) = SUM(credit)` (trigger or deferred constraint).
- No UPDATE/DELETE of lines when journal is `posted` (trigger).
- Posting date must fall in an `open` period (or unlocked) for that company.

### Documents (example: `sales_invoices`)
`status` (`draft`|`authorised`|`paid`|`void`), `contact_id`, amounts, tax totals,  
`posted_journal_id` nullable unique — set when PostingEngine succeeds.

---

## 7. Reporting data rule

All financial statements read **only** `journal_lines` joined to `journals` where `status = 'posted'` (and not superseded solely by reversal — reversals are themselves posted journals that net out).

Never compute P&L from invoice tables alone.

---

## 8. Storage

| Bucket | Path pattern | Policy |
|--------|--------------|--------|
| `attachments` | `{company_id}/{entity}/{id}/…` | SELECT/INSERT if `is_company_member`; no cross-company listing |

---

## 9. Environment separation

| Env | Supabase | Vercel |
|-----|----------|--------|
| Local | Dev project or local | `npm run dev` |
| Preview | Staging project (recommended) | Preview deployments |
| Production | Prod project | Production |

Env vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (browser); `SUPABASE_SERVICE_ROLE_KEY`, AI keys (server only).

---

## 10. Deployment procedure (target)

1. PR → Vercel preview  
2. Apply migrations to **staging** (`supabase db push` / CI)  
3. Run automated tests against staging  
4. Promote: migrations to prod → deploy Vercel production  
5. Smoke: auth, switch company, post one journal, run TB  

Never apply unreviewed SQL to production by hand without migration file in repo.
