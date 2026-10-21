# New Bill & Purchase Accounting Workspace (premium)

## Access
`/purchases/bills/new` — Purchases → Bills → New bill

## Layout
- **Header:** title, status, view mode (Basic / Professional / Custom), More actions, Save draft, Save & authorise split-button, Cancel
- **Main workspace:** expands when sidebar collapses/closes
- **Right Supplier Intelligence Sidebar** (default open on desktop): Summary, Recent Bills, Credits & Payments, Document Preview, Activity

### Sidebar controls
Collapse · Close · Reopen (“Show supplier summary”) · Resize  
Preferences persisted per user + organisation in `user_ui_preferences` (`bill_workspace` key).

## Integrated “+ Add new…”
Sticky inside eligible dropdowns (no external + icons for those fields):
- Supplier, Item/Service, Expense/Asset Account, Tax Rate, Class, Location, Customer, Project, Payment Terms

Creates call real server APIs (`upsertSupplier`, `upsertProduct`, `createManualAccount`, `saveTaxRate`/`saveTaxCode`, `upsertTrackingOption`, `upsertCustomer`, `createPaymentTerm`) then auto-select.

## Settings-driven Class / Location
Professional View shows Class/Location when those dimension kinds exist and are active. Basic view hides them. Historical data preserved.

## Blank-row cleanup
On save, completely blank lines are removed; authorise validates incomplete non-blank rows.

## Accounting
Unchanged shared posting engine. Drafts do not post. Authorise remains idempotent.

## Migration
`supabase/migrations/20261021120000_bill_workspace_prefs.sql`

## Known remaining / partial
- Split allocation UI (percentage/fixed/equal) not yet a dedicated editor — dimensions are line-level
- PO three-way matching remains on Orders convert flow
- Detailed Accounting PDF uses the same print path with accounting fields when populated; dedicated PDF binary library not added
- Edit bill route still thinner than New Bill (draft fields + lines); use New Bill patterns when extending edit
- Screenshots: capture locally after deploy (sidebar open / collapsed / closed + Add New dropdown)
