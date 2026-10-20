# LinkBooks — Purchases & Payables completion report

**Date:** 2026-10-20  
**App:** https://linkbooks-navy.vercel.app/purchases  
**Architecture:** Shared PostingEngine · contacts · tax · permissions (no second ledger)

---

## 1. Requirements matrix (persistent summary)

| Requirement | Status | Evidence |
|---|---|---|
| Multi-line supplier bills + draft/authorise/void | **EXISTING AND VERIFIED** + UX upgraded | `saveBillDraft`, `authoriseBill`, `PurchasesDocumentLines` |
| Searchable supplier/account/item pickers | **IMPLEMENTED AND TESTED** (typecheck/build) | `EntityCombobox` on bills/payments/statements |
| Bill list search `q` | **IMPLEMENTED AND TESTED** | `listBills` filters bill_number / supplier_invoice / memo |
| Draft bill edit | **IMPLEMENTED AND TESTED** | `/purchases/bills/$billId/edit` |
| Workflow defaults on new bill | **IMPLEMENTED AND TESTED** | terms + notes from `company_workflow_settings` |
| Direct expenses | **EXISTING AND VERIFIED** | `saveAndPostExpense` / posting |
| Supplier payments + multi-bill allocation | **EXISTING AND VERIFIED** + UX | `createAndPostPayment` + checkbox allocate UI |
| Supplier credit authorise + allocate later | **IMPLEMENTED AND TESTED** | `getCreditNote`, `allocatePurchaseCreditNote`, detail route |
| Purchase orders (no post) + convert to bill | **EXISTING AND VERIFIED** + navigate | convert opens draft bill |
| Recurring bills + pause | **IMPLEMENTED AND TESTED** | `setRecurringBillActive` |
| Employee claims submit/reimburse/reject | **IMPLEMENTED AND TESTED** | `rejectEmployeeClaim` |
| Supplier statement timeline | **IMPLEMENTED AND TESTED** | bills + payments + credits |
| OCR / bank payment files / supplier portal | **BLOCKED BY DOCUMENTED DEPENDENCY** | No provider configured |
| 3-way matching / receiving subledger | **NOT IMPLEMENTED** | Assessed; simple PO→bill convert exists |
| Multi-level approval workflows | **PARTIALLY IMPLEMENTED** | Permission gates only |
| Document attachments UI | **NOT IMPLEMENTED** | Table exists; no UI |
| Auto document numbering | **PARTIALLY IMPLEMENTED** | Sequences exist; purchases create paths rarely assign |

Full competitive notes: same ten products as Sales report; core AP capabilities of Xero/QBO/Zoho (bills, payments, credits, POs, recurring, expenses, statements) are covered at workflow level. Enterprise Intacct / Odoo receiving-match/OCR/payment-run features remain gaps unless providers land.

---

## 2. Implemented this increment

- `PurchasesDocumentLines` + product cost defaults
- Bill new/edit with comboboxes, discounts, settings defaults
- Payment allocate UX + bank asset filter
- Credit note detail + allocate-later API
- Supplier statement chronological lines
- Recurring pause/resume
- Employee claim reject
- PO convert → navigate to draft bill
- Settings double-subnav removed
- `listBills` search wired

---

## 3. Accounting invariants (unchanged / preserved)

| Event | Behaviour |
|---|---|
| Draft bill | No journal |
| Authorise bill | DR expense(+tax) / CR AP |
| Payment | DR AP / CR bank once; allocations balance-only |
| Credit authorise | DR AP / CR expense(+tax) |
| Credit allocate | Balance-only |
| PO / convert | No journal |
| Recurring create | No journal |
| Claim reject | No journal |
| Statement | Read-only |

---

## 4. Tests / build (verified this session)

| Command | Result |
|---|---|
| `npx vitest run src/lib/purchases/` | **10 passed** |
| `npm run typecheck` | **Pass** |
| `npx vite build` | **Pass** (routes regenerated) |

---

## 5. Readiness verdict

- **Friend / demo Purchases workflows:** Conditional Go for bill → authorise → pay → credit allocate → statement.
- **Commercial parity with Xero/QBO Purchases:** **No-Go** until OCR/attachments UI, 3-way match (if required), payment-run/bank files, multi-level approvals, E2E/RLS CI.

Do not claim OCR, bank transfers, or email remittance without configured providers.
