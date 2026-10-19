# LinkBooks — Security Review (Owner Audit)

| Field | Value |
|-------|-------|
| **Date** | 2026-10-19 |
| **Verdict** | **Design adequate for MVP**; **live tenant isolation unproven** — not cleared for unrestricted commercial production |
| **Supersedes** | Phase 3 tables in [LINKBOOKS_PRODUCTION_READINESS_REPORT.md](./LINKBOOKS_PRODUCTION_READINESS_REPORT.md) |

## Threat model (summary)

| Asset | Risk if compromised |
|-------|---------------------|
| Multi-tenant company data (AR/AP, bank, journals) | Cross-tenant read/write |
| `SUPABASE_SERVICE_ROLE_KEY` | Full database bypass |
| User sessions (JWT) | Impersonation, data exfiltration |
| AI provider key (`AI_API_KEY`) | Cost abuse, prompt injection to suggestions |

---

## Authentication

| Control | Implementation | Status |
|---------|----------------|--------|
| App route gate | Client-only session under `src/routes/_authenticated/`; redirects to `/auth` | UX only — **not** security boundary |
| Server mutations | `requireSupabaseAuth` on server functions | Implemented; **no exhaustive audit log of every fn** |
| Public auth routes | `/auth`, `/forgot-password`, `/reset-password` | Standard Supabase Auth |
| MFA | — | **Not implemented** |

**Gap (G-014):** Production Site URL and redirect allow-list for https://linkbooks-navy.vercel.app not attached as signed evidence.

---

## Authorization & roles

| Layer | Mechanism | Evidence |
|-------|-----------|----------|
| UI hints | `roleHasPermission` matrix | `permissions.test.ts` |
| Server | `assertCompanyPermission` / RPC `has_company_permission` | `permissions.ts`, SQL in migrations |
| Database | RLS policies on company-scoped tables | `20261019*` migrations |

**Contract tests** (`tenant-isolation.test.ts`) explicitly state: *“Live Supabase 2-user isolation remains a manual/staging checklist.”*

| Test type | What it proves | What it does **not** prove |
|-----------|----------------|----------------------------|
| Contract (UUID, role matrix) | Invalid ids rejected; staff cannot manage members in matrix | Postgres RLS denies cross-tenant SELECT |
| Unit mocks | Posting permission errors simulated | Real JWT from two users |

**Classification:** Tenant isolation = **Blocked for commercial release** until G-001 closed.

---

## Row Level Security (RLS)

- RLS **enabled** on journals, journal_lines, sales/purchases/banking entities, settings extensions, firm, AI tables (per migration files).
- Policies generally: `authenticated` + `is_company_member(company_id)` for SELECT; stricter checks for INSERT/UPDATE where applicable.
- **Posting** uses `SECURITY DEFINER` `post_journal` with internal permission checks — correct pattern if function body stays hardened.

**Risks to monitor:**

| Risk | Mitigation | Verified live? |
|------|------------|----------------|
| Policy gap on new table | Migration review checklist | No |
| `SECURITY DEFINER` over-permission | Minimal `search_path`, explicit membership checks | Code review only |
| Service role misuse | Server-only import | `env-safety.test.ts` |

---

## Service role & secrets

| Secret | Exposure rule | Evidence |
|--------|---------------|----------|
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Browser | OK |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only; never `VITE_*` | `client.server.ts`, `env-safety.test.ts` |
| `AI_API_KEY` / `OPENAI_API_KEY` | Server only | `ai.functions.ts` |
| `LOVABLE_CRON_SECRET` | Cron endpoints if used | Documented in ENV doc |

**Deploy verification required:** Confirm Vercel Production env has no `VITE_` prefix on service or AI secrets.

---

## AI Assistant

| Control | Status |
|---------|--------|
| No auto-post without user confirm | Code path in `ai.functions.ts` |
| Permission `ai.apply_suggestion` (or equivalent) | Gated apply |
| Prompt sanitization | Partial — `ai.test.ts` |
| Rate limits | `AI_MAX_REQUESTS_PER_HOUR` env |

Treat AI output as **untrusted**; journals still pass `post_journal` rules.

---

## Storage & attachments

- No document **Storage** buckets or attachment flows found in migrations for MVP.
- **Risk deferred** until G-019; when added, bucket RLS must be first-class.

---

## Audit trail

- `audit_events` / `record_audit_event` for sensitive actions (settings, demo, AI writes).
- **Gap:** Not proven that every money-moving action emits an audit row in staging.

---

## Dependency & supply chain

- `npm audit --omit=dev`: clean at last readiness pass.
- Dev tooling (vitest/tinypool): advisories — CI/dev machines only (G-028).

---

## Security test matrix

| Control | Contract/unit | Live RLS E2E |
|---------|---------------|--------------|
| UUID validation | Pass | N/A |
| Role matrix | Pass | N/A |
| RLS deny cross-tenant | **Not tested** | **Required** |
| Anon cannot read journals | **Not tested** | **Required** |
| `post_journal` without permission | SQL design | Staging test |
| Secret not in client bundle | `env-safety` | CI bundle scan (missing) |

---

## Recommendations (ordered)

1. Execute G-001 staging isolation script; attach results to this doc or ops folder.
2. Add CI job: grep/build fail on `VITE_.*SERVICE` / `sb_secret_` in client graph.
3. Complete G-014 auth URL checklist for friend-demo host.
4. When enabling Storage: threat model + penetration test on signed URLs.
5. Optional: MFA for owner roles before commercial launch.

---

## Related documents

- [SECURITY_CHECKLIST.md](./SECURITY_CHECKLIST.md)
- [LINKBOOKS_GAP_REGISTER.md](./LINKBOOKS_GAP_REGISTER.md)
- [ENV_AND_DEPLOYMENT.md](./ENV_AND_DEPLOYMENT.md)
- [LINKBOOKS_PRODUCTION_READINESS.md](./LINKBOOKS_PRODUCTION_READINESS.md)
