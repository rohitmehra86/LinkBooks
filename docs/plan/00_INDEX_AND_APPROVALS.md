# LinkBooks — Target Architecture & Implementation Plan

**Status:** Planning only — **no application code changes** in this step.  
**Date:** 19 Oct 2026  
**Inputs:** Approved audit (`docs/audit/*`), repository as-is, Phase 2 design (`.lovable/plan.md`), this briefing’s product requirements.

## Requirements baseline note

**"LinkBooks — Full Product Scope and Implementation Standard.md" was not found** on disk (repo, Desktop, Downloads, Documents, or agent stores).  

This plan treats the **user brief in the planning request** plus existing audit/Phase 2 docs as the working product baseline.  

**Approval needed:** Confirm this plan as interim SSR, or place the Full Product Scope file under `docs/` and request a delta pass.

---

## Document index

| # | Document | Contents |
|---|----------|----------|
| 00 | This file | Index + decisions requiring approval |
| 01 | `01_NAVIGATION_TREE.md` | Full product navigation (core / later / external) |
| 02 | `02_TARGET_ARCHITECTURE_AND_DATA_MODEL.md` | Stack, tenancy, ER design, services |
| 03 | `03_ACCOUNTING_POSTING_RULES.md` | Single posting engine rules |
| 04 | `04_SECURITY_AND_PERMISSIONS_MATRIX.md` | Roles, permissions, RLS, firm access |
| 05 | `05_FEATURE_CATALOGUE_AND_ACCEPTANCE.md` | Feature-by-feature UI/BE/DB/perms/accounting/tests/AC |
| 06 | `06_DEPENDENCY_MAP_AND_PHASED_BACKLOG.md` | Dependencies + phased backlog |
| 07 | `07_MIGRATION_AND_TEST_STRATEGY.md` | Schema migration + test strategy |

**Non-goals of this step:** implement code, shrink product to invoicing-only, remove agreed modules.

**Product intent (locked for planning):** comprehensive accounting platform for SMBs, freelancers, bookkeepers, accountants, and accounting firms — not a minimal invoicing app.

---

## Decisions requiring your approval

Before implementation starts, please decide:

### A. Product & markets
1. **Primary launch markets** — Confirm UK (+GB VAT) first, then AU/NZ/US/CA/EU as Phase 2+ tax packs? Or multi-market day one?
2. **Base currency model** — Single base currency per company (recommended) with optional multi-currency transactions later?
3. **Fixed assets** — In scope for Core (Phase E) or Later (Phase G)? *Recommendation: Later — after TB/P&L/BS and AR/AP.*
4. **Employee expenses / reimbursements** — Core Purchases track or Later? *Recommendation: Later after bills + supplier payments.*
5. **Bank feeds** — Which providers first (Plaid / TrueLayer / GoCardless / manual CSV only)? *External dependency.*
6. **Firm portal timing** — Ship firm/client management in Phase F (after SMB ledger works) or parallel? *Recommendation: after Phase D reports.*

### B. Accounting policy
7. **Journal states** — Approve proposed lifecycle: `draft → approved → posted`; `voided` (never posted); `reversed` via reversing journal (posted history immutable). See `03_`.
8. **Approval workflow** — Require explicit “approve” before post for all companies, or optional per-company setting (default: draft→post for bookkeepers)?
9. **Money storage** — Prefer `NUMERIC(19,4)` with currency-scale rounding to minor units on post, or integer minor units? *Recommendation: NUMERIC + currency decimal places table.*
10. **Inventory / stock** — Products as non-stock services first, inventory later? *Recommendation: non-stock first.*

### C. Platform & ops
11. **Staging Supabase project** — Create separate staging before any real client money data?
12. **AI provider** — Which LLM (and where keys live — Vercel server env only)? Read-only suggestions until Phase G?
13. **Email for invites/statements** — Resend / Supabase / other?
14. **Confirm stack preservation** — Keep TanStack Start + Vite + Supabase + Vercel (recommended; no change unless you override).

### D. Scope file
15. **Provide Full Product Scope MD** for a formal delta against this plan, or **ratify this plan as SSR** until that file arrives.

---

## Design principles (non-negotiable)

1. **One posting engine** — all money modules call shared posting services; no module-private ledgers.
2. **Posted history is immutable** — reverse, don’t edit/delete posted journals.
3. **RLS + membership** — no cross-org access without authorized membership (or firm_client_link → membership).
4. **`is_demo` never forks posting/validation/reporting** — demo = same engine + sample data + reset/billing/UI flags only (`AGENTS.md`).
5. **AI never posts unsupervised** — AI drafts → deterministic validation → permissioned human/system post.
6. **Navigation shows the full product** — unimplemented items visible as coming-soon / phase-gated, not omitted.
7. **Preserve stack** unless a documented technical exception is approved.
