# LinkBooks Recurring Transactions V2 — Competitor capability matrix & gap analysis

| Field | Value |
|-------|--------|
| **Date** | 2026-10-22 |
| **Stage** | 0 — priorities for owner approval |
| **Legend** | **Y** = generally supported · **P** = partial · **N** = not supported · **?** = verify against vendor docs · **U** = unavailable in LinkBooks today by design |

Competitor columns reflect **public product positioning** (marketing/help centre level), not licensed feature audits. Where uncertain, marked **?**.

**LinkBooks-today** = repo state as of audit in `00-AUDIT.md`.  
**LinkBooks-target** = V2 brief acceptance criteria.

**Priority:** **P0** correctness/security · **P1** Xero/QBO parity · **P2** differentiator

---

## A. Core modes & document types

| Capability | Xero | QBO | Zoho | FreshBooks | Wave | Akaunting | LinkBooks-today | LinkBooks-target | Pri | Stage |
|------------|------|-----|------|------------|------|-----------|-----------------|------------------|-----|-------|
| Repeating supplier bills | Y | Y | Y | P | P | Y | P | Y | P1 | 2 |
| Repeating sales invoices | Y | Y | Y | Y | Y | Y | P | Y | P1 | 3 |
| Scheduled auto-create | Y | Y | Y | Y | P | P | N | Y | P0 | 1–2 |
| Reminder-only (notify, manual create) | P | Y | P | P | N | ? | N | Y | P1 | 6 |
| On-demand template (unscheduled) | P | Y | P | P | P | P | N | Y | P1 | 3 |
| Purchase credit notes recurring | P | P | P | N | N | ? | N | Y | P1 | 4 |
| Sales credit notes recurring | P | P | P | N | N | ? | N | Y | P1 | 4 |
| Expenses / receipts recurring | P | Y | P | Y | P | P | N | Y | P1 | 4 |
| Manual journals recurring | Y | P | P | N | N | P | N | Y | P1 | 5 |
| Auto-reversing accrual journals | Y | P | P | N | N | ? | N | Y | P1 | 5 |
| Bank transfer templates | N | P | P | N | N | N | N | P | P2 | 5 |
| Bank deposits recurring | P | P | P | N | N | ? | N | P | P2 | 5 |
| Purchase orders / quotes recurring | P | P | P | N | N | ? | N | U* | P2 | 5 |
| Premium overlay editor (not separate page) | N | N | N | N | N | N | N | Y | P1 | 2–3 |

\*PO/quotes recurring only if standard PO/quote posting workflow exists — LinkBooks has POs **without ledger post**; target = template for PO doc only, labelled clearly.

---

## B. Scheduling & calendar

| Capability | Xero | QBO | Zoho | FreshBooks | Wave | Akaunting | LinkBooks-today | LinkBooks-target | Pri | Stage |
|------------|------|-----|------|------------|------|-----------|-----------------|------------------|-----|-------|
| Daily / weekly / monthly / yearly | Y | Y | Y | Y | Y | Y | P (4 enums) | Y | P0 | 1 |
| Custom interval (every N weeks/months) | P | Y | Y | P | P | P | N | Y | P1 | 1 |
| Fortnightly / quarterly / half-yearly | Y | Y | Y | P | P | P | P (quarterly only) | Y | P1 | 1 |
| Specific weekday / day-of-month | Y | Y | Y | P | P | P | N | Y | P1 | 1 |
| Last day / last business day of month | Y | P | Y | N | N | ? | N | Y | P1 | 1 |
| RFC 5545 / robust recurrence engine | ? | ? | ? | ? | ? | ? | N | Y | P0 | 1 |
| Anchor-based dates (31st → Feb end) | Y | Y | Y | ? | ? | ? | N | Y | P0 | 1 |
| Org time zone for document dates | Y | Y | Y | P | P | ? | N | Y | P0 | 1 |
| DST policy explicit | ? | ? | ? | ? | ? | ? | N | Y | P0 | 1 |
| Business-day adjustment | P | P | P | N | N | ? | N | Y | P1 | 1 |
| Holiday calendars (country + custom) | P | P | P | N | N | ? | N | Y | P1 | 1–6 |
| Generate N days in advance | Y | Y | Y | Y | P | ? | N | Y | P1 | 2 |
| End date / max occurrences | Y | Y | Y | Y | P | P | N | Y | P1 | 1 |
| Skip next / skip specific date | P | P | P | N | N | ? | N | Y | P1 | 6 |
| Catch-up after downtime (policy) | P | P | P | N | N | ? | N | Y | P0 | 1 |
| Upcoming preview (12+ dates) | Y | Y | Y | P | P | P | N | Y | P1 | 2 |
| Server scheduler (no browser) | Y | Y | Y | Y | P | P | N | Y | P0 | 1 |

---

## C. Generation outcomes & delivery

| Capability | Xero | QBO | Zoho | FreshBooks | Wave | Akaunting | LinkBooks-today | LinkBooks-target | Pri | Stage |
|------------|------|-----|------|------------|------|-----------|-----------------|------------------|-----|-------|
| Default save as draft | Y | Y | Y | Y | Y | Y | Y | Y | P0 | 2 |
| Generate awaiting approval | P | Y | Y | P | N | ? | N | Y | P1 | 6 |
| Auto-authorise when valid | P | Y | Y | P | P | P | P (flag) | Y | P1 | 6 |
| Approve and email + PDF | Y | Y | Y | Y | P | ? | N | P** | P1 | 3 |
| Payment link on invoice email | P | Y | Y | Y | Y | ? | N | U** | P2 | 3 |
| Auto-charge saved payment method | N | P | Y | Y | Y | ? | N | U** | P2 | 6 |
| Pull unbilled time / expenses | Y | P | Y | Y | N | N | N | U*** | P2 | 3 |
| Placeholders in reference/description | P | Y | P | P | N | ? | N | Y | P1 | 2 |
| Variable amounts / needs-input state | P | P | P | P | N | ? | N | Y | P1 | 6 |
| Effective-dated tax at generation | Y | Y | Y | Y | P | ? | P | Y | P0 | 2–3 |

\*\* Email / payments **Unavailable** until LinkBooks integrations operational (`settings` truth table).  
\*\*\* Time tracking module not evidenced — mark Unavailable until product exists.

---

## D. Template editor parity (bills / invoices)

| Capability | Xero | QBO | Zoho | FreshBooks | Wave | Akaunting | LinkBooks-today | LinkBooks-target | Pri | Stage |
|------------|------|-----|------|------------|------|-----------|-----------------|------------------|-----|-------|
| Full supplier bill header fields | Y | Y | Y | P | P | P | P | Y | P1 | 2 |
| Full invoice header + shipping | Y | Y | Y | Y | P | P | N | Y | P1 | 3 |
| Unlimited lines, reorder | Y | Y | Y | Y | P | P | P (1-line UI) | Y | P1 | 2–3 |
| Product/service catalogue lines | Y | Y | Y | Y | P | P | P (New Bill) / N (recurring) | Y | P1 | 2 |
| Tax codes + inclusive/exclusive modes | Y | Y | Y | Y | P | P | P (bill) / partial (recurring) | Y | P0 | 2 |
| Dimensions (class/location/project) | P | Y | Y | P | N | ? | P (bill) / N (recurring JSON) | Y | P1 | 2 |
| Billable + customer on expense lines | P | Y | Y | Y | N | ? | P (bill) / N (recurring) | Y | P1 | 2 |
| Attachments on template | P | P | P | Y | P | ? | N | Y | P1 | 2 |
| FX policy on template | Y | Y | Y | P | P | P | N | Y | P1 | 2–3 |
| Template versioning / restore | P | P | P | N | N | ? | N | Y | P1 | 7 |
| Create template from posted doc | Y | Y | Y | Y | P | P | P (Make recurring dialog) | Y | P1 | 7 |

---

## E. Controls, approvals & exceptions

| Capability | Xero | QBO | Zoho | FreshBooks | Wave | Akaunting | LinkBooks-today | LinkBooks-target | Pri | Stage |
|------------|------|-----|------|------------|------|-----------|-----------------|------------------|-----|-------|
| Role-based permissions | Y | Y | Y | Y | P | P | Y | Y | P0 | 1 |
| Multi-level approval on output | P | Y | Y | P | N | ? | P (bills only) | Y | P1 | 6 |
| Amount / tax / supplier change review | P | Y | Y | N | N | ? | N | Y | P1 | 6 |
| Segregation of duties (creator ≠ approver) | P | P | P | N | N | ? | N | Y | P1 | 6 |
| Locked period policy per template | P | P | P | N | N | ? | N (fail at post) | Y | P0 | 6 |
| Duplicate supplier invoice detection | Y | Y | Y | P | P | P | Y (manual bills) | Y | P1 | 6 |
| Inactive master data → exception | P | Y | Y | P | P | ? | N | Y | P0 | 6 |
| Exception centre UI | P | P | P | P | N | ? | N | Y | P1 | 6 |
| Auto-pause after N failures | P | P | P | P | N | ? | N | Y | P1 | 6 |
| Audit trail on template/schedule/run | P | Y | Y | P | P | P | N | Y | P0 | 1 |

---

## F. Operations, integrity & platform

| Capability | Xero | QBO | Zoho | FreshBooks | Wave | Akaunting | LinkBooks-today | LinkBooks-target | Pri | Stage |
|------------|------|-----|------|------------|------|-----------|-----------------|------------------|-----|-------|
| Idempotent occurrence key | ? | ? | ? | ? | ? | ? | N | Y | P0 | 1 |
| Concurrent worker safety | Y | Y | Y | ? | ? | ? | N | Y | P0 | 1 |
| Materialised occurrence rows | ? | ? | ? | ? | ? | ? | N | Y | P0 | 1 |
| Historical docs immutable when template edits | Y | Y | Y | Y | Y | Y | Y | Y | P0 | 1 |
| Management list server pagination | Y | Y | Y | Y | P | P | N (limit 100) | Y | P1 | 2 |
| Saved views / bulk actions | P | Y | Y | P | N | ? | N | Y | P2 | 7–8 |
| CSV export templates / forecast | P | Y | Y | Y | P | P | N | Y | P2 | 7 |
| Cash-flow forecast feed (read-only) | Y | Y | Y | P | P | ? | N | Y | P2 | 7 |
| Feature Manager 5-state gating | N | N | N | N | N | N | N | Y | P1 | 6 |
| Firm template packs for clients | P | P | P | N | N | N | N | Y | P2 | 7 |
| Amortisation / prepayment link | P | P | P | N | N | ? | N | Y | P2 | 7 |

---

## G. LinkBooks-today → target — consolidated backlog

### P0 (must be in Stage 1 before overlay UX)

1. **Schema:** templates, schedule rules, occurrences, runs, exceptions, audit — RLS on all; **non-destructive migration** from `recurring_bills` / `sales_recurring_invoices`.
2. **Recurrence engine:** vetted RRULE (+ business-day extension); property-based date tests; injected clock.
3. **Scheduler:** durable worker with `FOR UPDATE SKIP LOCKED`, occurrence unique constraint, posting idempotency key derived from occurrence.
4. **Security:** cross-tenant tests; RPC-only mutations; no browser-dependent cron.
5. **Accounting:** draft default preserved; auto-authorise behind explicit permission; locked-period policy.

### P1 (parity — Stages 2–6)

1. Premium **overlay** (deep link, tabs, focus trap) + management workspace.
2. **Bill / invoice editor parity** with New Bill / Sales Invoice (shared components).
3. Modes: scheduled, reminder, on-demand.
4. Skip, catch-up policies, preview, placeholders, effective-dated tax resolution.
5. Approvals, exception centre, notifications via Settings.
6. Credit notes, expenses, receipts (Stage 4).

### P2 (differentiators — Stages 7–8)

1. Forecast commitments vs actuals separation.
2. Firm recurring template packs.
3. Amortisation schedules linked to prepayment/deferred income.
4. Bulk edit, exports, advanced reporting.

---

## H. Stage 0 gate checklist

| Item | Status |
|------|--------|
| Audit doc complete | Yes — `00-AUDIT.md` |
| Capability matrix complete | Yes — this file |
| Existing recurring bills behaviour documented | Yes |
| Scheduler gap explicitly reported | Yes — **no in-repo job** |
| Email / payment auto-charge blockers named | Yes |
| Feature Manager gap named | Yes |
| Owner priority approval | **Pending** |

---

## I. Suggested owner decisions (Stage 0 exit)

1. Confirm **Stage 1 scheduler host**: Supabase `pg_cron` + SQL/RPC vs Vercel cron → secured Start route (`LOVABLE_CRON_SECRET`).
2. Confirm **legacy table strategy**: parallel new schema + adapter vs in-place evolution (recommend **new schema + migrate rows** for occurrence model).
3. Confirm **Stage 2 scope**: bills-only overlay first vs bills+invoices parallel (brief says bills then invoices — **recommend strict order**).
4. Accept **Unavailable** labelling for email, auto-charge, time/expense pull until integrations ship.

---

*Public competitor cells marked **?** should be verified before marketing claims; LinkBooks-target columns reflect the V2 brief, not a commitment until stages complete.*
