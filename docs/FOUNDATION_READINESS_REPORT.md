# Foundation production-readiness — implementation report

**Branch:** `feature/foundational-production-readiness`  
**Date:** 19 Oct 2026  
**Environment:** Local development / preview only. **No production migration applied.**

## Checkpoint

- Existing uncommitted docs (`docs/audit`, `docs/plan`, etc.) preserved on the feature branch.
- Intended target: development Supabase project + local/Vercel preview — not unverified production.

## What changed

### Auth & session
- Protected routes still gate on `supabase.auth.getUser()` (`src/routes/_authenticated/route.tsx`).
- Logout clears React Query + signs out (`AppShell`).
- Session refresh: `TOKEN_REFRESHED` now invalidates router/queries (`__root.tsx`).
- Password recovery routes unchanged (existing supported flow).
- Server functions remain behind `requireSupabaseAuth` + bearer attach (`auth-attacher.ts`).

### Multi-tenant UI + server authz
- Real **company switcher** (`CompanySwitcher.tsx`) wired to `getCompanyContext` / `setActiveCompany`.
- **Onboarding** at `/onboarding` — create company or open demo.
- Auto-redirect to onboarding when user has zero companies.
- **Settings** loads/saves real company + tax settings; lists members.
- Server: `assertCompanyMember` / `assertCompanyPermission` on switch, details, update, members list.

### Supabase security
- No RLS disabled.
- No service-role exposure via `VITE_*` (runtime assert + unit tests).
- Additive migration prepared (permissions + indexes) — **not applied remotely**.

### Data integrity
- Migration adds indexes and expands `role_permissions` with `ON CONFLICT DO NOTHING`.
- Existing FKs / last-owner guards retained.

### Reliability
- Loading / error / empty states on company load, settings, switcher.
- Form validation via shared `company-validation.ts`.
- Inert Search / New / Notifications disabled (no fake success).
- Demo banner only when `company.is_demo`.

### Deployment safety docs
- `docs/ENV_AND_DEPLOYMENT.md` — variable **names** only.
- `.env.example` updated (service role commented, never `VITE_`).
- `supabase/.temp/` gitignored.

### Tests
- Vitest added; `npm test` / `npm run typecheck`.

## Migrations created (not applied)

| File | Effect | Destructive? |
|------|--------|--------------|
| `supabase/migrations/20261019120000_permissions_expand_and_indexes.sql` | Insert permission rows; create indexes IF NOT EXISTS | **No** |

**Approval required** before applying to any shared/staging/production database.

## Tests run

```
npm run typecheck  → pass
npm test           → 4 files, 18 tests passed
```

Not run (no CI credentials / explicit staging): live 2-user RLS isolation against Supabase.

## Unresolved risks

1. Migration not applied — expanded permissions exist in app matrix but DB may still have the smaller seed until migration runs.
2. Live 2-user × 2-company isolation test not executed in this session.
3. Invite-by-email still not implemented.
4. No ledger / financial tables yet (expected; Phase 3).
5. `npm audit` still reports vulnerabilities in the dependency tree (not remediated here).
6. Staging vs production Supabase separation still an ops decision.
7. Service-role key may be unset on Vercel — admin client unused by these paths but must stay server-only when added.

## Exact next steps

1. **Approve** applying `20261019120000_permissions_expand_and_indexes.sql` to the **dev** Supabase project (not production).
2. Local smoke: sign up → onboarding → create company → switch → settings save → sign out.
3. Manual isolation: two users, two companies; confirm cross-read fails.
4. Configure Supabase Auth redirect URLs for Vercel preview/prod.
5. Open PR from `feature/foundational-production-readiness` to `main` when smoke passes.
6. Then Phase 3 ledger (PostingEngine) per `docs/plan/06_*.md`.
