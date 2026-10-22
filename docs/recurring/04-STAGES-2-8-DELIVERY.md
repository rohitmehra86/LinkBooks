# Recurring Transactions V2 — Stages 2–8 delivery summary

| Stage | Delivered | Partial / Unavailable |
|-------|-----------|---------------------|
| **2** Bills E2E | Workspace + deep-link overlay (`?id=`), tabs, history from occurrences, skip next, duplicate, server pagination | Full New Bill line editor parity in overlay (use New Bill → Make recurring) |
| **3** Sales invoices | Idempotent `generateRecurringInvoice` + v2 dual-write on save | Sales overlay UI (still `/sales/recurring` list) |
| **4** CN / expenses / receipts | Enum values in DB | **Unavailable** — no recurring generators |
| **5** Journals / transfers | Enum values | **Unavailable** — manual journal recurring not implemented |
| **6** Automation | `recurring.auto_authorise` permission; exception centre tab; auto-authorise checks | Reminder/on-demand modes in API only; no email |
| **7** Forecast | 90-day forecast tab (estimates) | Firm templates, bulk edit, CSV export — not implemented |
| **8** Hardening | Build + recurring tests; docs | Full axe audit, load tests — ongoing |

## User-visible changes (production)

- **Purchases → Recurring** → “Recurring transactions” hub with Schedules / Exceptions / Forecast
- Row click opens **90vw overlay** (`?id=<recurring_bill_uuid>`) — refresh-safe URL
- **Skip next**, **Duplicate**, **Generate now**, occurrence **History**

## Migrations

- `20261022173000_recurring_transactions_v2_foundation.sql`
- `20261022180000_recurring_v2_stages_2_8.sql`

EOF