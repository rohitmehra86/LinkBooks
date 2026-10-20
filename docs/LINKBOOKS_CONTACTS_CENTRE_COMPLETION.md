# LinkBooks Contact Management Centre — Completion Report

## Architecture inspected

- Existing thin `public.contacts` model (`kind`: customer|supplier|both|employee) shared by Sales and Purchases via `contact_id`.
- Server functions in `src/lib/contacts/contacts.functions.ts` with `contacts.manage` permission and company membership checks.
- AR/AP balances derived from `sales_invoices` / `purchase_bills` outstanding helpers (authoritative posted documents), not fabricated journals.
- Statements remain under Sales/Purchases modules; contact workspace links into those records.

## Files and migrations

| Area | Path |
|------|------|
| Migration | `supabase/migrations/20261020230000_contacts_centre.sql` |
| Helpers + tests | `src/lib/contacts/contact-helpers.ts`, `contact-helpers.test.ts` |
| APIs | `src/lib/contacts/contacts.functions.ts` |
| Directory | `src/routes/_authenticated/contacts/index.tsx` |
| Detail / edit | `src/routes/_authenticated/contacts/$contactId.tsx` |
| Settings | `src/routes/_authenticated/contacts/settings.tsx` |
| Import | `src/routes/_authenticated/contacts/import.tsx` |
| Duplicates / merge | `src/routes/_authenticated/contacts/duplicates.tsx` |

### Schema additions (additive, preserves IDs)

- Contact columns: account number, legal name, website, currency, credit limit, billing/delivery address fields, default sales/purchase accounts, tax-inclusive flags, `archived_at`.
- `contact_people`, `contact_addresses`, `contact_groups` + members, `contact_tags` + assignments, `company_contact_settings`.
- RLS via `is_company_member` / `has_company_permission(..., 'contacts.manage')`.

## Features implemented

- Directory views: all, customers, suppliers, both roles, recent, updated, inactive, archived.
- Financial summary from open invoices/bills (receivable, payable, overdue) in org base currency.
- Search across name, email, phone, account number, tax ID, legal name.
- Quick create + full edit (identity, addresses, notes ≤4000, roles).
- People add/remove; groups & tags assign; settings for numbering/defaults.
- CSV template, import with skip-duplicates, export with formula-injection protection.
- Duplicate detection with explicit merge (reassign document FKs, archive loser; no journal rewrite).
- Contact detail AR/AP overview and transaction links to real invoice/bill routes.

## Implemented but environment-dependent

- Default sales/purchase account FKs exist in schema; UI wiring for account pickers can be extended when catalog UX is reused.
- Email statements / scheduled reminders require a configured email provider (not claimed here).
- Address autocomplete requires a configured provider; manual entry always works.
- Custom fields table not added (architecture had no prior custom-field infra for contacts); groups/tags cover flexible classification for now.
- Bulk multi-select updates beyond group/tag save are partial (per-contact and import cover primary paths).

## Blocked / deferred with dependencies

| Feature | Dependency |
|---------|------------|
| Customer statement PDF from contact workspace | Reuse Sales statements route/provider |
| Sensitive bank detail encryption/masking | Org vault / field-level encryption not present |
| Organization-wide saved views persistence | User preference store beyond local UI state |
| Concurrent merge locks | Needs DB advisory lock / merge audit table for enterprise recovery trail |

## Accounting integrity

- Single canonical contact; dual roles via `kind = both`.
- Balances from outstanding on authorised/partly_paid documents only.
- Defaults change does not rewrite posted transactions.
- Merge reassigns `contact_id` on documents; does not recreate journals or amounts.
- Archive/restore does not cascade-delete accounting records.

## Security

- All mutations require `contacts.manage` server-side.
- Tenant scoped by `company_id` on every query.
- CSV export excludes bank credentials (none collected).
- Formula-injection prefixing on export cells.

## Deployment steps

1. Apply migration `20261020230000_contacts_centre.sql` to Supabase.
2. Deploy app (Vercel) so new routes and server functions ship together.
3. Smoke: create contact → edit → add person → assign group → export CSV → import template → scan duplicates.

## Known limitations

- Directory pagination capped (server limit 500); large tenants may need cursor pagination next.
- Merge audit trail is notes-based on archived contact; dedicated `contact_merges` table recommended for formal recovery.
- Unlike-currency aggregation uses company base currency fields on documents; multi-currency contact rollups need FX policy if invoice currencies diverge.
