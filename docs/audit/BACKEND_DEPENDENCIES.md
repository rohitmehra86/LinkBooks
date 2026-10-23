# Backend dependencies

## Server functions
All mutations use TanStack `createServerFn` + `requireSupabaseAuth`. Key packages under `src/lib/`:

- `accounting/` — posting, CoA, reporting, chart
- `sales/`, `purchases/`, `banking/`, `contacts/`, `tax/`, `products/`
- `settings/` — org, workflow, dimensions, settings-centre
- `create-new/` — money documents, journals contracts, registry
- `recurring/` — templates, schedules, generation
- `demo/` — seed + reset
- `assert-company-access.ts`, `permissions.ts`

## Database RPCs (critical)
- `post_journal`, `reverse_journal`
- `lock_accounting_period`, `unlock_accounting_period`
- `assert_journal_date_unlocked` + trigger `journals_lock_dates_trg`
- `upsert_organisation_config`, `set_organisation_feature`, `set_organisation_lock_policy`
- `allocate_document_number`, `record_audit_event`
- `create_company`, `create_demo_company`, `reset_demo_company`
- `has_company_permission`, `is_company_member`, `is_company_advisor`

## External services
| Service | Status |
|---------|--------|
| Supabase Auth / Postgres / Storage | live |
| Outbound email | not configured |
| Bank aggregator / payment gateway | not configured |
| Live FX feed | not configured |
| AI provider | env optional; UI honest |

## No Nest/Spring API; no Redis; no edge functions in repo.
