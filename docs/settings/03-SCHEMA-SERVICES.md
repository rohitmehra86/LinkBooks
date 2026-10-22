# Schema & services

## Tables
| Table | Purpose | Client writes |
|-------|---------|---------------|
| `organisation_config` | Typed category JSON documents + version | **No** — RPC only |
| `organisation_features` | Feature Manager enablement | **No** — RPC only |
| `organisation_lock_policy` | Two-tier locks + conversion date | **No** — RPC only |
| `settings_change_log` | Per-change audit | **No** — RPC insert |
| `organisation_secrets` | Opaque secret digests + last4 | **No** — never readable |

## RPCs
- `upsert_organisation_config` — Zod-validated in app, optimistic concurrency
- `set_organisation_feature` — Feature Manager mutations
- `set_organisation_lock_policy` — requires `periods.lock` + reason
- `assert_journal_date_unlocked` — called from `post_journal`
- `write_organisation_secret` / `list_organisation_secret_meta`
- `is_company_advisor` — owner/admin/accountant

## App services
- `src/lib/settings/registry.ts` — IA, synonyms, Zod schemas
- `src/lib/settings/feature-catalog.ts` — five-state engine
- `src/lib/settings/dependency-engine.ts` — impact rules
- `src/lib/settings/settings-centre.functions.ts` — server functions

## Migration
`supabase/migrations/20261022180000_settings_centre_foundation.sql`
