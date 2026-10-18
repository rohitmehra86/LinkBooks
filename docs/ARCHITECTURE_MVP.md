# LinkBooks — MVP architecture (decision)

## Decision

| Choice | Decision |
|--------|----------|
| Stack | Keep **React + Vite + TanStack + Supabase** |
| Auth | **Supabase Auth** (not Paxo / Keycloak / custom Java) |
| Rewrite to Java? | **No** for v1 |
| Paxo platform? | **No** for v1 — separate product |
| Goal | Hardened multi-company accounting MVP your friend can use |

## Shape

```
Browser (React UI)
    → Supabase Auth (login / session)
    → Postgres + RLS (tenant + role enforcement)
    → Server functions (company switch, invites, money rules)
```

## Tenancy model

- User → member of one or more **companies**
- Active company in session (`last_company_id` / switcher)
- Every business row scoped by `company_id`
- **RLS** is the real security boundary (UI gate alone is not enough)

## Roles (start with four)

| Role | Intent |
|------|--------|
| Owner | Full control, billing, delete company |
| Admin | Users + settings + all books |
| Accountant | Day-to-day posting, no user admin |
| Viewer | Read-only |

## Non-negotiables for accounting

- Demo company uses the **same** posting engine as real companies (`is_demo` only for reset/billing/UI hints)
- Posted journals: reverse/void — no silent delete
- Audit: who changed what, when
- Staging separate from production before real client data

## Phases

1. **Now** — Finish Phase 2 (company switcher, onboarding, settings on real company, 2-user isolation test)
2. **MVP** — Invoices / contacts / basic ledger your friend prioritizes
3. **Later (optional)** — Dedicated ledger service (could be Java) *beside* Supabase — not a full rewrite
