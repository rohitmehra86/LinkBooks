# Database schema snapshot (live project `ipxflpzfcqwtenodbxwc`)

**Migrations on disk:** 29 files under `supabase/migrations/`.  
**RLS:** enabled on all listed tenant tables.

## Core ledger
`accounts`, `accounting_periods`, `journals`, `journal_lines`, `audit_events`, `currency_decimals`

## Tenancy / auth
`profiles`, `companies`, `company_members`, `role_permissions`, `company_invitations`

## Operational (row counts indicative, Demo-heavy)
| Table | ~rows | Notes |
|-------|------:|-------|
| accounts | 61 | across companies |
| journals | 36 | posted+ |
| journal_lines | 87 | |
| sales_invoices | 248 | many draft volume shells |
| purchase_bills | 371 | many draft volume shells |
| bank_transactions | 420 | |
| contacts | 90 | |
| organisation_features | 46 | Settings Feature Manager |
| firms / firm_* | 0 | not populated |

## Settings Centre
`organisation_config`, `organisation_features`, `organisation_lock_policy`, `settings_change_log`, `organisation_secrets`

## Create-new / CoA enterprise
`money_documents`, `money_document_lines`, `projects`, `inbox_documents`, `coa_audit_log`, `coa_industries`, …

Full column detail: use Supabase dashboard or `list_tables` verbose when changing schema.
