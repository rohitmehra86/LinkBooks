# Sales / Banking / Contacts — pre-implementation audit

**Date:** 19 Oct 2026

| Module | Class | Evidence |
|--------|-------|----------|
| Sales | UI only | `sales.tsx` — inert buttons, empty tabs |
| Banking | UI only | Decorative empty states; Add bank / Import do nothing |
| Contacts | UI only | Empty tabs; search inert |
| Contacts table | Backend exists | `contacts` from purchases migration — reuse |
| Bank tables | Backend partial | `bank_accounts`, `bank_transactions`, `reconciliation_links` + `categoriseBankTransaction` |
| Sales tables | Missing | No invoices/quotes/receipts |

## Preserve / reuse

- Shared PostingEngine / minor-unit money / line-math patterns from Purchases  
- Do not rewrite Purchases or Accounting engine  
- Bank feeds: **not configured** — UI must not fake a connected feed  

## PDF / delivery

- Browser print / “Print to PDF” for invoices & statements  
- No invented email provider delivery  
