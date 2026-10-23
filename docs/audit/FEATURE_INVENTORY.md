# Feature inventory (honest status)

Legend: **ready** = operational · **partial** = works with gaps · **blocked** = Create menu blocked / Unavailable · **missing** = not started

## Create New registry (29 actions)

| ID | Status |
|----|--------|
| invoice, quote, receive_payment, customer_credit | ready |
| bill, purchase_order, pay_bill, expense, supplier_credit, reimbursement | ready |
| bank_transfer, customer, supplier, product | ready |
| recurring_invoice, customer_statement, recurring_bill, account | partial |
| sales_receipt, customer_refund, supplier_refund, receive_money, bank_deposit, card_payment, manual_journal*, recurring_journal, bank_adjustment, project, document_upload | blocked |

\*Manual journals remain available on Accounting page; Create flyover blocked until verified.

## Modules

| Module | Status | Notes |
|--------|--------|-------|
| Dashboard | partial | ledger-backed; volume UI noise reduced after demo repair |
| Banking | partial | CSV/rules/reconcile strong; feeds Unavailable |
| Sales AR | partial | core invoice/quote/credit/receipt ready; refunds blocked |
| Purchases AP | strong/partial | New Bill + Make Payment + bills workspace; PO non-posting |
| Contacts | partial | centre + duplicates; portals missing |
| Products | partial | non-inventory; inventory Unavailable |
| Accounting / CoA | strong | enterprise CoA + journals + period locks + two-tier lock dates |
| Reports | partial | P&L/BS/TB/GL/aged/tax ready; budgets/custom depends |
| Tax | partial | multi-country packs |
| Settings Centre | partial | 24-category IA; Feature Manager; many Unavailable |
| Accountant / Firm | partial | shells; practice depth missing |
| AI / Voice | blocked | provider not configured |
| Automation / Recurring | partial | v2 recurring engine present |
| Fixed assets / Portals / Subscription | missing | Settings Unavailable |

## Recent M1 repair
Demo volume “paid/authorised without journal” demoted; canonical INV/BILL linked to `posted_journal_id`. AR open now equals AR GL (480000) on both demo companies.
