# Create New checklist

Source of truth: `src/lib/create-new/registry.ts`. All 29 commands stay in the menu. A command opens its flyover only when `availability` is `ready`.

## Enabled

These open the existing screens and save through the existing organisation services:

Invoice, quote, receive payment, customer credit note, recurring invoice, customer statement, bill, recurring bill, purchase order, pay bill, expense, supplier credit, reimbursement claim, bank transfer, customer, supplier, product, account.

Recurring bill automatic generation stays unwired. There is no outbound email provider.

## Held

These stay visible and disabled. Their source remains in the repository. They need `supabase/migrations/20261022210000_create_new_documents.sql` on the database, or a signed-in ledger check, before they can be enabled:

Sales receipt, customer refund, supplier refund, receive money, bank deposit, credit card payment, bank adjustment, manual journal flyover, recurring journal, project, document upload.

Document upload also stays disabled because no malware scanner is configured. Manual journals can still be posted from Accounting.

`20261022210000_create_new_documents` is applied on the linked database. Row level security is on for the new tables. The commands stay disabled until a signed-in save is verified. Do not run a full `supabase db push`: local file `20261022180000_settings_centre_foundation.sql` repeats work already applied under versions `20261022125237` through `20261022125601`.
