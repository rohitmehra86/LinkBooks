# LinkBooks — security checklist (MVP)

## Must have before real client data

- [x] RLS enabled on **every current** business table (company-scoped) — Phase 2 tables
- [ ] Test: User A cannot read User B’s company data (**live 2-user staging test still required**)
- [x] Roles catalogue in DB (`role_permissions`) + server `has_company_permission` checks on settings/members
- [ ] Invite flow: email invite → join company with role
- [x] Last-owner protection (cannot remove last Owner) — DB trigger
- [x] Auth required on all server functions that touch company data
- [x] `.env` / secrets **not** committed (use `.env.example` only)
- [ ] Staging project ≠ production project
- [ ] Automated DB backups + one restore drill
- [ ] Audit log for money + user/role changes
- [ ] MFA for Owner/Admin before go-live with clients
- [x] No hard-coded demo figures shown as real company data (switcher/settings wired)

## Sensitive data practices

- TLS only (Supabase URL https)
- Least-privilege service keys (never ship service role key to browser)
- Publishable/anon key only in frontend
- Log access carefully — no full card/bank secrets in logs

## Lovable note

Repo is Lovable-connected: avoid force-push / history rewrite on `main` (see `AGENTS.md`).
