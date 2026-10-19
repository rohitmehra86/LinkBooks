# LinkBooks — Environment variables & deployment safety

**Never paste secret values into chat, commits, or docs.** This file lists **names only**.

## Variable names

| Name | Where used | Secret? |
|------|------------|---------|
| `VITE_SUPABASE_URL` | Browser + build | No (project URL) |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Browser + build | Publishable only |
| `VITE_SUPABASE_PROJECT_ID` | Optional / tooling | No |
| `SUPABASE_URL` | Server (Start / Vercel) | No |
| `SUPABASE_PUBLISHABLE_KEY` | Server auth middleware | Publishable only |
| `SUPABASE_SERVICE_ROLE_KEY` | Server admin client only | **Yes — never `VITE_*`** |
| `SUPABASE_PROJECT_ID` | Tooling | No |
| `LOVABLE_CRON_SECRET` | Cron auth (if used) | Yes — server only |
| `AI_API_KEY` / `OPENAI_API_KEY` | AI assistant provider | **Yes — never `VITE_*`** |
| `AI_BASE_URL` | OpenAI-compatible base URL | No (default api.openai.com) |
| `AI_MODEL` | Model id | No |
| `AI_MAX_REQUESTS_PER_HOUR` | Per-user+company rate limit | No |
| `AI_MAX_CONTEXT_CHARS` | Context budget | No |
| `AI_MAX_OUTPUT_TOKENS` | Completion cap | No |

## Environment separation

| Environment | Supabase project | Vercel |
|-------------|------------------|--------|
| Local development | Dev project (see `.env.example`) | `npm run dev` |
| Preview | Prefer **staging** project (recommended) | Vercel Preview |
| Production | Dedicated prod project | Vercel Production |

Do not point local/preview at production customer data.

## Auth redirect URLs (Supabase Dashboard → Authentication → URL configuration)

Add for each deployed host:

- Site URL (primary)
- Redirect allow list: `/auth`, `/reset-password`, and the app origin

## Migrations

1. All schema changes live under `supabase/migrations/`.
2. Review SQL for destructiveness before apply.
3. Apply to **development/staging first**.
4. **Do not apply to production without explicit approval.**
5. Rollback: prefer forward-fix migrations; restore from backup/PITR if needed.

## Service-role safety

- `src/integrations/supabase/client.server.ts` must never be imported from client components or shared modules that ship to the browser.
- Prefer user-scoped client via `requireSupabaseAuth` for CRUD.
- Bundle/CI check: fail if `SUPABASE_SERVICE_ROLE` / `sb_secret_` appears under `VITE_`.

## Recovery

- Confirm Supabase plan backups / PITR.
- Document one restore drill before real client money data.
