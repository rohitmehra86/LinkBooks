# Accounting treatment — Sales / Banking / Contacts

| Event | Journal | Allocations |
|-------|---------|-------------|
| Authorise invoice | DR AR 1100, CR revenue, CR Tax Payable 2100 | — |
| Customer receipt | DR bank GL, CR AR (full amount) | Allocations update invoice `amount_paid_minor` only — **no second journal** |
| Overpayment | Same receipt journal for full amount | Remainder stays `unallocated_minor` (customer credit balance on AR) |
| Credit note authorise | DR revenue, DR Tax Payable, CR AR | — |
| Credit allocation | No journal | Updates invoice `amount_credited_minor` |
| Invoice void | Reversing journal via PostingEngine | Blocked if payments/credits allocated |
| Bank categorise | One journal + reconciliation_link | Status → matched |
| Match to existing line | **No journal** — link only | Amounts must equal (split match not supported) |
| Transfer | One journal: DR dest GL, CR source GL | — |
| Deposit | Modelled as receipt or bank categorisation into income/AR | — |
| Refund to customer | Sales credit note (+ optional bank payment out via categorisation) | Not a negative receipt |

Idempotency keys: `sales_invoice:{id}:authorise`, `customer_receipt:{id}:post`, `sales_credit_note:{id}:authorise`, `bank_transfer:{id}:post`, `bank_transaction:{id}:categorise`.
