# Competitor capability matrix & gap analysis

**Purpose:** Capability benchmarking only (not UI/layout cloning).  
**Sources:** Public product knowledge of Xero, QuickBooks Online (QBO), Zoho Books, FreshBooks, Wave, Akaunting + verified LinkBooks repo state (2026-10-22).  
**Legend:** Y = generally available · P = partial / limited · N = no / not typical · U = uncertain (verify) · — = N/A  

**LinkBooks columns:**  
- **Today** = shipped in this repo (honest)  
- **Target** = Settings Centre programme target (may be *Unavailable* until built)

**Priority:** P0 correctness/security · P1 parity · P2 differentiator  
**Stage:** Delivery stage from brief §12

---

## Matrix

| Capability | Xero | QBO | Zoho | FreshBooks | Wave | Akaunting | LB today | LB target | Pri | Stage |
|------------|------|-----|------|------------|------|-----------|----------|-----------|-----|-------|
| Org branding / locale / FY | Y | Y | Y | Y | Y | Y | Y | Y | P0 | 1–2 |
| Chart of accounts + system accounts | Y | Y | Y | P | P | Y | Y | Y | P0 | 2 |
| Period / lock dates | Y | Y | Y | P | P | Y | Y (single-tier periods) | Y + two-tier ★ | P0 | 2 |
| Close books + password/reason override | P | Y | P | N | N | P | N | Y ★ | P0 | 2 |
| Conversion / books-start date | Y | Y | P | N | N | P | N | Y ★ | P1 | 2 |
| Tracking dimensions / classes | Y (≤2 cats) | Y (class) | Y | P | N | Y | Y (multi kinds) | Y (documented limit) | P0 | 1–4 |
| Multicurrency + FX rates | Y | Y | Y | P | N | Y | Y (manual rates) | Y + stale warnings | P0 | 2 |
| Sales invoices / quotes / credits | Y | Y | Y | Y | Y | Y | Y | Y | — | done |
| Late fees | Y | Y | Y | Y | N | P | N | Y ★ | P1 | 3 |
| Reminder schedules + templates | Y | Y | Y | Y | P | P | N | Y ★ | P1 | 3 |
| Retainers / deposits | P | P | Y | Y | N | P | P (deposits partial) | Y ★ | P1 | 3 |
| Bills / purchase orders | Y | Y | Y | P | N | Y | Y | Y (preserve New Bill) | P0 | 3 |
| Bills inbox / OCR | Y | Y | Y | P | N | P | N | Unavailable until OCR | P2 | 5 |
| Bank rules + import | Y | Y | Y | P | P | Y | Y | Y + rule testing ★ | P1 | 4 |
| Live bank feeds | Y | Y | Y | P | Y | P | N (honest) | Live when OAuth real | P1 | 5 |
| Inventory / valuation | Y | Y | Y | N | N | Y | P | Y ★ | P1 | 3–4 |
| Tax packs (regional) | Y | Y | Y | P | P | Y | Y (multi packs) | Verified matrix ★ | P0 | 2 |
| Fixed assets | Y | Y | Y | N | N | Y | N | Y ★ Unavailable→Live | P2 | 4 |
| Projects / time | Y | Y | Y | Y | N | Y | P | Y ★ | P1 | 4 |
| Client / supplier portals | Y | Y | Y | Y | N | P | N | Unavailable until built | P1 | 5 |
| Custom form themes / PDF | Y | Y | Y | Y | P | Y | P (colour/footer/logo URL) | Y ★ | P1 | 3 |
| Email templates + sender domain | Y | Y | Y | Y | P | P | N (email not configured) | Y ★ | P1 | 3 / 5 |
| Approvals / thresholds | Y | Y | Y | P | N | P | P (bill approval) | Y ★ | P1 | 3–4 |
| Roles + permission matrix | Y | Y | Y | P | P | Y | Y (roles) | Matrix UI ★ | P0 | 5 |
| Advisor / firm tools | Y (HQ) | Y (Accountant) | P | N | N | N | P | Y ★ | P1 | 6 |
| Audit log | Y | Y | Y | P | P | Y | Y | Export + tamper-evidence ★ | P0 | 1 / 5 |
| API / webhooks | Y | Y | Y | Y | P | Y | N | Catalogue ★ honest | P1 | 5 |
| App marketplace / modules | N | Y | Y | N | N | Y | N | P2 evaluate | P2 | 6 |
| Custom fields / workflows | P | P | Y | P | N | P | P | Workflow whitelist ★ | P2 | 5 |
| Simple onboarding path | P | P | P | Y | Y | P | P | Simple + Full modes ★ | P1 | 1 / 7 |
| Data migration wizards | Y | Y | Y | P | P | Y | P (CSV imports) | Hub + Verified matrix ★ | P1 | 5 |
| Support access consent | Y | Y | P | P | N | N | N | Y ★ | P1 | 5 |
| Feature / module manager | P | P | Y | P | N | Y | N | Universal Feature Manager | P0 | 1 |
| AI assistant controls | P | P | Y | P | N | N | P (honest not configured) | Per-capability ★ | P1 | 5 |
| Subscription entitlements | Y | Y | Y | Y | Y | Y | N / stub | Drive Feature Manager | P1 | 6 |
| Notifications centre | Y | Y | Y | Y | P | P | N | Cat 21 ★ | P1 | 3 |
| Import & migration hub | Y | Y | Y | P | P | Y | P | Cat 24 ★ | P1 | 5 |

★ = called out in brief as competitor gap vs earlier draft.

---

## LinkBooks-today vs 24 categories

| # | Category | Today | Notes |
|---|----------|-------|-------|
| 1 | Organisation & Branding | Partial | Core fields yes; idle timeout, CoA template at create limited |
| 2 | Accounting & Financial | Partial | Periods on `/accounting`; no two-tier / conversion date |
| 3 | Sales & Receivables | Partial | Module strong; settings thin (terms/notes); no late fees/reminders |
| 4 | Purchases & Payables | Strong core | New Bill + bills workspace; inbox/OCR Unavailable |
| 5 | Banking & Reconciliation | Strong core | Feeds not live |
| 6 | Dimensions & Projects | Partial | Dimensions yes; projects/billing methods incomplete |
| 7 | Tax & Compliance | Partial→Strong | Packs exist; Verified matrix UI missing |
| 8 | Products & Inventory | Partial | Products exist; advanced inventory settings missing |
| 9 | Reports & Dashboards | Partial | Reports centre; packs/schedules missing |
| 10 | Documents & Templates | Partial | Sequences + branding URL |
| 11 | Currencies & FX | Partial | Manual FX solid; live source Unavailable |
| 12 | Contacts & CRM | Partial | Settings page; portals N |
| 13 | Expenses & Time | Partial | Employee expenses; time/rate cards thin |
| 14 | Automation & AI | Thin | Defaults only; AI not configured |
| 15 | Users & Security | Partial | Roles/invites; MFA/SSO/IP lists missing |
| 16 | Integrations & API | Placeholders | Honest Unavailable |
| 17 | Audit & Data Mgmt | Partial | Events list; export/hash chain missing |
| 18 | Accountant & Firm | Thin | Routes exist; practice tools incomplete |
| 19 | Subscription & Usage | Missing | |
| 20 | Demo & Developer | Partial | Demo reset exists |
| 21 | Notifications | Missing | |
| 22 | Portals | Missing | Mark Unavailable |
| 23 | Fixed Assets | Missing | Mark Unavailable |
| 24 | Import & Migration | Partial | CSV paths; no competitor wizards |

---

## Prioritised checklist (for gate approval)

### P0
1. Settings registry + RLS/RPC mutation path + per-change audit  
2. Feature Manager five-state (server-computed)  
3. Dependency engine skeleton (FX, dimensions, multicurrency, approvals)  
4. Settings shell: Overview, nav, search/synonyms, Cmd+K, unsaved changes  
5. Period lock policy decision + implementation path (two-tier or phased Unavailable)  
6. Permission enforcement tests (cross-tenant + role deny)

### P1
7. Sales: reminders, late fees, themes, void/write-off policies  
8. Purchases: approval thresholds; preserve New Bill; inbox Unavailable  
9. Banking rule-engine settings + format catalogue  
10. Tax Verified/Beta/Unavailable matrix UI  
11. Documents themes + email templates (email provider dependency)  
12. Firm practice dashboard + templates  
13. Import/migration hub honesty  
14. Notifications preferences  
15. Security: MFA flags, support access consent, session revoke  

### P2
16. Portals, fixed assets, Zoho-class workflows, marketplace, Wave simple mode polish  

---

## Uncertain (verify before claiming parity)

- Exact Xero HQ vs QBO Accountant feature parity for bulk client actions  
- FreshBooks retainer edge cases vs Zoho retainers  
- Akaunting module marketplace licensing model  
- Wave current inventory / multicurrency status (product changes frequently)

---

*Stage 0 deliverable. Implementation starts only after priority approval.*
