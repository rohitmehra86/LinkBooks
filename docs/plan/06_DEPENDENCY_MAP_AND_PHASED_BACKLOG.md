# LinkBooks — Dependency Map & Phased Backlog

## 1. Dependency map

```
P0 Scope ratification
 └── P1 Platform harden (tsc, env, auth URLs, CI)
      └── P2 Tenancy UI (onboarding, switcher, settings, invites, isolation tests)
           └── P3 Ledger core
                │   CoA · periods · journals · PostingEngine · audit · tax codes foundation
                │   Demo seed via engine
                ├── P4 Documents & parties
                │    Contacts · products · invoices · credit notes · payments
                │    Bills · expenses · supplier credits/payments · quotes
                │    Document numbering
                └── P5 Banking + Reports + Dashboard
                     Bank accounts · import · categorise · reconcile · transfers
                     TB · P&L · BS · GL · aging · tax summary · dashboard widgets
                      └── P6 Accountant tools + Firm/client
                           └── P7 Later product depth
                                Recurring · PO · employee expenses · bank rules
                                Fixed assets · cash flow · AI apply · search/notifications
                                └── P8 External integrations
                                     Bank feeds · email provider · tax filing (MTD etc.) · billing
```

**Hard rule:** Do not build polished Sales/Purchases posting UI before **P3 PostingEngine** accepts balanced journals and TB works.

---

## 2. Feature → dependency (summary)

| Feature | Depends on |
|---------|------------|
| Post invoice | PostingEngine, CoA (AR/revenue/tax), contacts, tax codes, periods |
| Pay invoice | Bank account GL, AR, invoice balances |
| Reconcile | Bank txns, categorisation posts |
| P&L / BS / TB | Posted journals only |
| Aged AR | Invoices + payments + credits |
| Firm switch-into-client | firm_client_links → company_members |
| AI categorise apply | Banking categorise + PostingEngine + permissions |
| Demo reset | is_demo + same tables |
| Recurring invoice | Invoice authorise path + cron |
| Bank feed | Import pipeline + EXT provider |
| Fixed assets | CoA + periods + PostingEngine |
| Tax filing | Tax reports + EXT government API |

---

## 3. Phased implementation backlog

### P0 — Requirements lock (1–2 days)
- [ ] Obtain/place Full Product Scope MD **or** formally approve this plan as SSR
- [ ] Resolve decisions in `00_INDEX_AND_APPROVALS.md` (markets, assets, feeds, AI, money type)
- [ ] Tag audit docs as accepted baseline

### P1 — Stabilize (3–5 days)
- [ ] Fix `accounting.tsx` missing import + `company-empty` types (`tsc` green)
- [ ] CI: `tsc`, lint errors, `build`
- [ ] Vercel + Supabase Auth URL checklist for prod/preview
- [ ] Confirm service role server-only
- [ ] Document backup/restore drill

### P2 — Tenancy product (1–2 weeks)
- [ ] Onboarding create company / open demo
- [ ] Wire org switcher (remove hard-coded orgs)
- [ ] Settings read/write real company
- [ ] Members list; invite accept (email can stub)
- [ ] Expand `role_permissions` seed to matrix (additive)
- [ ] 2-user × 2-company isolation tests
- [ ] Demo badge only when `is_demo`

### P3 — Ledger core (3–6 weeks) ★ critical path
- [ ] Migrations: `accounts`, `accounting_periods`, `journals`, `journal_lines`, `audit_events`, `tax_rates`/`tax_codes`, `document_sequences`
- [ ] RLS + balance/period/immutability constraints
- [ ] PostingEngine + manual journal UI
- [ ] CoA templates (start: GB)
- [ ] Period lock/unlock UI
- [ ] Audit history UI
- [ ] Demo sample data via engine
- [ ] Unit + RLS + TB golden tests

### P4 — Commercial documents (4–8 weeks)
- [ ] Contacts, products
- [ ] Sales: quotes, invoices, credit notes, payments, allocations
- [ ] Purchases: bills, expenses, supplier credits/payments
- [ ] Numbering sequences
- [ ] Idempotent document posting
- [ ] E2E: invoice → payment → AR zero

### P5 — Banking, reports, dashboard (3–6 weeks)
- [ ] Bank accounts, transfers, CSV/OFX import
- [ ] Categorise + reconcile
- [ ] TB, P&L, BS, GL, account txn, aged AR/AP, tax summary
- [ ] Export PDF/CSV
- [ ] Dashboard live widgets
- [ ] Control-account vs subledger tie-out tests

### P6 — Practice features (2–4 weeks)
- [ ] Accountant tools checklist
- [ ] Firms, firm members, client links, switch UX
- [ ] Isolation tests firm↔client

### P7 — Depth (ongoing)
- [ ] Recurring invoices/bills/journals
- [ ] Purchase orders
- [ ] Employee expense claims
- [ ] Bank rules
- [ ] Fixed assets (if approved)
- [ ] Cash flow statement
- [ ] AI explain/suggest/draft + guarded apply
- [ ] Global search; notifications

### P8 — Integrations (ongoing)
- [ ] Bank feeds (provider TBD)
- [ ] Transactional email (invites, statements)
- [ ] Tax filing / MTD (market packs)
- [ ] Org/firm billing subscriptions

---

## 4. What “done” means for production accounting SaaS

Minimum bar for **paying SMB customers** (not firm portal):

- P1–P5 complete with automated tests green  
- Staging env + backup restore proven  
- No hard-coded financial figures  
- Demo uses same engine  
- Firm (P6) can follow immediately after, but is not required for first SMB launch **unless you decide firm-first**

Full vision (freelancer + bookkeeper + firm + AI + feeds) = through **P8**.
