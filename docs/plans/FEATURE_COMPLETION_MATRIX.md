# Feature completion matrix (living)

| Feature | Status | Evidence / files | Tests |
|---------|--------|------------------|-------|
| Posting engine | ready | `posting-engine.ts`, `post_journal` | money/demo tests |
| Period + two-tier locks | ready | migration + trigger | SQL |
| Settings Centre shell | partial | `/settings`, Feature Manager | settings unit |
| New Bill workspace | ready | `bills.new.tsx` | bill tests |
| Make Payment | ready | BillMakePaymentPanel | bill-payment.test |
| Create New menu | partial (project ready; document upload still blocked) | `create-new/registry.ts` | menu.test |
| Enterprise CoA | ready | ChartAccountsPanel | account-kinds tests |
| Demo AR/GL reconcile | ready | seed link + SQL repair | DEMO_COMPANY_INTEGRITY |
| Sales refunds | ready (Create menu, atomic RPC) | `20261025300100`, `money-documents.functions.ts` | SQL harness |
| Bank feeds | unavailable | Integrations tab | — |
| Portals / Fixed assets | unavailable | Settings | — |
| Firm practice depth | partial | `/firm` | — |
| Universal flyovers all docs | partial | create-new panels | M2 |
| Atomic money documents / bad-debt write-off | ready | `post_money_document`, `write_off_bad_debt` | SQL harness |
| AR lockdown (paid/credited/lines) | ready | `20261025300000` | SQL harness |
| Supplier payments with realised FX, batch, reversal | ready | `20261025300200`, `payments.batch.tsx` | `batch-payment.test`, SQL harness |
| Supplier credit note multi-line / from bill | ready | `credit-notes.new.tsx`, `credit-lines.ts` | `credit-lines.test` |
| AP control account by role | ready | `purchases/accounts.ts` | `accounts.test` |
| Recurring journals processor + page | ready (cron wiring is deployment work) | `20261025300300`, `/recurring-journals` | `due.test`, SQL harness |
| Recurring invoices/bills run-due | partial (manual only) | `RunDueButton`, `run-due.functions.ts` | `due.test` |
| FX bank transfers | ready | `create_bank_transfer_fx`, `transfers.tsx` | SQL harness |
| Bank data integrity check | ready | `bank_integrity_check`, `BankIntegrityBanner` | SQL harness |
| Bank account identifiers (masked) | ready | `bank_account_details`, `account-details.ts` | `account-details.test` |
| Projects and profitability | ready | `20261025300500`, `/projects` | `projects.test`, SQL harness |

Update on every milestone.
