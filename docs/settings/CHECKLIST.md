# Settings Centre — completion checklist

**Programme:** Master Settings & Configuration Centre (brief v2)  
**Last updated:** 2026-10-22 (Stages 0–7 executed without gate stops per user request)

Status: `done` · `partial` · `unavailable` · `pending`

---

## Stage gates

| Stage | Status | Notes |
|-------|--------|-------|
| **0 — Audit** | done | `00-AUDIT.md`, `02-GAP-ANALYSIS.md` |
| **1 — Foundations** | done | Registry, RLS tables, RPCs, Feature Manager, shell, design |
| **2 — Core accounting** | done / partial | Two-tier locks + conversion + accounting prefs; tax via `/tax` link |
| **3 — Transactions** | partial | Config panels + preserved New Bill; late-fee jobs unavailable |
| **4 — Operations** | partial | Banking/dimensions/reports panels; fixed assets unavailable |
| **5 — Platform** | partial | Users/integrations/audit preserved; portals unavailable |
| **6 — Firm & commercial** | partial | Links + demo; subscription unavailable |
| **7 — Hardening** | partial | 193 tests green; docs written; a11y/perf follow-up |

---

## Deliverables

| Doc | Status |
|-----|--------|
| `00-AUDIT.md` | done |
| `01-DESIGN.md` | done |
| `02-GAP-ANALYSIS.md` | done |
| `03-SCHEMA-SERVICES.md` | done |
| `04-MODULE-INTEGRATION.md` | done |
| `05-TEST-REPORT.md` | done |
| `06-FUNCTIONALITY-MATRIX.md` | done |
| CHECKLIST | this file |

---

## Non-negotiables

- [x] Preferences never override posting / locks / idempotency
- [x] Lock dates enforced on journal insert (trigger + assert RPC)
- [x] Integrations/AI shown Unavailable when not built
- [x] New Bill surface preserved; feature flags gate dimensions/billable
- [x] Full suite green (193)
- [ ] Full RLS attack suite for new tables (follow-up)
- [ ] axe + responsive visual QA (follow-up)

---

## Outstanding (honest Unavailable / next slices)

1. Late fee generation job posting real invoice lines  
2. Reminder email delivery (needs email provider)  
3. Portals, fixed assets, subscription entitlements  
4. Live bank feeds / payment gateways  
5. Permission matrix UI, forced MFA, support access consent  
6. Hash-chain audit export  
7. Competitor migration wizards beyond CSV  

---

## Verification commands

```bash
npm test          # 193 passing
```

Remote schema applied via Supabase MCP (tables, RPCs, feature seed, journal lock trigger).
