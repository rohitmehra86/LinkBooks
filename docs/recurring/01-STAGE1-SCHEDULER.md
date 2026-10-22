# Stage 1 — Scheduler deployment

## What exists in code

| Piece | Location |
|-------|----------|
| Due schedule batch processor | `src/lib/recurring/scheduler.ts` |
| Idempotent bill generation | `src/lib/recurring/generate-purchase-bill.ts` + RPC `recurring_claim_occurrence` |
| Cron server function | `runRecurringScheduler` in `src/lib/recurring/recurring.functions.ts` |
| Run log table | `recurring_generation_runs` |

## Authentication

`runRecurringScheduler` requires:

```http
Authorization: Bearer <LOVABLE_CRON_SECRET>
```

Set `LOVABLE_CRON_SECRET` on Vercel (Production + Preview). Without it, cron auth returns **500** (misconfiguration).

## Suggested wiring (Vercel Cron)

1. Add a cron job in the Vercel project targeting the TanStack Start server-fn URL for `runRecurringScheduler` (POST), daily or hourly.
2. Use the secret header above — **never** expose the secret to the browser.

Exact server-fn URL depends on TanStack Start routing; verify in devtools Network tab when invoking the function once from a secured script.

## Suggested wiring (manual / ops)

```bash
source ~/.config/linkbooks/cli.env
cd /Users/m5/Projects/LinkBooks
supabase db push   # apply Stage 1 migration if not applied
# Invoke server fn via your deployed cron URL or local dev with secret header
```

## Service role

Automated runs use `SUPABASE_SERVICE_ROLE_KEY` via `supabaseAdmin` so schedules process across tenants without a browser session. Generation still records `created_by` / owner from the template.

## Stage 1 gate tests

- `npm test` — `recurrence-engine.test.ts`, `occurrence-key.test.ts`
- Apply migration and verify `supabase migration list` shows `20261022173000`
- Manual double-click **Generate** on same due date → second call returns same bill (occurrence completed), not a duplicate row

## Not in Stage 1

- Sales invoice scheduler batch (manual generate still uses legacy path)
- pg_cron SQL-only worker
- Exception centre UI
