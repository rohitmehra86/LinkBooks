# Cross-cutting capabilities — acceptance evidence

**Branch:** `feature/foundational-production-readiness`  
**Policy:** [FX_ACCOUNTING_POLICY.md](./FX_ACCOUNTING_POLICY.md)  
**Migration (apply when approved):** `supabase/migrations/20261019200000_cross_cutting_settings_fx_demo.sql`  
**Remote migrate:** not applied without approval.

---

## Organisation settings

| Criterion | Evidence | Status |
|-----------|----------|--------|
| Organisation profile & legal details | Settings → Organisation; `updateCompany` | Pass (existing + retained) |
| Base currency | Settings → Financial; DB trigger blocks change after journals | Pass (code + migration) |
| Financial year & period controls | FY end on company; period lock/unlock under Accounting | Pass |
| Invoice & bill numbering | `document_sequences` + Settings → Documents | Pass (needs migration) |
| Tax configuration | Settings tax regime + `/tax` rates/codes | Pass |
| Users, roles & permissions | Settings → Users; `updateMemberRole` (last owner protected) | Pass |
| Document settings & branding | `company_branding` + Settings → Documents | Pass (needs migration) |
| Localization preferences | `locale`, `date_format`, theme, footer | Pass (needs migration) |

## Multi-currency

| Criterion | Evidence | Status |
|-----------|----------|--------|
| Policy defined before implementation | `FX_ACCOUNTING_POLICY.md` | Pass |
| Transaction + base currency | Journals `currency_code` / `fx_rate_to_base`; company base | Pass |
| Recorded exchange rates | `exchange_rates` append-only; void path | Pass (needs migration) |
| Deterministic rounding | `src/lib/accounting/fx.ts` + tests | Pass (unit) |
| Realised / unrealised treatment | `computeRealizedFx` / `computeUnrealizedFx` + FX P&L accounts 7700–7730 | Pass (helpers + CoA seed; settlement adapters can call helpers) |
| Reporting in base | TB/P&L/BS via `lineToBaseMinor` on journal snapshot | Pass (unit) |
| Never rewrite historical rates/journals | Trigger + void-only; journals immutable | Pass (migration + existing engine) |

## Firm & client

| Criterion | Evidence | Status |
|-----------|----------|--------|
| Firm accounts & multi-client | `/firm` create/list/link | Pass |
| Explicit firm→client auth | `firm_client_links` + owner/admin gate | Pass |
| Client switching / org context | Company switcher + active org in shell | Pass (existing) |
| Least-privilege firm access | access_level → role mapping | Pass |
| Client activity history | `listFirmClientActivity` on `/firm` | Pass |
| Multi-org users | Membership-scoped RLS; switcher lists all memberships | Pass (existing + contracts) |

## Audit & access

| Criterion | Evidence | Status |
|-----------|----------|--------|
| Actor, org, timestamp, action, entity | `audit_events` + `record_audit_event` | Pass |
| Settings/role/FX/firm audited | Server fns call `record_audit_event` | Pass |
| No secrets in audit | RPC strips password/token/api_key keys | Pass |
| Settings → Audit tab | `listCompanyAuditEvents` | Pass |

## Demo Company

| Criterion | Evidence | Status |
|-----------|----------|--------|
| Same engine as live | No `is_demo` in posting/FX/reporting | Pass (AGENTS.md + tests) |
| Isolated reset | `reset_demo_company` rejects non-demo; Settings → Demo | Pass (needs migration) |
| Reseed masters | CoA, periods, FX accounts, sequences | Pass (RPC) |

## Tests run

```
npx vitest run  → includes fx.test.ts, cross-cutting.test.ts, reporting, permissions, tenant-isolation
```

Covered in unit/contract form: org id validation, cross-tenant permission denial, role grant rules, FX conversion/rounding, TB base conversion, realised/unrealised math, demo.reset privilege isolation, period lock permissions.

**Not run against live Supabase in this delivery:** `reset_demo_company` RPC, rate void trigger, base-currency lock trigger (require approved migration apply).

## Honest limitations

- Email invite UI still not connected (no fake “invited” status).
- Logo is URL-only (no file storage integration).
- Realised FX helpers are ready; sales/purchase settlement adapters do not yet auto-post FX gain/loss lines on every payment (call sites can adopt helpers next).
- Unrealised revaluation is compute + manual journal / future job — not an automatic silent revaluation on rate insert.
- Notification toggles remain placeholders (explicitly disabled; not fake connected email).
- Migration not applied to remote project without approval.
