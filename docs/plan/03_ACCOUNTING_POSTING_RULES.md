# LinkBooks — Accounting Posting Rules

**Authority:** There is exactly one posting path — `PostingEngine`.  
Sales, Purchases, Banking, Tax, Fixed Assets, and Manual Journals **must not** write posted ledger rows another way.

---

## 1. Journal lifecycle

| Status | Meaning | Mutable? |
|--------|---------|----------|
| `draft` | Work in progress | Yes (lines/header) |
| `approved` | Ready to post (optional gate) | Header metadata limited; lines locked or draft-equivalent by policy |
| `posted` | On the books | **Immutable** (no line edits, no delete) |
| `voided` | Abandoned before post | Terminal; never posted |

**Reversal:** Create a **new** journal with opposite lines, `status=posted`, `reverses_journal_id` → original; set `reversed_by_journal_id` on original. Original remains `posted`.

There is **no** “unpost” that deletes history.

---

## 2. Balance enforcement

For every journal transitioning to `posted`:

1. ≥ 2 lines  
2. Each line: `debit ≥ 0`, `credit ≥ 0`, and not both > 0  
3. `SUM(debit) = SUM(credit)` in **document currency**, then converted consistently to base  
4. All lines same `journal_id` / `company_id`  
5. Every `account_id` is postable and not archived  
6. Failure → entire transaction rolls back; source document stays unposted  

Prefer a single DB transaction: insert/validate journal + lines → set posted → update source `posted_journal_id` → audit row.

---

## 3. Source documents & idempotency

| Field | Rule |
|-------|------|
| `source_type` | Enum: `manual`, `sales_invoice`, `sales_credit_note`, `customer_payment`, `purchase_bill`, `purchase_credit_note`, `supplier_payment`, `expense`, `bank_transaction`, `bank_transfer`, `payroll` (later), `fixed_asset` (later), `tax_adjustment`, `opening_balance`, `ai_draft` (only until converted to manual/other) |
| `source_id` | UUID of source row when applicable |
| `idempotency_key` | Required for automated posts; unique per `(company_id, idempotency_key)` |

**Idempotency examples:**  
`sales_invoice:{invoice_id}:authorise`  
`bank_txn:{id}:categorise:{rule_version}`

Retrying the same key returns the existing journal — never double-posts.

---

## 4. Period locks & posting date

1. `journal_date` must fall within an `accounting_periods` row for the company.  
2. That period must be `open` (not `locked` / `closed`).  
3. Unlock requires elevated permission (`periods.unlock`) and writes audit.  
4. Future-dated posts: allowed if period open (company setting may restrict).  
5. Backdated into locked period: **rejected**.

---

## 5. Currency, precision, rounding

1. Company has one **base currency** (`companies.base_currency`).  
2. Journal may be in base or foreign currency; store `currency_code` + `fx_rate` (to base).  
3. Line amounts stored in journal currency; reporting converts via rate on journal (MVP: no per-line FX).  
4. Rounding: round each line tax/amount to currency decimal places; **balancing difference** (≤ 1 minor unit) posted to a system **Rounding** account via engine — never leave unbalanced.  
5. `is_demo` does **not** change rounding or FX rules.

---

## 6. Standard posting patterns (adapters)

### Sales invoice (authorise/issue)
- DR Accounts Receivable (gross or net+tax per tax settings)  
- CR Revenue (per line accounts / product defaults)  
- CR Tax Payable (if applicable)  

### Sales credit note
- Inverse of invoice (DR revenue/tax, CR AR)

### Customer payment
- DR Bank (or Clearing)  
- CR Accounts Receivable  
- Allocations update invoice balances; do not bypass AR control account without clear design

### Purchase bill
- DR Expense/Asset (+ tax recoverable)  
- CR Accounts Payable  

### Supplier payment
- DR AP · CR Bank  

### Expense (paid immediately)
- DR Expense (+ tax) · CR Bank (or personal liability — policy)

### Bank transfer
- DR destination bank · CR source bank (two bank accounts)

### Manual journal
- User-specified lines; engine still enforces balance + period + permissions

### Bank categorisation (spend)
- DR Expense/Asset · CR Bank (clears uncategorised bank txn)

All adapters produce a **balanced journal proposal**; only `PostingEngine.post()` commits.

---

## 7. Document vs ledger consistency

| Event | Ledger | Document |
|-------|--------|----------|
| Save draft invoice | None | `draft` |
| Authorise invoice | Post journal (or fail all) | `authorised` + `posted_journal_id` |
| Void authorised unpaid invoice | Post reversing journal if posted | `void` |
| Edit authorised invoice | **Forbidden**; credit note or reverse+reissue | — |

---

## 8. Audit history

Every post / void / reverse / period lock / permission grant writes `audit_events`:

`company_id`, `actor_user_id`, `action`, `entity_type`, `entity_id`, `before`, `after`, `at`, `request_id`

Audit is append-only (RLS: insert via service; select for members with `audit.view`).

---

## 9. Reporting consistency

| Report | Source |
|--------|--------|
| Trial Balance | Sum posted lines by account as-of date |
| P&L | Income/expense accounts in date range |
| Balance Sheet | Assets/liabilities/equity as-of date (incl. P&L close logic) |
| GL / Account txn | Posted lines for account |
| Aged AR/AP | Subledger from documents **reconciled** to control accounts; investigation tools if drift |

Control accounts (AR/AP/Bank) must match subledgers within defined tolerance (normally zero). Drift = defect.

---

## 10. AI interaction with posting

1. AI may propose categorisation, draft lines, or explain balances.  
2. Proposals stored as `ai_suggestions` (not journals).  
3. Applying a suggestion runs TaxService + balance validation + permission check, then PostingEngine.  
4. AI has **no** service-role access and **cannot** set `linkbooks.trusted` or bypass RLS.  
5. High-risk actions (period unlock, reverse, tax filing) require human confirmation always.

---

## 11. Demo Company

Same PostingEngine, constraints, and reports. Seed scripts insert sample contacts, accounts, documents, and **posted** journals through the engine (or a trusted seed path that still creates balanced posted journals). Reset truncates demo company data only.
