# Route inventory (72 authenticated + public route files)

Generated from `src/routes/**/*.tsx` on 2026-10-23.

## Public
- `/auth`, `/forgot-password`, `/reset-password`

## Authenticated root
- `/`, `/onboarding`, `/profile`, `/help`
- `/accounting`, `/accountant`, `/firm`, `/ai-assistant`, `/tax`, `/settings`
- `/products-services`

## Banking (`/banking`)
- `/banking`, `/banking/import`, `/banking/rules`, `/banking/reconcile`
- `/banking/transfers`, `/banking/feeds`, `/banking/cash-coding`, `/banking/transactions`

## Sales (`/sales`)
- `/sales`, `/sales/invoices`, `/sales/invoices/new`, `/sales/invoices/$invoiceId`, `/sales/invoices/$invoiceId/edit`
- `/sales/quotes`, `/sales/quotes/new`, `/sales/quotes/$quoteId`
- `/sales/credit-notes`, `/sales/credit-notes/new`, `/sales/credit-notes/$creditNoteId`
- `/sales/receipts`, `/sales/receipts/new`
- `/sales/recurring`, `/sales/statements`, `/sales/customers`, `/sales/settings`

## Purchases (`/purchases`)
- `/purchases`, `/purchases/bills`, `/purchases/bills/new`, `/purchases/bills/$billId`, `/purchases/bills/$billId/edit`
- `/purchases/orders`, `/purchases/orders/new`
- `/purchases/expenses`, `/purchases/expenses/new`, `/purchases/expenses/$expenseId`
- `/purchases/payments`, `/purchases/payments/new`, `/purchases/payments/$paymentId`
- `/purchases/credit-notes`, `/purchases/credit-notes/new`, `/purchases/credit-notes/$creditNoteId`
- `/purchases/recurring`, `/purchases/suppliers`, `/purchases/statements`
- `/purchases/employee-expenses`, `/purchases/settings`

## Contacts
- `/contacts`, `/contacts/$contactId`, `/contacts/duplicates`, `/contacts/import`, `/contacts/settings`

## Reports
- `/reports`, `/reports/$reportId`

**Deep-link policy:** Preserve all existing paths; flyovers may overlay without removing routes.
