# Deployment readiness

| Gate | Status |
|------|--------|
| Tests green | **236 pass** locally |
| Critical accounting defects | Demo AR/GL repaired; engine intact |
| Migrations on disk | Include Settings + Create New + CoA enterprise |
| Production Vercel | Auto-deploys from `main`; this work is on `cto-master-programme` until PR |
| Commercial Go | **No-Go** until M4–M12 depth, RLS E2E, email, CI monitoring per prior CTO report |

## Release process
1. PR `cto-master-programme` → `main` (no force-push).
2. Confirm Vercel success status on merge commit.
3. Confirm Supabase migrations applied (MCP/`db push` with IPv4 if needed).
4. Smoke: login → Demo reset → AR ageing = GL → New Bill authorise → TB.
