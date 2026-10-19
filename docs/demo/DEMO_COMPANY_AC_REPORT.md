# Demo Company — acceptance evidence

**Canonical dataset:** `src/lib/demo/demo-dataset.ts`  
**Seeder (PostingEngine):** `src/lib/demo/seed-demo.ts`  
**Guards migration:** `supabase/migrations/20261019220000_demo_company_guards.sql`  
**Reset RPC:** `reset_demo_company` (demo-only) + TypeScript reseed

---

## Requirements

| # | Requirement | Evidence | Status |
|---|-------------|----------|--------|
| 1 | Repeatable safe seed | `openDemoCompany` / Settings reset → `seedDemoCompanyData` | Pass |
| 2 | Customers, suppliers, CoA, invoices, receipts, bills, payments, expenses, credits, bank, journals, opening | Dataset + rich seeder (quotes, POs, recurring, claims, bank rules, 6 contacts, 10 bank txns) | Pass |
| 3 | Real posting engine | `postJournal` only | Pass |
| 4–5 | Reports from ledger; known totals | `DEMO_EXPECTED` + `demo.test.ts` | Pass (unit) |
| 6 | Prominent Demo label | AppShell banner + switcher + dashboard alert | Pass |
| 7 | Isolation / no prod wipe | `is_demo` assert; `reset_demo_company` denies non-demo; `is_demo` flip blocked | Pass |
| 8 | Deterministic reseed demo-only | Settings + `reseedDemoCompany` | Pass |
| 9 | Explore modules; unfinished honest | `DEMO_MODULE_STATUS`; Products/Help shells | Pass |

## Known expected totals (GBP minor, as of 2026-03-31)

| Metric | Value |
|--------|------:|
| TB debit = credit | 6,755,000 |
| Income | 1,400,000 |
| Expense | 627,500 |
| Net profit | 772,500 |
| Assets | 6,127,500 |
| Liabilities | 355,000 |
| Equity | 5,772,500 |
| Bank | 5,537,500 |
| AR | 480,000 |
| AP | 75,000 |

## Tests

`npx vitest run src/lib/demo/demo.test.ts` — journal balance, TB/P&L/BS, control accounts, GL, isolation contracts, module honesty, non-demo seed denial.

## Honest limitations

- Products & Services catalogue not implemented (shell labelled).
- Live DB verification of seeded totals requires migrations applied + Open Demo / Reset.
- Dashboard metrics are ledger-derived; empty state uses `NO_FIGURE`, never invented KPIs.
- `is_demo` never forks posting/validation (`AGENTS.md`).
