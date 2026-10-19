# LinkBooks — Migration & Test Strategy

## 1. Migration strategy

### Principles
1. **All schema changes** live in `supabase/migrations/` and are reviewed in PRs.  
2. Prefer **additive** migrations; avoid destructive changes without dual-write/backfill plan.  
3. Never edit already-applied migration files on shared environments — add a new migration.  
4. Regenerate `src/integrations/supabase/types.ts` after schema changes.  
5. Apply to **staging before production**.

### Current baseline (already applied in designed environments)
- `profiles`  
- Phase 2: `companies`, `company_members`, `company_invitations`, `company_tax_settings`, `role_permissions`, helpers, `create_company`, `create_demo_company`

### Proposed migration sequence (logical packages)

| Package | Contents |
|---------|----------|
| M1 Permissions expand | Additional `role_permissions` rows (no table rewrite) |
| M2 CoA & periods | `accounts`, `accounting_periods` + RLS |
| M3 Ledger | `journals`, `journal_lines`, balance/immutability triggers, idempotency unique |
| M4 Audit | `audit_events` |
| M5 Tax masters | `tax_rates`, `tax_codes` (+ FK from settings) |
| M6 Numbering | `document_sequences` |
| M7 Contacts & products | `contacts`, `products` |
| M8 Sales docs | quotes, invoices, credit notes, payments, allocations |
| M9 Purchase docs | bills, expenses, supplier credits/payments |
| M10 Banking | bank_accounts, bank_transactions, reconciliations |
| M11 Firm | `firms`, `firm_members`, `firm_client_links` |
| M12 Later | recurring_*, purchase_orders, bank_rules, fixed_assets, ai_suggestions, notifications |
| M13 Storage | buckets + storage RLS policies |

### Data migration / existing users
- Users with profile but no company → onboarding (P2); no ledger data to migrate.  
- Hard-coded UI demo figures → deleted when switcher wired; real demo data only via `is_demo` seed.  
- If any preview DB has partial experiments, reset staging rather than complex salvage.

### Rollback
- Forward-fix preferred.  
- For failed prod migrate: restore from backup / PITR to pre-migrate point; hotfix migration.  
- Document restore drill annually (or before first paid customer).

### Deployment coupling
```
merge PR → migrate staging → test → migrate prod → deploy Vercel prod
```
App code that requires new tables must not deploy to prod before migration.

---

## 2. Test strategy

### Layers

| Layer | Tools (target) | What |
|-------|----------------|------|
| Static | `tsc --noEmit`, ESLint | Types & obvious bugs |
| Unit | Vitest (add) | Tax math, rounding, journal balance validator, aging buckets |
| Database | pgTAP or SQL scripts / Supabase test harness | RLS isolation, constraints, triggers |
| Integration | Vitest + service role/user clients | PostingEngine idempotency; document→journal |
| E2E | Playwright (add) | Auth, onboarding, switch company, invoice post, TB |
| Ops | Manual checklist | Backup restore, Auth redirects, env separation |

### Critical test cases (must pass before money in prod)

**Tenancy / security**
1. User B cannot SELECT company A journals by guessing UUID.  
2. Service role not present in browser bundle.  
3. `setActiveCompany` rejects non-membership.  
4. Last owner cannot be removed.  
5. Firm user without link cannot read client.  

**Posting**
6. Unbalanced journal rejected.  
7. Post into locked period rejected.  
8. Double submit same idempotency key → one journal.  
9. Reverse creates balancing opposite; original immutable.  
10. Invoice authorise creates AR/revenue/tax lines summing to zero net.  

**Reporting**
11. Fixture seed → TB / P&L / BS match golden files.  
12. Aged AR total = AR control account.  

**Demo**
13. Demo reset clears only demo company.  
14. Same posting code path for demo and real (`is_demo` not branched in engine).  

**AI**
15. Suggestion apply with missing permission fails.  
16. Unbalanced AI draft cannot post.

### Definition of “Implemented and tested”
A feature may update the audit matrix to **Implemented and tested** only when:
- Code path exists end-to-end, and  
- Automated tests covering AC above are green in CI.

### CI gate (target)
On every PR: install → `tsc` → lint (errors) → unit → (staging) integration → build.  
Nightly: E2E against staging + RLS suite.

---

## 3. Environments

| | Local | Staging | Production |
|--|-------|---------|------------|
| Supabase | Dev project / local | Dedicated staging | Prod |
| Vercel | `npm run dev` | Preview | Production |
| Data | Disposable | Synthetic + demo | Real customers |
| AI keys | Optional | Staging keys | Prod keys |

---

## 4. Observability
- Client error reporting (existing Lovable hooks) + add server error logging.  
- Alert on PostingEngine failure rate and migration job failures.  
- Never log secrets, full card data, or service-role keys.
