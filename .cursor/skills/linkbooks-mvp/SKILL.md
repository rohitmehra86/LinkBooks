---
name: linkbooks-mvp
description: >-
  LinkBooks Xero-like accounting app (Lovable React + Supabase). Use when working
  on LinkBooks, company tenancy, roles/RLS, roadmap Phase 2, or MVP hardening.
  Do not mix with Paxo hybrid platform work.
---

# LinkBooks MVP

## Decisions (do not reopen casually)

- Keep **Supabase** auth + Postgres + RLS
- **No Java rewrite** for v1
- **No Paxo** auth/deploy for v1
- Finish **Phase 2** company/tenant UI before Phase 3 features

## Key paths

- Auth routes: `src/routes/_authenticated/`, `src/routes/auth.tsx`
- Company helpers: `src/lib/company.functions.ts`, `src/hooks/use-active-company.ts`
- Supabase: `src/integrations/supabase/`, `supabase/migrations/`
- Roadmap: `roadmap.md`
- Architecture: `docs/ARCHITECTURE_MVP.md`
- Security: `docs/SECURITY_CHECKLIST.md`

## Rules from AGENTS.md

- UI auth gate is UX only; real protection = server auth + RLS
- `is_demo` must not change posting/validation/reporting logic
- Do not force-push / rewrite Lovable-connected git history

## Default next work

1. Company switcher in top bar
2. Onboarding create-company
3. Settings tabs on real company data
4. Two-user isolation test
