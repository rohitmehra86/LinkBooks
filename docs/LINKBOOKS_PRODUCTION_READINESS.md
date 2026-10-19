# LinkBooks — Production Readiness (Owner Gate)

| Field | Value |
|-------|-------|
| **Date** | 2026-10-19 |
| **Auditor role** | Owner-level final gate |
| **Supersedes** | [LINKBOOKS_PRODUCTION_READINESS_REPORT.md](./LINKBOOKS_PRODUCTION_READINESS_REPORT.md) for **go/no-go** (that report remains detailed command output); aligns with [LINKBOOKS_RELEASE_DECISION.md](./LINKBOOKS_RELEASE_DECISION.md) |

---

## Gate decision

| Audience | Decision |
|----------|----------|
| **Unrestricted commercial production** (paying SMBs, firm clients, real money) | **No-Go** |
| **Controlled friend demo** | **Conditional OK** |

### Friend-demo conditions (all required)

1. **Demo Company only** for narrative — do not onboard real client books without re-gate.
2. Host: https://linkbooks-navy.vercel.app — Supabase project `ipxflpzfcqwtenodbxwc` (migrations applied per owner).
3. Disclose limitations: no bank feeds, no email, no attachments, CoA read-only, tax codes not on lines, no CI/monitoring/backup drill evidence.
4. No marketing as “replacement for Xero/QBO.”
5. Owner accepts risk of **unproven live RLS E2E** until G-001 executed (acceptable only for fictional demo data with informed users).
6. Destructive ops (prod migration rollback, force data delete) require explicit owner approval.

**Owner authorisation:** Friend-demo deploy authorised; **commercial No-Go unchanged** (see updated [LINKBOOKS_RELEASE_DECISION.md](./LINKBOOKS_RELEASE_DECISION.md)).

---

## What was verified (2026-10-19)

| Item | Result | Notes |
|------|--------|-------|
| Unit tests | **124 passed** / 18 files | `npx vitest run` |
| Typecheck | Pass (prior report) | `tsc --noEmit` |
| Production build | Pass (prior report) | Vercel/Nitro artifact |
| Ledger MVP | **Present** | PostingEngine + `post_journal` + 8× `20261019` migrations |
| Authenticated routes | **54** route files under `_authenticated` | Feature catalog |
| Remote migrations | **Applied** (owner) | Supersedes “unknown” in 2026-10-19T13:44Z readiness report |
| Demo seed richness | **Updated in mandate** | `demo-dataset.ts`, `seed-demo.ts` via PostingEngine |

---

## What was **not** verified / still open

| Blocker | ID |
|---------|-----|
| Live 2-user RLS isolation | G-001 |
| E2E accounting on staging DB | G-002 |
| Backup restore drill | G-003 |
| Monitoring / alerting | G-004 |
| CI pipeline | G-006 |
| Scope document ratification | G-005 |
| Live demo TB after deploy | G-012 |
| Auth redirect smoke on Vercel | G-014 |

Full list: [LINKBOOKS_GAP_REGISTER.md](./LINKBOOKS_GAP_REGISTER.md).

---

## Environment variables (names only)

See [ENV_AND_DEPLOYMENT.md](./ENV_AND_DEPLOYMENT.md). Minimum for deployed app:

| Variable | Role |
|----------|------|
| `VITE_SUPABASE_URL` | Browser |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Browser |
| `SUPABASE_URL` | Server |
| `SUPABASE_PUBLISHABLE_KEY` | Server auth |
| `SUPABASE_SERVICE_ROLE_KEY` | Server admin (**secret**) |
| `AI_API_KEY` | Optional AI (**secret**, server only) |

**Never** prefix service role or AI keys with `VITE_`.

---

## Rollback & recovery

| Scenario | Procedure |
|----------|-----------|
| Bad app deploy | Vercel instant rollback to previous deployment |
| Bad schema migration | Forward-fix migration preferred; PITR if catastrophic (**drill not evidenced**) |
| Demo data corrupt | Demo reset/reseed RPC + `seedDemoCompanyData` (same engine) |

Operational detail: [ENV_AND_DEPLOYMENT.md](./ENV_AND_DEPLOYMENT.md), [SECURITY_CHECKLIST.md](./SECURITY_CHECKLIST.md).

---

## Cross-links (audit pack)

| Document | Purpose |
|----------|---------|
| [LINKBOOKS_FEATURE_CATALOG.md](./LINKBOOKS_FEATURE_CATALOG.md) | Module inventory |
| [LINKBOOKS_COMPETITIVE_BENCHMARK.md](./LINKBOOKS_COMPETITIVE_BENCHMARK.md) | Market comparison |
| [LINKBOOKS_GAP_REGISTER.md](./LINKBOOKS_GAP_REGISTER.md) | Remediation backlog |
| [LINKBOOKS_ACCOUNTING_INTEGRITY.md](./LINKBOOKS_ACCOUNTING_INTEGRITY.md) | Ledger rules |
| [LINKBOOKS_SECURITY_REVIEW.md](./LINKBOOKS_SECURITY_REVIEW.md) | RLS, auth, secrets |
| [LINKBOOKS_PRODUCTION_READINESS_REPORT.md](./LINKBOOKS_PRODUCTION_READINESS_REPORT.md) | Command-level verification log |
| [FOUNDATION_READINESS_REPORT.md](./FOUNDATION_READINESS_REPORT.md) | Earlier foundation pass |
| [LINKBOOKS_RELEASE_DECISION.md](./LINKBOOKS_RELEASE_DECISION.md) | Formal decision record |

---

## Path to commercial **Conditional Go** (summary)

Unchanged from release decision: staging ≠ prod, G-001–G-007 + G-014 + written out-of-scope list. **Full product Go** remains inappropriate until firm depth, feeds, invites, and integration evidence exist.
