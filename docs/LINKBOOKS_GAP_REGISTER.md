# LinkBooks — Gap Register (Owner Audit)

| Field | Value |
|-------|-------|
| **Date** | 2026-10-19 |
| **Owner** | Product / engineering audit |
| **Supersedes** | Gap tables inside [LINKBOOKS_RELEASE_DECISION.md](./LINKBOOKS_RELEASE_DECISION.md) (retained for decision history) |

Severity: **Critical** = customer data / money / legal exposure; **High** = major product promise or ops; **Medium** = depth or UX debt; **Low** = polish or future scope.

| ID | Severity | Module | Gap | Remediation | Dependency |
|----|----------|--------|-----|-------------|------------|
| G-001 | Critical | Security | No **live** 2-user × 2-company RLS isolation proof | Staging script: User A cannot read/write Company B; signed evidence | Staging Supabase ≠ prod |
| G-002 | Critical | QA | No E2E golden paths (invoice→receipt→TB; bill→payment→AP) on real DB | Playwright or API integration suite against staging | Migrations on staging |
| G-003 | Critical | Ops | **Backup / PITR restore drill** not documented | Enable backups; run one restore; attach evidence | Supabase plan / owner |
| G-004 | Critical | Ops | No production **monitoring / error reporting** | Sentry (or equivalent) + uptime checks | Vercel + vendor account |
| G-005 | Critical | Governance | Full Product Scope MD still **not in repo** | Ratify `docs/plan/*` or add scope file + delta | Product owner sign-off |
| G-006 | High | Engineering | **No CI** (typecheck, test, build) | Add `.github/workflows`; gate merges | Repo hygiene |
| G-007 | High | Engineering | Lint fails at scale (~1416 Prettier issues per prior report) | Format baseline PR; enforce in CI | G-006 |
| G-008 | High | Accounting | Live **concurrency / idempotency race** on `post_journal` not tested | Parallel RPC integration test | Staging DB |
| G-009 | High | Accounting | **Period lock** deny not live-proven | Post into locked period → expect SQL error | Staging |
| G-010 | High | Accounting | Document lifecycle (void, reversal chains) not E2E-proven | DB-backed scenarios per doc type | G-002 |
| G-011 | High | Reports | UI reports not tied to **SQL aggregates** on staging | Automated compare TB/P&L/BS | Staging data fixture |
| G-012 | High | Demo | Live **demo reseed** vs `DEMO_EXPECTED` not evidenced post-deploy | Run reset on https://linkbooks-navy.vercel.app; snapshot TB | Friend-demo deploy |
| G-013 | High | Settings | **Email invites** / member join incomplete | Transactional email provider + templates | Vendor + DNS |
| G-014 | High | Auth | Supabase **Site URL / redirect** list not checklist-verified for Vercel host | Dashboard audit per [ENV_AND_DEPLOYMENT.md](./ENV_AND_DEPLOYMENT.md) | Deploy access |
| G-015 | High | Banking | **Reconcile → ledger** not E2E-proven | Staging reconcile session test | G-002 |
| G-016 | Medium | Banking | **Live bank feeds** absent | Aggregation partner (Plaid, Yapily, etc.) | Commercial + compliance |
| G-017 | Medium | Sales/Purchases | **Tax codes on document lines** not wired (bps fields only) | Line UI → `tax_codes`; posting splits | Tax module schema |
| G-018 | Medium | Accounting | **CoA CRUD UI** missing (seed read-only) | Account create/archive with validation | Posting rules for new accounts |
| G-019 | Medium | Documents | **Attachments / OCR** / Storage | Supabase Storage buckets + RLS + UI | G-001 pattern |
| G-020 | Medium | Sales/Purchases | Quotes / recurring / PO depth thin vs nav | Product prioritisation + E2E | Roadmap |
| G-021 | Medium | Product | **Products & Services** shell while nav visible | Wire catalogue or demote nav until ready | Inventory decision |
| G-022 | Medium | Firm | Firm multi-client isolation not tested live | Firm membership RLS script | G-001 |
| G-023 | Medium | AI | Provider abuse / cost caps live-unverified | Rate limits exist in code; monitor in prod | G-004 |
| G-024 | Medium | Compliance | Tax **filing** / MTD not built | Jurisdiction-specific builds | Legal scope |
| G-025 | Medium | Finance | Cash flow statement = bank proxy only (if shown) | Proper cash flow report | Accounting design |
| G-026 | Low | Shell | Global search, notifications, quick create disabled | Post-MVP | — |
| G-027 | Low | Help | Help is FAQ shell, not ticketing | Support tool integration | — |
| G-028 | Low | DevEx | DevDependency advisories (vitest/tinypool) | Upgrade vitest toolchain | G-006 |
| G-029 | Low | Inventory | Inventory, payroll, fixed assets, budgets, projects | Explicitly out of MVP | Roadmap |
| G-030 | Medium | Process | Prior readiness report said migrations **unknown**; owner states **applied** on `ipxflpzfcqwtenodbxwc` | Record migration version in Supabase dashboard screenshot / `list_migrations` in change log | Owner verification |

---

## Remediation priority (recommended)

1. **Before any paying customer:** G-001, G-002, G-003, G-004, G-006, G-005, G-014.
2. **Before expanding friend demo audience:** G-012, G-011 (smoke), G-014.
3. **Before marketing “full accounting”:** G-016–G-019, G-013.

---

## Cross-links

- [LINKBOOKS_SECURITY_REVIEW.md](./LINKBOOKS_SECURITY_REVIEW.md) — G-001, G-014
- [LINKBOOKS_ACCOUNTING_INTEGRITY.md](./LINKBOOKS_ACCOUNTING_INTEGRITY.md) — G-008–G-010
- [LINKBOOKS_PRODUCTION_READINESS.md](./LINKBOOKS_PRODUCTION_READINESS.md) — gate summary
