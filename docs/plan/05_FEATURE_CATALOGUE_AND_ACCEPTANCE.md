# LinkBooks — Feature Catalogue & Acceptance Criteria

**How to read each feature**

| Field | Meaning |
|-------|---------|
| Phase | P0…P8 from backlog |
| Class | CORE / LATER / EXT / FIRM |
| UI | Screens / routes |
| Backend | Server functions / services |
| Database | Tables / constraints |
| Permissions | Keys from matrix |
| Accounting | PostingEngine impact |
| Tests | Minimum proof |
| AC | Acceptance criteria |

---

## A. Platform & tenancy

### A1. Auth (sign-in / sign-up / reset)
| | |
|--|--|
| Phase / Class | P1 / CORE (mostly exists) |
| UI | `/auth`, `/forgot-password`, `/reset-password` |
| Backend | Supabase Auth |
| Database | `auth.users`, `profiles` trigger |
| Permissions | n/a (pre-company) |
| Accounting | None |
| Tests | E2E sign-up → confirm → login; reset flow on preview URL |
| AC | User can register, confirm email (when enabled), sign in, reset password; unauthenticated users cannot load app routes |

### A2. Company onboarding
| | |
|--|--|
| Phase / Class | P2 / CORE |
| UI | `/onboarding/company` — create org or open demo |
| Backend | `createCompany`, `openDemoCompany` |
| Database | `create_company` / `create_demo_company` RPCs |
| Permissions | Creator becomes `owner` |
| Accounting | Seeds empty CoA template after engine exists (P3) |
| Tests | New user with zero companies lands onboarding; after create, switcher shows company |
| AC | No hard-coded Demo Company in chrome; real `companies` row created |

### A3. Organisation switcher
| | |
|--|--|
| Phase / Class | P2 / CORE |
| UI | `AppShell` dropdown from `getCompanyContext` |
| Backend | `setActiveCompany`, membership check |
| Database | `profiles.last_company_id` |
| Permissions | `company.view` |
| Accounting | None (cache clear only) |
| Tests | Switch A→B clears cached invoices of A |
| AC | Only member companies listed; invalid id rejected |

### A4. Members & invitations
| | |
|--|--|
| Phase / Class | P2 invite UI; email EXT |
| UI | Settings → Users |
| Backend | `listCompanyMembers`, invite/accept RPCs |
| Database | `company_members`, `company_invitations` |
| Permissions | `members.view`, `members.manage`, `members.grant_owner` |
| Accounting | None |
| Tests | Invitee joins with role; last owner protected |
| AC | Cannot remove last owner; non-admin cannot invite |

### A5. Settings (org, FY, currency, numbering)
| | |
|--|--|
| Phase / Class | P2 base; numbering P3 |
| UI | `/settings` tabs |
| Backend | `getCompanyDetails`, `updateCompany`, sequences API |
| Database | `companies`, `document_sequences`, `currencies_enabled` |
| Permissions | `company.settings.edit` |
| Accounting | Base currency/FY affect posting & periods |
| Tests | Persist name/currency/FY; reload shows values |
| AC | No “Demo Company Ltd” defaults for real orgs |

---

## B. Accounting engine (foundation for all money)

### B1. Chart of accounts
| | |
|--|--|
| Phase / Class | P3 / CORE |
| UI | `/accounting` → CoA |
| Backend | CRUD accounts; archive; template seed |
| Database | `accounts` |
| Permissions | `accounts.manage`, `accounting.view` |
| Accounting | Defines postable targets |
| Tests | Unique codes; cannot delete account with posted lines (archive only) |
| AC | Template seeded on company create; system accounts protected |

### B2. Accounting periods
| | |
|--|--|
| Phase / Class | P3 / CORE |
| UI | Periods tab; lock/unlock |
| Backend | `PeriodService` |
| Database | `accounting_periods` |
| Permissions | `periods.lock`, `periods.unlock` |
| Accounting | Blocks post into locked periods |
| Tests | Post rejected when locked |
| AC | Non-overlapping periods; unlock audited |

### B3. Manual journals + PostingEngine
| | |
|--|--|
| Phase / Class | P3 / CORE |
| UI | New/edit journal; post; reverse |
| Backend | **PostingEngine** (sole poster) |
| Database | `journals`, `journal_lines` + balance triggers |
| Permissions | `journals.manual`, `accounting.post` |
| Accounting | Authoritative double-entry |
| Tests | Unbalanced rejected; reverse creates opposite posted JE; idempotency |
| AC | Posted immutable; TB moves correctly |

### B4. Audit history
| | |
|--|--|
| Phase / Class | P3 / CORE |
| UI | `/accounting` → Audit |
| Backend | `AuditService` |
| Database | `audit_events` append-only |
| Permissions | `audit.view` |
| Accounting | Records post/reverse/lock |
| Tests | Post creates audit row |
| AC | No update/delete of audit by clients |

### B5. Recurring journals
| | |
|--|--|
| Phase / Class | P7 / LATER |
| UI | Recurring journal schedules |
| Backend | Cron + PostingEngine |
| Database | `recurring_journals` |
| Permissions | `journals.manual` |
| Accounting | Same as manual |
| Tests | Schedule creates balanced draft/posted per setting |
| AC | Failure alerts; no silent skip without log |

### B6. Fixed assets
| | |
|--|--|
| Phase / Class | P7 / LATER (unless approved CORE) |
| UI | Asset register, depreciate, dispose |
| Backend | Depreciation run → PostingEngine |
| Database | `fixed_assets`, `depreciation_runs` |
| Permissions | `accounting.post`, `accounts.manage` |
| Accounting | DR Dep Exp / CR Accum Dep |
| Tests | Run posts N assets balanced |
| AC | Disposal posts correctly; locked period respected |

---

## C. Contacts, products, tax

### C1. Contacts (customers / suppliers)
| | |
|--|--|
| Phase / Class | P4 / CORE |
| UI | `/contacts` + filters |
| Backend | CRUD |
| Database | `contacts` |
| Permissions | `contacts.manage`, view via sales/purchases |
| Accounting | Subledger party on lines |
| Tests | RLS isolation |
| AC | Contact history lists related docs |

### C2. Products & services
| | |
|--|--|
| Phase / Class | P4 / CORE (inventory LATER) |
| UI | `/products-services` |
| Backend | CRUD + default accounts/tax |
| Database | `products` |
| Permissions | `products.manage` |
| Accounting | Default revenue/expense accounts on lines |
| Tests | Invoice line picks product defaults |
| AC | Non-stock only until inventory approved |

### C3. Tax configuration
| | |
|--|--|
| Phase / Class | P3–P4 / CORE; filing EXT |
| UI | Tax settings + rates/codes |
| Backend | `TaxService` |
| Database | `company_tax_settings`, `tax_rates`, `tax_codes` |
| Permissions | `tax.settings` |
| Accounting | Tax lines on documents → tax control accounts |
| Tests | Inclusive/exclusive price math fixtures |
| AC | Changing rates does not rewrite posted history |

---

## D. Sales

### D1. Quotes
| | |
|--|--|
| Phase / Class | P4 / CORE |
| UI | Sales → Quotes |
| Backend | CRUD; convert to invoice |
| Database | `sales_quotes` |
| Permissions | `sales.draft`, `sales.authorise` |
| Accounting | None until converted/invoiced |
| Tests | Convert copies lines |
| AC | Accepted quote creates draft invoice |

### D2. Invoices
| | |
|--|--|
| Phase / Class | P4 / CORE |
| UI | Invoice list/detail/new |
| Backend | Authorise → adapter → PostingEngine |
| Database | `sales_invoices`, lines; `posted_journal_id` |
| Permissions | `sales.*` |
| Accounting | DR AR, CR revenue/tax |
| Tests | Authorise posts once (idempotent); void reverses |
| AC | Cannot edit posted invoice amounts; credit note instead |

### D3. Credit notes
| | |
|--|--|
| Phase / Class | P4 / CORE |
| UI | Credit notes |
| Backend | Post inverse |
| Database | `sales_credit_notes` |
| Permissions | `sales.authorise` |
| Accounting | Reverse revenue/AR/tax |
| Tests | TB nets correctly |
| AC | Links to original invoice optional |

### D4. Customer payments & allocations
| | |
|--|--|
| Phase / Class | P4 / CORE |
| UI | Payments; allocate to invoices |
| Backend | Payment adapter |
| Database | `customer_payments`, `payment_allocations` |
| Permissions | `sales.payment` |
| Accounting | DR Bank, CR AR |
| Tests | Over-allocation rejected |
| AC | Invoice balance = total − allocations − credits |

### D5. Statements
| | |
|--|--|
| Phase / Class | P5 / CORE |
| UI | Statement by contact/date |
| Backend | Report from docs + AR |
| Database | reads invoices/payments |
| Permissions | `sales.view`, `reports.export` |
| Accounting | Must agree with AR control |
| Tests | Golden statement fixture |
| AC | PDF/CSV export |

### D6. Recurring invoices
| | |
|--|--|
| Phase / Class | P7 / LATER |
| UI | Schedules |
| Backend | Cron |
| Database | `recurring_invoices` |
| Permissions | `sales.authorise` |
| Accounting | Same as invoice when generated |
| Tests | Next-run creates draft/authorised per setting |
| AC | Failed run visible in UI |

---

## E. Purchases

### E1. Bills
| | |
|--|--|
| Phase / Class | P4 / CORE |
| UI | Bills |
| Backend | Authorise → PostingEngine |
| Database | `purchase_bills` |
| Permissions | `purchases.*` |
| Accounting | DR expense/tax, CR AP |
| Tests | Same as invoices (mirror) |
| AC | Posted immutable; reverse via credit/void path |

### E2. Expenses
| | |
|--|--|
| Phase / Class | P4 / CORE |
| UI | Expense form + receipt upload |
| Backend | Post to bank/expense |
| Database | `expenses`, storage attachments |
| Permissions | `expenses.submit`, `purchases.authorise` |
| Accounting | DR expense, CR bank (or liability) |
| Tests | Attachment scoped to company |
| AC | Receipt required optional by setting |

### E3. Supplier payments & credit notes
| | |
|--|--|
| Phase / Class | P4 / CORE |
| UI | Parallel to sales |
| Backend | Adapters |
| Database | `supplier_payments`, `purchase_credit_notes` |
| Permissions | `purchases.payment` |
| Accounting | DR AP / CR bank; credit inverse of bill |
| Tests | Allocation rules |
| AC | AP aging matches |

### E4. Purchase orders
| | |
|--|--|
| Phase / Class | P7 / LATER |
| UI | PO → bill |
| Backend | Convert |
| Database | `purchase_orders` |
| Permissions | `purchases.draft` |
| Accounting | None until billed |
| Tests | Convert creates draft bill |
| AC | Cannot post PO directly |

### E5. Recurring bills / employee expenses
| | |
|--|--|
| Phase / Class | P7 / LATER |
| UI | Schedules; claims approve/reimburse |
| Backend | Cron; approval workflow |
| Database | `recurring_bills`, `expense_claims` |
| Permissions | `expenses.approve` |
| Accounting | Post on approve/reimburse |
| Tests | Approval required before post |
| AC | Staff cannot self-approve if policy on |

---

## F. Banking

### F1. Bank accounts & transfers
| | |
|--|--|
| Phase / Class | P5 / CORE |
| UI | Accounts list; transfer |
| Backend | Transfer adapter |
| Database | `bank_accounts`, transfer journals |
| Permissions | `banking.*` |
| Accounting | DR/CR bank GL accounts |
| Tests | Transfer balanced; both accounts same company |
| AC | Bank GL linked 1:1 to bank account |

### F2. Import statements
| | |
|--|--|
| Phase / Class | P5 / CORE |
| UI | CSV/OFX upload |
| Backend | Parse → `bank_transactions` |
| Database | `bank_transactions` (unreconciled) |
| Permissions | `banking.import` |
| Accounting | None until categorised |
| Tests | Duplicate import idempotent |
| AC | Imported txns appear for matching |

### F3. Categorisation, reconciliation, rules
| | |
|--|--|
| Phase / Class | P5 categorise/reconcile CORE; rules LATER |
| UI | Match UI; reconcile screen; rules editor |
| Backend | Categorise → PostingEngine; reconcile marks matched |
| Database | `reconciliations`, `bank_rules` |
| Permissions | `banking.categorise`, `banking.reconcile` |
| Accounting | Posts clearing journals |
| Tests | Reconcile only when statement balance matches |
| AC | Cannot reconcile with uncategorised required items (setting) |

### F4. Bank feeds
| | |
|--|--|
| Phase / Class | P8 / EXT |
| UI | Connect institution |
| Backend | Provider webhooks → import |
| Database | feed credentials (encrypted), transactions |
| Permissions | `banking.feeds.manage` |
| Accounting | Same as import |
| Tests | Webhook signature; company scoping |
| AC | Disconnect revokes tokens |

---

## G. Reports

### G1. TB / P&L / BS / GL / Account txn
| | |
|--|--|
| Phase / Class | P5 / CORE |
| UI | `/reports` runners |
| Backend | `ReportingService` from posted lines |
| Database | read-only over ledger |
| Permissions | `reports.view`, `reports.export` |
| Accounting | Pure functions of posted JE |
| Tests | Golden fixtures after seed |
| AC | Numbers match manual spreadsheet for fixture set |

### G2. Aged AR / AP
| | |
|--|--|
| Phase / Class | P5 / CORE |
| UI | Aging reports |
| Backend | From open documents + as-of date |
| Database | invoices/bills/payments |
| Permissions | `reports.view` |
| Accounting | Must tie to AR/AP control |
| Tests | Drift detection test |
| AC | Total aging = control account balance |

### G3. Cash flow & tax reports
| | |
|--|--|
| Phase / Class | Cash flow LATER; tax summary CORE P5; filing EXT |
| UI | Report runners |
| Backend | Cash flow method TBD; tax box mapping |
| Database | ledger + tax codes |
| Permissions | `reports.view`, `tax.settings` for config |
| Accounting | Tax report from posted tax lines |
| Tests | VAT period fixture |
| AC | Tax report matches sum of tax control movements |

---

## H. Dashboard

### H1. Business overview
| | |
|--|--|
| Phase / Class | P5 / CORE |
| UI | `/` widgets |
| Backend | Aggregates from ledger + AR/AP |
| Database | same as reports |
| Permissions | `reports.view` / module views |
| Accounting | Read-only |
| Tests | Widget totals = report snapshots |
| AC | No hard-coded figures for real companies |

---

## I. Accountant tools & firm

### I1. Accountant tools
| | |
|--|--|
| Phase / Class | P6 / CORE |
| UI | `/accountant` checklist |
| Backend | Counts: unreconciled, drafts, unlocked periods |
| Database | queries |
| Permissions | `accounting.view` |
| Accounting | None |
| Tests | Counts accurate |
| AC | Deep links to fix queues |

### I2. Firm & clients
| | |
|--|--|
| Phase / Class | P6 / FIRM |
| UI | `/firm` |
| Backend | firm CRUD; link clients; switch |
| Database | `firms`, `firm_members`, `firm_client_links` |
| Permissions | firm.* → company membership |
| Accounting | None directly |
| Tests | Unlinked firm user cannot read client TB |
| AC | Access revoke immediate |

---

## J. AI Assistant

### J1. Explain / suggest / draft
| | |
|--|--|
| Phase / Class | P7 / LATER (shell earlier) |
| UI | `/ai-assistant` + contextual panels |
| Backend | `AiAssistService`; LLM server-side |
| Database | `ai_suggestions` |
| Permissions | `ai.use`, `ai.apply_suggestion` |
| Accounting | Apply → validation → PostingEngine only |
| Tests | Apply with unbalanced draft fails; permission denied for read_only apply |
| AC | Banner: AI cannot bypass tax/balance/approval; no auto-post |

---

## K. Demo Company

### K1. Demo seed & reset
| | |
|--|--|
| Phase / Class | P3 seed after engine; reset P2 flag |
| UI | Switcher + Settings reset |
| Backend | `create_demo_company`; `reset_demo_company` |
| Database | same + seed |
| Permissions | `demo.reset` when `is_demo` |
| Accounting | Seed via PostingEngine |
| Tests | Demo TB non-zero; reset clears; real company reset denied |
| AC | Same UI/workflows as real; `is_demo` does not fork posting code |

---

## L. Cross-cutting quality

### L1. Green build & CI
| | |
|--|--|
| Phase / Class | P1 / CORE |
| UI | n/a |
| Backend | n/a |
| Database | n/a |
| Permissions | n/a |
| Accounting | n/a |
| Tests | `tsc`, lint errors, build, unit/RLS in CI |
| AC | Main branch cannot merge red build |

### L2. Global search / notifications / New menu
| | |
|--|--|
| Phase / Class | New menu P4; search/notifications P7 |
| UI | AppShell |
| Backend | Search API; notification table |
| Database | optional `notifications` |
| Permissions | per entity |
| Accounting | None |
| Tests | Search RLS-scoped |
| AC | Inert controls removed or wired — no fake badges |
