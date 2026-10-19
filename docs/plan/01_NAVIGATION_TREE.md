# LinkBooks — Complete Product Navigation Tree

**Legend**

| Tag | Meaning |
|-----|---------|
| **CORE** | Required for production accounting platform (SMB + freelance) |
| **LATER** | Full-product roadmap; navigate to shell early, implement after CORE |
| **EXT** | Depends on third-party integrations / market packs |
| **FIRM** | Accounting-firm / practice features |

Routes are **target** paths. Existing shells today: `/`, `/banking`, `/sales`, `/purchases`, `/contacts`, `/products-services`, `/accounting`, `/reports`, `/ai-assistant`, `/settings`, `/help`, `/profile`.

Unimplemented children should still appear in nav (disabled, badge “Soon”, or empty state with phase note) so the product vision is never hidden.

---

## Top-level chrome

```
[Org switcher]  Company A | Company B | Demo Company | + Create organisation | Manage firm (FIRM)
[New ▾]         Invoice | Bill | Expense | Payment | Manual journal | Transfer | Quote
[Search]        Global search (CORE: contacts/docs; LATER: full-text)
[Notifications] Mentions, approvals, bank feed errors (LATER)
[User]          Profile | Help | Sign out
```

---

## 1. Dashboard — `/`  **CORE**

```
Dashboard
├── Business overview (cash, AR, AP, profit MTD/YTD)
├── Cash position by bank account
├── Overdue invoices / bills
├── Recent activity (audit feed)
├── Tax reminders (from tax settings)
└── Shortcuts (New invoice, Reconcile, Run P&L)
```

---

## 2. Sales — `/sales`  **CORE** (recurring/quotes depth can stage)

```
Sales
├── Overview
├── Quotes / Estimates .................... CORE (create/send); accept→invoice LATER polish
├── Customers ............................ → Contacts filtered (or /contacts?type=customer)
├── Invoices ............................. CORE
│   ├── Draft / Awaiting payment / Paid / Void
│   ├── Create / Edit draft / Send
│   └── Post to ledger on issue (or on approve — policy)
├── Credit notes ......................... CORE
├── Customer payments .................... CORE
├── Customer statements .................. CORE
└── Recurring invoices ................... LATER
```

---

## 3. Purchases — `/purchases`  **CORE** (+ expense workflows LATER)

```
Purchases
├── Overview
├── Bills ................................ CORE
├── Expenses (receipt capture) ........... CORE (manual); OCR EXT/LATER
├── Suppliers ............................ → Contacts suppliers
├── Supplier payments .................... CORE
├── Supplier credit notes ................ CORE
├── Purchase orders ...................... LATER
├── Recurring bills ...................... LATER
└── Employee expenses / claims ........... LATER
    ├── Submit / Approve / Reimburse
    └── Post on approval
```

---

## 4. Banking — `/banking`  **CORE** (feeds EXT)

```
Banking
├── Bank accounts ........................ CORE (manual accounts)
├── Imported statements (CSV/OFX) ........ CORE
├── Bank feeds ........................... EXT (provider TBD)
├── Transactions (uncategorised / matched)
├── Categorisation & matching ............ CORE
├── Transfers between accounts ........... CORE
├── Reconciliation ....................... CORE
└── Bank rules ........................... LATER (then CORE polish)
```

---

## 5. Contacts — `/contacts`  **CORE**

```
Contacts
├── All / Customers / Suppliers / Employees (employees LATER)
├── Contact detail
│   ├── Profile & addresses
│   ├── Transactions history
│   ├── Statements
│   └── Notes / attachments (storage)
└── Merge duplicates ..................... LATER
```

---

## 6. Accounting — `/accounting`  **CORE** (assets LATER)

```
Accounting
├── Chart of accounts .................... CORE
│   ├── Account types / codes / tax defaults
│   ├── Archive / lock system accounts
│   └── Import CoA template (by country)
├── Manual journals ...................... CORE
│   ├── Draft / Approve / Post
│   └── Reverse posted
├── Recurring journals ................... LATER
├── Fixed assets ......................... LATER (or CORE if approved)
│   ├── Register, depreciation runs
│   └── Disposal
├── Period-end tools ..................... CORE
│   ├── Periods list / lock / unlock (owner+)
│   ├── Year-end close checklist
│   └── Accruals / prepayments helpers (LATER)
└── Audit history ........................ CORE
    └── Filter by user, entity, date, source
```

---

## 7. Reports — `/reports`  **CORE** (cash flow / advanced tax LATER)

```
Reports
├── Trial Balance ........................ CORE
├── Profit and Loss ...................... CORE
├── Balance Sheet ........................ CORE
├── General Ledger ....................... CORE
├── Account transactions ................. CORE
├── Aged receivables ..................... CORE
├── Aged payables ........................ CORE
├── Cash flow statement .................. LATER (indirect/direct method)
├── Tax reports .......................... CORE (VAT/GST summary); filing EXT
│   ├── Tax liability summary
│   └── Box-mapped return draft (market pack)
└── Export PDF / CSV ..................... CORE
```

---

## 8. Products & Services — `/products-services`  **CORE** (inventory LATER)

```
Products & Services
├── Services / non-stock items ........... CORE
├── Sales/purchase account defaults
├── Tax code defaults
├── Price lists .......................... LATER
└── Inventory / stock on hand ............ LATER
```

---

## 9. Tax Configuration — `/settings/tax` (or `/tax`)  **CORE**

```
Tax
├── Regime (VAT / GST / sales tax / none)
├── Registration number / scheme
├── Tax rates & codes .................... CORE
├── Prices include tax default
├── Filing frequency & basis (invoice/cash) CORE foundation
└── Filing integrations / MTD ............ EXT
```

---

## 10. Accountant Tools — `/accountant`  **CORE** (practice pack LATER)

```
Accountant Tools
├── Client readiness checklist ........... CORE (per company)
├── Period lock status
├── Unreconciled / uncategorised counts
├── Journal review queue
├── Working papers export ................ LATER
└── Client queries / tasks ............... LATER
```

---

## 11. Firm & Client Management — `/firm`  **FIRM**

```
Firm
├── Firm profile & members
├── Client companies list
├── Link / unlink client access
├── Access levels (view / bookkeep / full)
├── Switch into client books (via membership)
└── Firm billing (subscriptions) ......... LATER / EXT
```

*Nav: show for users who belong to a `firms` membership; hide otherwise (not remove from product roadmap).*

---

## 12. Organisation Settings — `/settings`  **CORE**

```
Settings
├── Organisation profile
├── Financial year & periods defaults
├── Currencies (base + enabled)
├── Document numbering sequences
├── Users & roles / invitations
├── Permissions overview (read-only matrix)
├── Billing (org subscription) ........... LATER / EXT
├── Integrations ......................... EXT
└── Demo / data reset (is_demo only) ..... CORE for demo companies
```

---

## 13. AI Accounting Assistant — `/ai-assistant`  **LATER** (shell CORE)

```
AI Assistant
├── Explain a report / account balance ... LATER
├── Suggest categorisation (bank) ........ LATER
├── Draft journal / invoice lines ........ LATER
├── Anomaly hints ........................ LATER
└── Guardrails banner (never auto-posts)
```

---

## 14. Demo Company  **CORE**

```
Not a separate module — entry via org switcher:
├── Open / create Demo Company (is_demo)
├── Same nav, engine, RLS, UI
├── Sample data seed pack
└── Reset demo data (destructive; demo-only)
```

---

## 15. Help / Profile (existing)

```
Help ........ guides, keyboard shortcuts
Profile ..... name, email, password, preference
```

---

## Navigation implementation rule

| State | UI behaviour |
|-------|----------------|
| Implemented | Full route + data |
| In progress | Route + empty/WIP banner citing phase |
| Not started | Visible in sidebar under parent; click → “Planned for Phase X” page or disabled child |

Primary sidebar should expand to include **Tax**, **Accountant**, and **Firm** when those routes exist — do not bury Firm forever under Settings.
