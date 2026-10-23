# Current architecture (verified 2026-10-23)

**Branch baseline:** `main` @ `f50fe31` (pulled), work continues on `cto-master-programme`.

## Verified stack

| Layer | Actual |
|-------|--------|
| UI | React 19.2 + React DOM |
| Language | TypeScript 5.8 (strict) |
| App | TanStack Start 1.168 + Router 1.170 + Query 5.101 |
| Build | Vite 8.1.5 + Nitro (SSR) |
| CSS | Tailwind 4.2 + `@tailwindcss/vite` |
| Forms | React Hook Form 7.71 + Zod 3.25 |
| Charts | Recharts 2.15 |
| Backend | Supabase JS 2.117 → Postgres + Auth + RLS |
| Hosting | Vercel (`linkbooks-navy.vercel.app`) |
| Tests | Vitest 3.2 (**236** passing after `npm install`) |
| Edge functions | **None** in repo (`supabase/functions` absent) |

## Runtime shape

```
Browser (TanStack Start)
  → createServerFn (requireSupabaseAuth)
    → Supabase client (user JWT)
      → RLS + SECURITY DEFINER RPCs
        → post_journal / reverse_journal (authoritative ledger)
```

## Module ownership (shared services)

| Concern | Owner |
|---------|-------|
| Posting | `src/lib/accounting/posting-engine.ts` → `post_journal` RPC |
| Money / FX | `src/lib/accounting/money.ts`, `fx.ts` |
| Reporting | `src/lib/accounting/reporting.ts` + `accounting.functions.ts` |
| Sales | `src/lib/sales/*` |
| Purchases | `src/lib/purchases/*` |
| Banking | `src/lib/banking/*` |
| Settings | `src/lib/settings/*` |
| Create menu | `src/lib/create-new/registry.ts` + flyover panels |
| Demo | `src/lib/demo/seed-demo.ts` + volume layer |

## Design decisions (locked)

1. Single posting engine for all modules.
2. `is_demo` never forks posting/validation/reporting.
3. UI auth gate is UX-only; RLS + server auth enforce tenancy.
4. Create menu actions that are not ledger-verified stay **blocked** (honest).
