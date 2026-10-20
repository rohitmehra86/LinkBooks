# LinkBooks Settings & Organisation Governance — Completion Report

## Routes

| Area | Route |
|------|--------|
| Settings centre | `/settings` (Organisation, Financial, Dimensions, Documents, Currencies, Users, Automation, Integrations, Audit, Demo) |
| Period locks | `/accounting` (unchanged; linked from Financial) |
| Tax | `/tax` |
| Sales/Purchases defaults | `/sales/settings`, `/purchases/settings` |
| Contacts numbering | `/contacts/settings` |

## Implemented

- **Dimensions:** CRUD for `tracking_categories` / `tracking_options` with kinds, activate/deactivate, CSV export, document-assignment APIs, income/expense-by-dimension report (document totals).
- **Numbering:** Live preview; `allocate_document_number` wired for new sales invoices (when number blank) and purchase bills (`bill_number`).
- **FY end day:** Leap-year-aware max day (29 Feb allowed); UI clamps when month changes.
- **Journal memo:** `accounting_require_journal_memo` enforced on `postManualJournal`.
- **Invitations:** Create/list/revoke with pending/expired/accepted statuses; **email delivery truthfully unavailable**; one-time token for manual share.
- **Automation tab:** Workflow defaults persistence (terms, PO, memo, CSV date format).
- **Integrations tab:** Honest disconnected/not-configured states (email, FX feed, bank aggregator, address autocomplete).
- **Audit:** Action/entity filters + pagination params.
- **Schema:** `document_tracking_assignments`, `line_tracking_assignments`, dimension metadata, localisation columns, `revoked_at` on invitations.

## Preserved

- Existing org/financial/documents/FX/users/demo tabs and server functions.
- Base-currency lock after postings (DB trigger).
- Period lock via `post_journal` + `/accounting`.
- Demo reset restricted to `is_demo` + `demo.reset`.
- Append-only exchange rates; posted `fx_rate_to_base` unchanged.

## Migrations

- `supabase/migrations/20261020240000_settings_governance_dimensions.sql`

## Permission enforcement

- Dimension manage: `accounts.manage`
- Settings edit: `company.settings.edit`
- Members/invites: `members.manage`
- Audit: `audit.view`
- Dimension report: `reports.view`
- Document tracking assign: draft/post permissions per module

## Known limitations / external dependencies

| Item | Status |
|------|--------|
| Outbound email for invites/statements | Not configured — UI states this |
| Live FX feed | Not connected — manual rates only |
| Logo file upload / storage | URL field only |
| Line-level tracking UI on every document form | APIs + tables ready; invoice/bill assignment UI partial (settings report + `setDocumentTracking` API) |
| Full GL P&L by journal-line dimension | Document-total method documented; journal-line rollup needs posting-time capture |
| Invitation accept route | Token stored; dedicated accept page not yet shipped |
| Budget vs actual by dimension | Budgets module not present |

## Demo Company

Reset path unchanged: server checks `is_demo` + `demo.reset`, RPC + seed through PostingEngine. Canonical totals not altered by this work.
