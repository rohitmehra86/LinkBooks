# LinkBooks — security checklist (MVP)

## Must have before real client data

- [ ] RLS enabled on **every** business table (company-scoped)
- [ ] Test: User A cannot read User B’s company data
- [ ] Roles enforced in DB (`role_permissions`), not only UI
- [ ] Invite flow: email invite → join company with role
- [ ] Last-owner protection (cannot remove last Owner)
- [ ] Auth required on all server functions that touch data
- [ ] `.env` / secrets **not** committed (use `.env.example` only)
- [ ] Staging project ≠ production project
- [ ] Automated DB backups + one restore drill
- [ ] Audit log for money + user/role changes
- [ ] MFA for Owner/Admin before go-live with clients
- [ ] No hard-coded demo figures shown as real company data

## Sensitive data practices

- TLS only (Supabase URL https)
- Least-privilege service keys (never ship service role key to browser)
- Publishable/anon key only in frontend
- Log access carefully — no full card/bank secrets in logs

## Lovable note

Repo is Lovable-connected: avoid force-push / history rewrite on `main` (see `AGENTS.md`).
