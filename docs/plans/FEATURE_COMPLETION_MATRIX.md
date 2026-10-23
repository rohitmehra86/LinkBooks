# Feature completion matrix (living)

| Feature | Status | Evidence / files | Tests |
|---------|--------|------------------|-------|
| Posting engine | ready | `posting-engine.ts`, `post_journal` | money/demo tests |
| Period + two-tier locks | ready | migration + trigger | SQL |
| Settings Centre shell | partial | `/settings`, Feature Manager | settings unit |
| New Bill workspace | ready | `bills.new.tsx` | bill tests |
| Make Payment | ready | BillMakePaymentPanel | bill-payment.test |
| Create New menu | partial | `create-new/registry.ts` | menu.test |
| Enterprise CoA | ready | ChartAccountsPanel | account-kinds tests |
| AC-02 Conversion / opening balances | ready (needs migrations) | Accounting > Opening balances, `post_conversion_balances` | `conversion-balances.test.ts`, scratch SQL |
| AR-10 Realised + unrealised FX | ready (needs migrations); manual rates only | Accounting > FX & reversals, triggers `fx_realise_*`, `post_fx_revaluation` | `fx-reval.test.ts`, scratch SQL |
| AC-05 Auto-reversing journals | ready; scheduler is optional and documented, not installed | `post_auto_reversing_journal`, `process_due_auto_reversals(_system)` | `fx-reval.test.ts`, scratch SQL |
| AC-08 Account merge with historic dating | ready (needs migration); same-currency accounts only | Chart of accounts > Merge, `merge_accounts_dated` | `account-merge.test.ts`, scratch SQL |
| TX-04 Tax summary cash/accrual + reverse charge | ready for bills; credit notes not covered | Reports > Tax summary, `reverse-charge.ts`, `postBillAuthorisation` | `reverse-charge.test.ts`, `tax-return-data.test.ts` |
| Ledger health check | ready (needs migration) | Settings > Accounting, `ledger_health_check` | `ledger-health.test.ts`, scratch SQL |
| Demo AR/GL reconcile | ready | seed link + SQL repair | DEMO_COMPANY_INTEGRITY |
| Sales refunds | blocked | registry | — |
| Bank feeds | unavailable | Integrations tab | — |
| Portals | unavailable | Settings | — |
| Fixed assets (register, depreciation, disposal) | ready (pending migrations) | `/fixed-assets`, `20261025400200`/`400300`, `fixed-assets.functions.ts` | `depreciation.test.ts`; SQL on scratch Postgres; Settings still lists it Unavailable |
| Budgets (editor, CSV, vs actual) | ready (pending migrations) | `/budgets`, `20261025400100`, `budgets.functions.ts` | `budgets.test.ts` |
| Report: Budget vs Actual, Fixed Asset Register, Depreciation Schedule | ready (pending migrations) | `PlanningViews.tsx`, catalog | budget + depreciation tests |
| Reports: Executive Summary, Cash Summary, GL Summary, Sales by Contact/Item, Purchases by Supplier, Bank Rec Summary | ready (pending migration `20261025400000`) | `AnalysisViews.tsx`, `analysis.functions.ts` | `analysis.test.ts`; SQL on scratch Postgres |
| Cash flow (indirect) | ready | `indirect-cash-flow.ts` | `analysis.test.ts` |
| Saved report views | ready | `SavedViews.tsx` | — |
| List search + CSV (payments, expenses, credit notes, POs) | partial | `ListTools.tsx` | `list-tools.test.ts` |
| Budget tracking categories, dashboard budget summary | not built | — | — |
| Firm practice depth | partial | `/firm` | — |
| Universal flyovers all docs | partial | create-new panels | M2 |
| Printable documents (invoice, credit note, quote, receipt, bill, PO, supplier credit, remittance) | ready (print / Save as PDF; no server PDF) | `src/components/documents/DocumentSheet.tsx`, `/documents/print/$kind/$id`, `src/lib/documents/*` | documents.test, DocumentSheet.test |
| Document branding (logo upload, accent, address, tax no., bank details, footer) | ready (needs migration 20261025200000) | `/documents/branding`, `saveBrandingSettings` | documents.test |
| Email delivery of documents | partial — sends only when `RESEND_API_KEY` + `EMAIL_FROM` set; otherwise honest "not configured" + mailto | `email-provider.server.ts`, `sendDocumentEmail`, `email_outbox` | email-provider.test, comms.test |
| Overdue reminders | partial — manual batch send + schedule settings; no automatic scheduler | `/sales/reminders`, `reminders.ts` | comms.test |
| Document attachments + Files page | ready (needs migration 20261025200100) | `company-documents` bucket, `document_attachments`, `/files`, `AttachmentsPanel` | comms.test |
| Create → Document upload | ready (was blocked) | `InboxPanel.tsx`, registry `document_upload` | menu.test |
| Online invoice link (read-only, revocable) | ready (needs migration 20261025200300); no online payment | `/share/invoice/$token`, `get_shared_invoice` RPC | documents.test |
| Customer statements (print / email) | ready | `/sales/statements`, `loadCustomerStatement` | statement tests |
| Supplier statements | missing | — | — |
| Automatic PDF attachment in email | missing (link + summary only) | — | — |

Update on every milestone.
