# Security and permissions

## Auth
- Supabase email/password.
- `_authenticated` route gate is UX-only.
- Server: `requireSupabaseAuth` on createServerFn.

## Authorization
- Roles: owner, admin, accountant, bookkeeper, staff, read_only.
- `role_permissions` (~152 rows) + `has_company_permission`.
- Settings mutations: `company.settings.edit`; locks: `periods.lock`.
- Demo reset: `demo.reset` + `is_demo` company flag.

## Isolation
- RLS on tenant tables via `is_company_member` / permission helpers.
- Settings config/features: SELECT for members; writes only via SECURITY DEFINER RPCs (no direct client INSERT/UPDATE).
- Secrets table: no client SELECT of ciphertext.

## Open risks (tracked)
- Live RLS attack E2E not automated in CI.
- Invitation email not configured (token-only).
- MFA / SSO / IP allow-lists not enforced.
- `npm audit` reports vulnerabilities in transitive deps (review in M12).
