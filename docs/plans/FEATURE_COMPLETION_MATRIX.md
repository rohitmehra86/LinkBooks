# Feature completion matrix (living)

| Feature | Status | Evidence / files | Tests |
|---------|--------|------------------|-------|
| Posting engine | ready | `posting-engine.ts`, `post_journal` | money/demo tests |
| Period + two-tier locks | ready | migration + trigger | SQL |
| Settings Centre shell | partial | `/settings`, Feature Manager | settings unit |
| New Bill workspace | ready | `bills.new.tsx` | bill tests |
| Make Payment | ready | BillMakePaymentPanel | bill-payment.test |
| Create New menu | partial | `create-new/registry.ts` | menu.test |
| Enterprise CoA | ready | ChartAccountsPanel | account-kinds tests |
| Demo AR/GL reconcile | ready | seed link + SQL repair | DEMO_COMPANY_INTEGRITY |
| Sales refunds | blocked | registry | — |
| Bank feeds | unavailable | Integrations tab | — |
| Portals | unavailable | Settings | — |
| Fixed assets (register, depreciation, disposal) | ready (pending migrations) | `/fixed-assets`, `20261025400200`/`400300`, `fixed-assets.functions.ts` | `depreciation.test.ts`; SQL on scratch Postgres; Settings still lists it Unavailable |
| Budgets (editor, CSV, vs actual) | ready (pending migrations) | `/budgets`, `20261025400100`, `budgets.functions.ts` | `budgets.test.ts` |
| Report: Budget vs Actual, Fixed Asset Register, Depreciation Schedule | ready (pending migrations) | `PlanningViews.tsx`, catalog | budget + depreciation tests |
| Reports: Executive Summary, Cash Summary, GL Summary, Sales by Contact/Item, Purchases by Supplier, Bank Rec Summary | ready (pending migration `20261025400000`) | `AnalysisViews.tsx`, `analysis.functions.ts` | `analysis.test.ts`; SQL on scratch Postgres |
| Cash flow (indirect) | ready | `indirect-cash-flow.ts` | `analysis.test.ts` |
| Saved report views | ready | `SavedViews.tsx` | — |
| List search + CSV (payments, expenses, credit notes, POs) | partial | `ListTools.tsx` | `list-tools.test.ts` |
| Budget tracking categories, dashboard budget summary | not built | — | — |
| Firm practice depth | partial | `/firm` | — |
| Universal flyovers all docs | partial | create-new panels | M2 |

Update on every milestone.
