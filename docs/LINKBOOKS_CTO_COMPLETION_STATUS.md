# LinkBooks — CTO completion status (2026-10-19 evening)

## Honest scope note

The full master command cannot be finished in one execution window. This increment delivers the highest-priority customer-visible gaps: **Products catalogue**, **global Search + New**, **module settings persistence**, **org logo storage bucket**, and **large Demo volume data**, while preserving the single posting engine.

## Implemented in this increment

| Area | Status | Evidence |
|------|--------|----------|
| Products & Services | **Implemented** (non-inventory catalogue) | Migration `20261019240000_*`, `products.functions.ts`, `/products-services` UI |
| Inventory / stock valuation | **Not implemented** (by design honesty) | Explicit copy on Products page |
| Global search | **Implemented** | `global-search.functions.ts`, `GlobalSearch` in AppShell |
| + New menu | **Implemented** | AppShell dropdown → real routes |
| Sales / Purchases settings | **Implemented** (workflow defaults) | `company_workflow_settings`, `/sales/settings`, `/purchases/settings` |
| Org logo Storage bucket | **Schema ready** | `org-logos` bucket + RLS; UI upload still URL-field in Settings Documents |
| Document themes / PDF branding engine | **Not in this increment** | Remains backlog |
| Classes / locations / tracking | **Not in this increment** | Remains backlog |
| Email invitations | **Not in this increment** | Remains backlog |
| Huge Demo data | **Implemented** | `seed-demo-volume.ts`: ~45 contacts, ~120 invoices, ~80 bills, ~200 bank txns, 8 products + canonical journals |
| Canonical ledger goldens | **Unchanged** | `DEMO_JOURNAL_SPECS` / `DEMO_EXPECTED` still drive TB/P&L/BS tests |

## Remaining (exact continuation)

1. Wire product picker into invoice/bill line forms (`product_id` column exists).
2. Logo upload UI using `org-logos` signed URLs (bucket already created).
3. Document theme/PDF template engine.
4. Tracking categories + journal line dimensions + report filters.
5. CoA CSV import/export + create-account UI.
6. Live invitation email + firm depth.
7. Playwright E2E + live RLS isolation evidence.
8. CI + monitoring + backup drill for commercial Go.

## Release verdict

- **Friend / Demo exploration:** Conditional Go after Settings → Demo → Reset & reseed.
- **Commercial production:** **No-Go** (unchanged blockers: CI, live RLS E2E, backup drill, invitations, themes, tracking).
