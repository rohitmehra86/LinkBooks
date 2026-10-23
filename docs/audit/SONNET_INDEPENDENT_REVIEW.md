# LinkBooks — Independent Second Review (Sonnet)

- Date: 23 Oct 2026
- Branch: `cto-master-programme`
- Supabase project: `ipxflpzfcqwtenodbxwc`
- Scope: verified from code and the live DB. The first reviewer's `docs/audit/` and `docs/plans/` documents were **not** used as evidence.
- Short company ids used below: `2519` = `25197bd0-0ca6-4ac4-b23e-ea7b8fd31293`, `7825` = `78250720-9d74-4263-902c-653c2000d70b`. Both are `companies.is_demo = true`, both named "Demo Company Ltd".

---

## 1. Method

- No file under `src/` or `supabase/` was edited. The only file written is this one. No git commit or push.
- Live DB access was read-only: `SELECT`, `pg_policies`, `pg_proc`, `pg_get_functiondef`, `information_schema`, `pg_trigger` and `pg_constraint`. No INSERT, UPDATE, DELETE or DDL.
- Money checks use `journals.status = 'posted'`. Every journal in both demo companies is `posted`: 2519 has 16, 7825 has 20. There are no draft or voided journals.
- Balance-sheet and trial-balance checks use the `accounts.account_type` enum (asset, liability, equity, income, expense).
- Source code was read for `posting-engine.ts`, both named migrations, `seed-demo.ts`, `demo-dataset.ts`, `purchases/posting.ts`, `purchases.functions.ts` (supplier-payment void) and `accounting.functions.ts`.
- Live function definitions were pulled with `pg_get_functiondef`. They match the migrations for `post_journal` and `reverse_journal`.
- The working tree was clean when I checked. The initial status snapshot showed 3 modified files, but `git status` was empty on re-check.

---

## 2. Test results

`npm test` (vitest) — **40 test files passed, 0 failed. 236 tests passed, 0 failed.** Duration 2.56 s.

- I did not run `tsc`, lint, build or e2e tests.
- The unit tests mock the DB. They do not exercise `post_journal`, RLS or the GL/subledger link.

---

## 3. Findings table

Each row was verified by running the SQL or reading the cited code.

| # | Test | Expected | Actual | Result | Affected records | Root cause |
|---|---|---|---|---|---|---|
| a | Posted journals balance and have ≥ 2 lines | ΣD = ΣC per journal; lines ≥ 2 | 2519: 16 posted, 0 unbalanced, 0 with <2 lines, ΣD = ΣC = 15,362,500. 7825: 20 posted, 0 unbalanced, 0 with <2 lines, ΣD = ΣC = 15,409,500 | **PASS** | — | — (but see S1: the DB cannot enforce this on direct inserts) |
| b | Cross-company integrity | 0 lines whose account or journal belongs to another company | Lines whose account is in another company: 0 / 0. Lines whose journal is in another company: 0 / 0. Orphan lines: 0 / 0 | **PASS (data)** | — | Only data was checked. No constraint prevents it (S1, S2) |
| c | Trial balance nets to 0 | Σ(D − C) = 0 | 2519: D = C = 15,362,500, net 0. 7825: D = C = 15,409,500, net 0 | **PASS** | — | — |
| d | Balance sheet equation (A = L + E + NI) | equal | 2519: A 9,032,500 = L 3,355,000 + E 5,000,000 + NI 677,500. 7825: A 9,023,500 = L 3,356,000 + E 5,000,000 + NI 667,500. NI = −(income net + expense net) | **PASS** | — | — |
| e | AR (1100) GL vs open sales invoices | equal | 2519: GL 480,000 (D 1,800,000 − C 1,320,000) vs 1 open invoice (INV-1002) 480,000. 7825: identical, 480,000 vs 480,000 | **PASS** | INV-1001 paid, INV-1002 authorised with 120,000 credited | — |
| f | AP (2000) GL vs open bills | equal | 2519: GL credit 75,000 vs open bills 0 → **gap 75,000**. 7825: GL credit 76,000 vs open bills 1,000 (PUR-0002) → **gap 75,000** | **FAIL** | Journal #11 in both companies (idempotency key `demo:cos-ap:<company>`) | Manual journal DR 5000 / CR 2000 for 75,000 with no purchase bill. See §4 |
| f2 | AP document linkage | every AP-touching journal has a linked subledger doc | Journals #5 (`demo:pay-2001`) and #10 (`demo:pcn-1`) have no linked document. `supplier_payments` SPAY-2001 and `purchase_credit_notes` PCN-1 have `posted_journal_id` NULL in both companies. Journal #11 has no document | **FAIL** | 2519: #5, #10, #11. 7825: #5, #10, #11 | `linkDemoDocumentsToJournals` never links PCN-1 or SPAY-2001 (§4); #11 has no document at all |
| f3 | AP document statuses | fully credited bill is closed | BILL-2002: status `authorised`, total 240,000, paid 0, credited 240,000, open balance 0. It still appears in the "open bills" query (n = 1 in 2519, n = 2 in 7825) with a balance of 0 | **FAIL (minor)** | BILL-2002 in both companies | `upsertDemoBill` writes the status directly (`seed-demo.ts:991-1008`) and never derives it from the balance |
| f4 | Payment allocation consistency | `bills.amount_paid_minor` = Σ live allocations | 7825 PUR-0002: paid 11,000, but allocation rows sum to 23,000. The voided payment `12345` (12,000) still has its allocation row | **FAIL (minor)** | `supplier_payment_allocations` for payment `12345` | Void flow (`purchases.functions.ts:1760-1825`) reverses the journal and decrements the bill but never deletes or zeroes the allocation |
| g1 | Bank GL (1000) vs `bank_transactions` | bank txns tie to GL via `reconciliation_links` | GL 1000: 2519 = 6,162,500, 7825 = 6,151,500. Bank txns per company: 210 rows, Σ 2,316,850. **0 `reconciliation_links` in the whole DB.** 35 matched and 31 reconciled txns per company have no link | **FAIL** | 66 txns per company, 132 DB-wide (matched 70, reconciled 62) | Demo seed inserts bank txns with status `matched`/`reconciled` directly (`seed-demo.ts:189-222`) and never creates journals or links. The GL has PPE, loan and opening items that no bank txn explains. 7825's supplier payment journal #20 (−11,000) has no bank txn |
| g2 | Tax control accounts | balance equals tax on posted docs | 2100 (credit): 280,000 in both = 200,000 + 100,000 − 20,000 (INV-1001, INV-1002, SCN-1). 1200 (debit): 2519 = 110,000 (80,000 + 30,000 + 40,000 − 40,000), 7825 = 112,000 (+2,000 PUR-0002) | **PASS (sanity)** | — | Tied to the journal lines of the source docs. I did not tie them to `tax_minor` on each document. There is no VAT settlement journal. Account 1200 is named "VAT Recoverable / Other Current Assets" and 2100 "Tax Payable" |
| h | Paid/authorised/partly_paid docs without `posted_journal_id` | 0 | 0 sales invoices and 0 purchase bills, in both companies | **PASS (live DB)** | — | **At risk on a fresh seed:** `seed-demo.ts:520-532` creates BILL-2003 as `authorised` (114,000) with no journal, and the link step does not cover it (§4). Live DB has BILL-2003 as `draft`, so the code and DB have drifted |
| i | `reconciliation_links` vs `bank_transactions` | every matched/reconciled txn has exactly one link; no orphans | 0 links; 0 orphans; 132 matched/reconciled txns without a link | **FAIL** | see g1 | Same as g1 |
| j | Doc dates vs journal dates (extra) | consistent | BILL-2001 doc 2025-06-20 vs journal 2026-05-20. BILL-2002 doc 2025-10-01 vs journal 2026-09-01. INV-1001 doc 2025-06-15 vs journal 2026-05-15. INV-1002 doc 2025-09-01 vs journal 2026-08-01. Bank txns are also dated 2025. The only open period is FY 2026-04-01..2027-03-31 | **FAIL (minor)** | all canonical demo docs | Documents are seeded (`seed-demo.ts`, e.g. line 494) with 2025 dates, while `DEMO_JOURNAL_SPECS` use 2026 dates. Ageing is driven by doc due dates, the GL by journal dates |
| k | Demo flag protection | `is_demo` cannot be flipped | Trigger `companies_is_demo_guard` blocks both directions | **PASS** | — | — |

---

## 4. AP gap root cause

### 4.1 Conclusion

The gap is **exactly 75,000 minor units in each company**, from one journal.

- **Journal #11, "Cost of sales on account", posted 2026-09-20**, is `source_type = manual`. It is DR 5000 Cost of Sales 75,000 / CR 2000 Accounts Payable 75,000. Idempotency key is `demo:cos-ap:<company_id>`.
  - It comes from `DEMO_JOURNAL_SPECS` (`src/lib/demo/demo-dataset.ts:163-172`), posted in the loop at `src/lib/demo/seed-demo.ts:766-811`.
  - No purchase bill, credit note or supplier payment exists for it.
  - `post_journal` accepts it. `accounts.is_control = true` for 2000, but nothing in `post_journal` checks that flag (`20261019140000_accounting_engine.sql:664-673`).
- Reconciling the gap:
  - 2519: GL 75,000 = journal #11 (75,000) + open bills (0).
  - 7825: GL 76,000 = journal #11 (75,000) + PUR-0002 open balance (1,000).
  - Gap versus linked open bills = 75,000 in both.

### 4.2 Every journal line on account 2000

For both companies, journals #4, #5, #9, #10 and #11 are identical. D = debit, C = credit, minor units.

| Journal | Date | source_type | Memo | Idempotency key | D | C | Linked document |
|---|---|---|---|---|---|---|---|
| #4 | 2026-05-20 | purchase_bill | BILL-2001 Office Supplies Co | `demo:bill-2001:<co>` | 0 | 480,000 | BILL-2001 (paid, 480,000) |
| #5 | 2026-06-05 | supplier_payment | Payment BILL-2001 | `demo:pay-2001:<co>` | 480,000 | 0 | **None.** SPAY-2001 has `posted_journal_id` NULL |
| #9 | 2026-09-01 | purchase_bill | BILL-2002 then credited | `demo:bill-2002:<co>` | 0 | 240,000 | BILL-2002 (`authorised`, credited 240,000) |
| #10 | 2026-09-08 | purchase_credit_note | PCN-1 Supplier credit | `demo:pcn-1:<co>` | 240,000 | 0 | **None.** PCN-1 has `posted_journal_id` NULL |
| #11 | 2026-09-20 | manual | Cost of sales on account | `demo:cos-ap:<co>` | 0 | 75,000 | **None. This is the gap.** |

Additional journals, **7825 only**:

| Journal | Date | source_type | Memo | Idempotency key | D | C | Linked document |
|---|---|---|---|---|---|---|---|
| #17 | 2026-10-21 | purchase_bill | (none) | `purchase_bill:ef461815-…:authorise` | 0 | 12,000 | PUR-0002 (`partly_paid`, total 12,000, paid 11,000) |
| #18 | 2026-10-22 | supplier_payment | 12345 | `supplier_payment:ceee10f0-…:post` | 12,000 | 0 | Payment `12345` (`void`, 12,000) |
| #19 | 2026-10-22 | reversal | Reversal of journal #18 | `supplier_payment:ceee10f0-…:void` | 0 | 12,000 | Reversal of #18 (not linked to any document, by design) |
| #20 | 2026-10-22 | supplier_payment | Paid | `supplier_payment:5e3e23e5-…:post` | 11,000 | 0 | Payment `123456` (`paid`, 11,000) |

All of these journals have `status = posted`.

2519 account 2000 totals: D 720,000, C 795,000, net C 75,000. 7825: D 743,000, C 819,000, net C 76,000.

### 4.3 Purchase documents with a status other than draft

| Company | Doc | Status | Total | Paid | Credited | posted_journal |
|---|---|---|---|---|---|---|
| both | Bill BILL-2001 | paid | 480,000 | 480,000 | 0 | #4 |
| both | Bill BILL-2002 | **authorised (mis-statused)** | 240,000 | 0 | 240,000 | #9 |
| 7825 | Bill PUR-0002 | partly_paid | 12,000 | 11,000 | 0 | #17 |
| both | Credit note PCN-1 | authorised | 240,000 | allocated 240,000 | — | **NULL** |
| both | Supplier payment SPAY-2001 | authorised | 480,000 | allocated 480,000 | — | **NULL** |
| 7825 | Supplier payment 12345 | void | 12,000 | — | — | #18 |
| 7825 | Supplier payment 123456 | paid | 11,000 | — | — | #20 |

The rest are draft: 2519 has 283 draft bills, 7825 has 83. All have `posted_journal_id` NULL and are excluded from AP correctly.

### 4.4 Why the "known issue" appears

- The open-bill formula only counts bills linked to a journal. Journals #5 and #10 net out against the linked bills #4 and #9, so they do not move the balance.
- Journal #11 has no bill. It is the whole gap.
- Secondary defects (not part of the gap, but they would break any drill-down):
  - PCN-1 and SPAY-2001 have no journal link.
  - BILL-2002 is `authorised` with a zero balance.
  - The voided payment still has an allocation row.

### 4.5 Seed code defects behind it

- `linkDemoDocumentsToJournals` (`src/lib/demo/seed-demo.ts:1031-1085`) links INV-1001, INV-1002 and BILL-2001/2002 (billLinks `1052-1064`), plus SCN-1 and RCP-1001. It never links `demo:pcn-1` or `demo:pay-2001`. The seeded rows for those are at `:606-640` and `:643-688`.
- `demo:cos-ap` has no counterpart document at all.
- `upsertDemoBill` (`:964-1028`) writes `status`, `amount_paid_minor` and `amount_credited_minor` directly, before the journals exist. The "document first, link later" order depends on the link step being complete.
- BILL-2003 is seeded as `authorised` with total 114,000 and no journal (`:520-532`). On a fresh Demo it would break check h and make AP subledger exceed GL by 114,000. The live DB has it as `draft`.
- Posting errors matching `/idempoten|already|duplicate/` are swallowed (`:801-803`). The idempotency lookup then resolves the existing journal, which is fine. Document inserts are guarded by `existsBy` and the link step is `.update(...).is("posted_journal_id", null)`, so a re-run cannot change a document that already exists with different status or amounts (not tested).

### 4.6 SQL used

All read-only.

```sql
-- Every journal line on account 2000 with any linked document (demo companies)
select left(j.company_id::text,4) co, j.journal_number jn, j.journal_date, j.status::text st,
       j.source_type::text src, left(j.source_id::text,8) src_id, j.memo, j.idempotency_key idem,
       l.debit_minor d, l.credit_minor cr, l.description ldesc,
 (select string_agg('bill:'||b.bill_number||'/'||b.status::text||'/tot='||b.total_minor, ';')
    from purchase_bills b where b.posted_journal_id=j.id or b.void_journal_id=j.id) bills,
 (select string_agg('cn:'||n.credit_number||'/'||n.status::text||'/tot='||n.total_minor, ';')
    from purchase_credit_notes n where n.posted_journal_id=j.id) cns,
 (select string_agg('pay:'||coalesce(p.reference,'-')||'/'||p.status::text||'/amt='||p.amount_minor, ';')
    from supplier_payments p where p.posted_journal_id=j.id) pays
from journal_lines l
join journals j on j.id=l.journal_id
join accounts a on a.id=l.account_id
where a.code='2000' and j.company_id in (select id from companies where is_demo)
order by j.company_id, j.journal_number, l.line_no;

-- Non-draft purchase documents with their posted/void journal numbers
select left(company_id::text,4) co, 'bill' kind, bill_number num, status::text st, total_minor tot,
       amount_paid_minor paid, amount_credited_minor cred,
       (select journal_number from journals where id=posted_journal_id) pj,
       (select journal_number from journals where id=void_journal_id) vj, bill_date dt, memo
from purchase_bills
where company_id in (select id from companies where is_demo) and status<>'draft'
union all
select left(company_id::text,4),'credit_note',credit_number,status::text,total_minor,amount_allocated_minor,null,
       (select journal_number from journals where id=posted_journal_id),null,credit_date,memo
from purchase_credit_notes where company_id in (select id from companies where is_demo)
union all
select left(company_id::text,4),'supplier_payment',coalesce(reference,'-'),status::text,amount_minor,
       amount_minor-unallocated_minor,unallocated_minor,
       (select journal_number from journals where id=posted_journal_id),null,payment_date,memo
from supplier_payments where company_id in (select id from companies where is_demo)
order by 1,2,3;

-- AP / AR / bank / tax GL vs open subledger
with c as (select id from companies where is_demo),
gl as (select a.company_id, a.code, a.name, coalesce(sum(l.debit_minor),0) d, coalesce(sum(l.credit_minor),0) cr
       from accounts a join c on c.id=a.company_id
       left join journal_lines l on l.account_id=a.id
            and exists (select 1 from journals j where j.id=l.journal_id and j.status='posted')
       where a.code in ('1000','1100','1200','2000','2100') group by 1,2,3),
ar as (select company_id, count(*) n, coalesce(sum(total_minor-amount_paid_minor-amount_credited_minor),0) open_
       from sales_invoices where company_id in (select id from c)
        and status in ('authorised','partly_paid') and posted_journal_id is not null group by 1),
ap as (select company_id, count(*) n, coalesce(sum(total_minor-amount_paid_minor-amount_credited_minor),0) open_
       from purchase_bills where company_id in (select id from c)
        and status in ('authorised','partly_paid') and posted_journal_id is not null group by 1)
select 'GL', company_id::text, code||' '||name, 'D-C='||(d-cr) from gl
union all select 'AR_open', company_id::text, 'n='||n, 'open='||open_ from ar
union all select 'AP_open', company_id::text, 'n='||n, 'open='||open_ from ap;

-- Allocation consistency (found the stale allocation on PUR-0002)
select b.bill_number, b.amount_paid_minor,
       coalesce((select sum(amount_minor) from supplier_payment_allocations a where a.bill_id=b.id),0) alloc
from purchase_bills b
where b.company_id in (select id from companies where is_demo) and b.status<>'draft';
```

The trial balance, balance sheet, cross-company, unposted-doc and reconciliation queries followed the same pattern. They are summarised in §3. The unposted-doc check was `status in ('paid','authorised','partly_paid') and posted_journal_id is null` on `sales_invoices` and `purchase_bills`. The reconciliation check compared `bank_transactions.status in ('matched','reconciled')` against `reconciliation_links`.

---

## 5. Security / RLS findings

Severity is my judgement. "Verified live" means confirmed in `pg_policies`, `pg_proc` or `pg_trigger`.

### 5.1 Settings tables (task 4)

Verified live from `pg_policies`.

| Table | RLS | Policies | Cross-tenant | Direct client writes |
|---|---|---|---|---|
| `organisation_config` | on | SELECT `is_company_member(company_id)`; INSERT/UPDATE/DELETE `false` | No | Blocked |
| `organisation_features` | on | SELECT member; INSERT/UPDATE/DELETE `false` | No | Blocked |
| `organisation_lock_policy` | on | SELECT member; INSERT/UPDATE/DELETE `false` | No | Blocked |
| `settings_change_log` | on | SELECT `has_company_permission(..,'audit.view')`; INSERT `false`. No UPDATE or DELETE policy, which RLS denies by default | No | Blocked |
| `organisation_secrets` | on | SELECT `false`; ALL `false` | No | Blocked, never readable |
| `money_documents` | on | SELECT member; **ALL for `accounting.post` OR `journals.manual`** | Not by RLS `company_id`. See M2 | **Allowed** for roles accountant/admin/bookkeeper/owner. Not a protected-settings table |

Result for the five settings tables: **PASS.** Each has only a member-SELECT policy (audit viewers for the change log) plus deny-all write policies. Writes go only through the `SECURITY DEFINER` RPCs, each of which checks a permission.

- Code: `20261022180000_settings_centre_foundation.sql:21-42`, `58-72`, `92-106`, `128-138`, `155-161`.
- Dates: `set_organisation_lock_policy` rejects an empty reason.

### 5.2 Defects

| ID | Sev | Finding | Evidence (file:line) |
|---|---|---|---|
| **S1** | High | **Direct `journals` and `journal_lines` INSERT bypasses `post_journal`.** The INSERT policies check only the permission. They do not check `status = 'draft'`, despite the policy name "Posters can insert draft journals". A user with `accounting.post` or `journals.manual` (bookkeeper, accountant, admin, owner) can insert a journal with `status = 'posted'` through PostgREST and skip the balance check, the period-open check, the account-belongs-to-company and active/postable checks, and the audit event. Live grants give `authenticated` INSERT on both tables. The only guard is the lock-date `BEFORE INSERT` trigger, which checks lock dates only. No deferred constraint or trigger enforces ΣD = ΣC. `prevent_posted_line_mutation` covers UPDATE and DELETE only, so lines can also be inserted into an already-posted journal. | `20261019140000_accounting_engine.sql:224-230` (journals), `:240-244` (lines), `:392-409` (line trigger), `:845-855` (GRANTs). Live: policies and triggers listed above; `journals_lock_dates_trg` is INSERT only |
| **S2** | High | **No cross-company constraint on ledger rows.** `journal_lines.account_id` and `journal_lines.journal_id` are plain FKs. Nothing ties `journal_lines.company_id` to `journals.company_id` or `accounts.company_id`. Combined with S1 and the line policy (which checks only the line's own `company_id`), a user could attach lines to another company's journal or account. My data check (row b) found none today, so this is a missing constraint, not a current breach. `post_journal` enforces it, but the RPC is not the only write path. | `…accounting_engine.sql:192-204`; live `pg_constraint` list (no composite FK) |
| **S3** | High | **`accountant` can reopen a locked period without `periods.unlock`.** The `accounting_periods` UPDATE policy allows `periods.lock` OR `periods.unlock` OR `accounts.manage`, with no column restriction. `accounts.manage` is held by accountant, admin and owner; `periods.unlock` only by admin and owner. An accountant can run `UPDATE accounting_periods SET status='open', locked_at=NULL` directly, with no `audit_events` row, skipping `unlock_accounting_period`. They can also change `start_date` and `end_date`. There is no trigger on the table. | `…accounting_engine.sql:149-161` (policy), `:810-828` (the RPC that is meant to be the only path); live role_permissions and zero triggers on `accounting_periods` |
| **S4** | Medium | **`set_organisation_lock_policy` needs only `periods.lock`.** An accountant can lower or null `lock_date_everyone`, `lock_date_except_advisors` and `conversion_date`, which effectively unlocks closed periods. `periods.unlock` is admin/owner only. A reason is required and a change-log entry is written, but the permission model is inconsistent with S3. | `20261022180000_settings_centre_foundation.sql:380-382` (permission check), `:384-392` |
| **S5** | Medium | **`reverse_journal` is not a lock-date bypass, but it is dated at the original journal's date.** It builds the payload with `'journal_date', j.journal_date` and calls `post_journal`, which runs the period and lock-date checks. So it does not bypass locks. The consequence is the opposite: a journal in a locked period cannot be reversed at all, and in an open period the reversal alters history on the original date instead of the current date. Also, `reverse_journal` and the server function `reversePostedJournal` do not block reversing a document-sourced journal. Reversing a bill or invoice journal directly leaves the document `authorised` and the subledger out of line with the GL. | `…accounting_engine.sql:732-788` (date at ~`:775`); `src/lib/accounting/accounting.functions.ts:190-198`; UI `src/routes/_authenticated/accounting.tsx:146` |
| **S6** | Medium | **Manual journals may post to control accounts.** Accounts 1100, 2000 and 2100 have `is_control = true`, but `post_journal` does not check the flag, and `source_type` and `source_id` are accepted unvalidated. This is how the AP gap in §4 arose. | `…accounting_engine.sql:593-598`, `:664-673`; `accounting.functions.ts:160-186` (`source_type: "manual"`, any account) |
| **S7** | Medium | **Subledger documents are directly writable.** RLS lets `purchases.draft` users UPDATE `purchase_bills` (status, amounts, `posted_journal_id`) with no state-machine trigger. `sales_invoices` is the same for `sales.draft`. `money_documents` allows ALL (including DELETE) for `accounting.post`/`journals.manual`. No check that `posted_journal_id`, `contact_id` or `bank_account_id` belong to the same company. Live: no triggers on `purchase_bills`, `sales_invoices`, `supplier_payments`, `purchase_credit_notes` or the allocation tables. | Live `pg_policies` / `pg_trigger` (§5.1 and rows above) |
| **S8** | Medium | **`seed_fx_accounts(uuid)` and `lookup_fx_rate_to_base(uuid, char, date)` are `SECURITY DEFINER`, executable by `anon`/PUBLIC, and contain no `auth.uid()` or membership check.** An unauthenticated caller who knows a company UUID can insert the four FX accounts (7700-7730) into that company's chart, and can read its latest FX rate or learn whether the company exists from the error text. | Live `pg_get_functiondef`: `seed_fx_accounts` is `INSERT INTO accounts … ON CONFLICT DO NOTHING`; `lookup_fx_rate_to_base` raises "Company not found". Source: `20261019200000_cross_cutting_settings_fx_demo.sql:225-261` and `:266` (new functions get the default PUBLIC execute because no REVOKE is issued) |
| **S9** | Low | **Broad table grants.** `anon` and `authenticated` hold SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER on every public table I checked, including `journals`, `journal_lines`, `organisation_secrets` and `audit_events`. Only RLS stands in the way. The `GRANT SELECT …` lines in the accounting migration give a false impression of least privilege. Supabase default privileges make them redundant. `TRUNCATE` is not subject to RLS. | Live `information_schema.role_table_grants`; `…accounting_engine.sql:845-855` |
| **S10** | Low | **Many `SECURITY DEFINER` functions are executable by `anon`/PUBLIC.** Most self-guard on `auth.uid()` plus a membership or permission check (verified by `pg_get_functiondef` regex: `allocate_document_number`, `record_audit_event`, `reset_demo_company`, `ensure_accounting_period_coverage`, `copy_chart_accounts`, `import_chart_accounts`, `void_exchange_rate`, `record_ai_usage`, `recurring_*`, `seed_country_tax_pack`). They should still be revoked from `anon` (`post_journal` and `reverse_journal` already are). `reset_demo_company` reveals whether a UUID is a demo company through its different error text. `count_ai_usage_last_hour` returns 0 when unauthenticated and is scoped to the caller. | Live `pg_proc` and ACL query |
| **S11** | Medium | **`ensure_accounting_period_coverage` has no permission check, only membership.** Any member, including `read_only` or `staff`, can extend the earliest open period or insert a new open period. The overlap exclusion constraint limits the damage but does not stop period edits. | Live definition; `20261019230000_extended_coa_and_demo_period.sql:90-155` (`GRANT … TO authenticated` at `:155`, but live ACL also includes anon/PUBLIC) |
| **S12** | Low | **`is_company_advisor` does not check `m.status = 'active'`**, unlike `has_company_permission`. A suspended or invited owner/admin/accountant would pass the adviser lock-date exception. Not reachable today because callers also pass `has_company_permission`. | `20261022180000_settings_centre_foundation.sql:165-181` |
| **S13** | Low | **Journal numbering is not concurrency-safe.** `next_journal_number` is `MAX(journal_number)+1` with no lock. Two concurrent posts collide on `UNIQUE (company_id, journal_number)`. The `unique_violation` handler re-selects by idempotency key. A collision between different keys re-raises, so the user sees a spurious failure. This is not corruption. | `…accounting_engine.sql:414-421`, `:718-729`; same in `20261022180000_settings_centre_foundation.sql:690-701` |
| **S14** | Low | **Idempotency returns the existing journal without comparing the payload.** Retrying a key with different lines or amounts silently returns the old journal. The concurrent-duplicate race itself is handled correctly: the loser blocks on the unique index and the handler returns the winner. | `…accounting_engine.sql:608-615`; `20261022180000_settings_centre_foundation.sql:580-586` |
| **S15** | Low | **`linkbooks.trusted` is a session flag that bypasses the immutability triggers, and `post_journal` always sets it to `'off'` on exit.** If `post_journal` is called from a context that set it to `'on'`, the flag is cleared mid-transaction. Nothing observed lets a client set it. | `…accounting_engine.sql:366-408`, `:636`, `:715` |
| **S16** | Low | **`organisation_config` documents are not validated server-side.** The RPC accepts any JSON object for any free-text category ("validated in app"). Admin/owner can write arbitrary documents by calling the RPC directly. | `20261022180000_settings_centre_foundation.sql:227-297` (see `:250-255`) |
| **S17** | Low | **Secrets are stored as a SHA-256 digest.** The `ciphertext` column holds an irreversible hash, so the stored secret can never be used by an integration. That is safe but incomplete, and the column name is misleading. `secret_key` is unvalidated and logged to `settings_change_log`. | `20261022180000_settings_centre_foundation.sql:468`, `:443-491` |

### 5.3 Application-layer integrity defects (`posting-engine.ts` and callers)

| ID | Sev | Finding | Evidence |
|---|---|---|---|
| **A1** | Medium | **`categoriseBankTransaction` is not atomic and does not verify amounts.** It posts the journal, then looks up the bank line with `.maybeSingle()` (errors if more than one line hits the bank account), then inserts the link, then updates the bank txn status. The status update's error is ignored. The caller supplies `amount_minor`; the code never checks it equals the bank transaction's amount. Nothing in the DB enforces that either. | `src/lib/accounting/posting-engine.ts:99-172` (lookup `:146-152`, ignored update `:168-171`) |
| **A2** | Medium | **Supplier-payment void is a multi-step client flow with unchecked writes.** The journal is reversed first. Each bill update and the final `supplier_payments` update are executed without checking `error`. A failure mid-way leaves the GL reversed while the bill stays paid. Allocation rows are never removed, which produced the 12,000 stale allocation on PUR-0002. | `src/lib/purchases/purchases.functions.ts:1760-1825` |
| **A3** | Low | **`postJournal` transports amounts as JSON numbers.** It checks `Number.isSafeInteger`, so there is no precision loss under about 9×10¹⁵ minor units. No issue found. | `posting-engine.ts:49-60` |

---

## 6. Recommended fixes (priority order)

None of these edits a posted journal. Every correction is a new reversing or adjusting journal posted through `post_journal`.

1. **Close the direct-write paths (S1, S2, S3).**
   - Safe approach: new migration.
     - Drop the INSERT policies on `journals` and `journal_lines` (all posting goes through `post_journal`), or change them to `WITH CHECK (status = 'draft')` for journals and "journal is a draft" for lines.
     - Add a `DEFERRABLE INITIALLY DEFERRED` constraint trigger enforcing ΣD = ΣC per posted journal.
     - Add composite FKs `(journal_id, company_id)` and `(account_id, company_id)`.
     - Add a trigger blocking INSERT on lines of a posted journal.
   - Replace the UPDATE policy on `accounting_periods` with RPC-only changes: `lock_accounting_period` and `unlock_accounting_period`.
2. **Revoke `anon` and PUBLIC execute from all `SECURITY DEFINER` functions (S8, S10).**
   - Add `auth.uid()` plus membership checks to `seed_fx_accounts` and `lookup_fx_rate_to_base`.
   - Add a permission check to `ensure_accounting_period_coverage` (S11).
   - Revoke TRUNCATE, REFERENCES and TRIGGER from `anon` and `authenticated` on all tables, and DELETE where policies do not allow it (S9).
3. **Stop manual postings to control accounts (S6).**
   - In `post_journal`, reject lines on `accounts.is_control` unless `source_type` matches the account's subledger. Allow manual only with an explicit permission such as `journals.control_override` plus a mandatory memo, written to the audit log.
4. **Fix the AP gap without touching posted journals (§4).** Demo only.
   - Option A: post a reversing journal for #11 with `reverse_journal`. Then, if the 75,000 cost is intended, post a real purchase bill for it through the bill authorise flow.
   - Option B: run `reset_demo_company` and re-seed with the fixed seed. This is allowed because `is_demo = true`.
   - Fix the seed:
     - Replace `demo:cos-ap` with a real bill.
     - Extend `linkDemoDocumentsToJournals` to link PCN-1 and SPAY-2001.
     - Derive bill status from the balance instead of hard-coding `authorised` for BILL-2002.
     - Seed BILL-2003 as draft or post it properly.
     - Align the document dates with the journal dates.
5. **Make subledger transitions server-side and atomic (S7, A1, A2).**
   - Move payment, credit and void flows into RPCs that run in one transaction: journal, allocation, bill update and audit.
   - Remove the direct UPDATE of `status`, `amount_*` and `posted_journal_id` from client roles. Use state-machine triggers.
   - On void, delete or flag the allocation rows.
   - `categoriseBankTransaction` should be a single RPC that reads the bank transaction amount from the DB and rejects mismatches.
6. **Align lock permissions (S4, S5, S12).**
   - Require `periods.unlock` to lower or remove a lock date in `set_organisation_lock_policy`.
   - Let `reverse_journal` accept a reversal date (default: today if the original period is locked) and reject reversing journals with `source_type` other than `manual` unless called from the owning document flow.
   - Check `m.status = 'active'` in `is_company_advisor`.
7. **Reconciliation integrity (g1, i).**
   - Seed no matched or reconciled bank transaction without a link.
   - Add a trigger or constraint: status `matched` or `reconciled` requires a `reconciliation_links` row.
   - Make `reconciliation_links` company-consistent: the line's journal, the bank txn and the link must share `company_id`.
8. **Hardening (S13, S14, S15, S16, S17).**
   - Use a per-company advisory lock or a counter table for journal numbers.
   - Store a payload hash with the idempotency key and error on mismatch.
   - Restore the previous `linkbooks.trusted` value instead of forcing `off`.
   - Validate settings JSON in the RPC.
   - Use a real vault or KMS for secrets.
9. **Add DB-level tests.**
   - Add integration tests (pgTAP or a Supabase test DB) that cover: GL = subledger for AR/AP/bank/tax; every non-draft document has `posted_journal_id`; no journal on a control account without a document; no matched txn without a link. The current 236 unit tests mock the DB and cannot catch the failures in §3.

---

## 7. Limitations

- I did not exercise RLS by impersonating roles. The RLS and grant conclusions come from `pg_policies`, `pg_proc` and `information_schema`, so S1, S3 and S8 are "allowed by policy/grant" findings, not executed exploits. No write was attempted, per the rules.
- I tested only the two demo companies. The live DB holds no non-demo companies.
- I did not review report-computation code (trial balance, P&L, balance sheet UI) or multi-currency translation.
- I did not run `tsc`, the build or e2e tests.

---

## 8. Resolution log (23 Oct 2026, applied by the CTO programme owner)

Applied live and in the repo (migration `20261023170000_ledger_write_path_hardening.sql`):

| Item | Action | Evidence |
|---|---|---|
| f / AP gap | Posted reclass journal (DR 2000 / CR 2200, 75,000) through `post_journal` on both demos; seed spec `demo:cos-ap` now credits Accruals (2200) | AP GL = open bills on both demos (0 = 0; 1,000 = 1,000); TB net 0; AR 480,000 = 480,000 |
| f2 | PCN-1 and SPAY-2001 linked to journals (live + `linkDemoDocumentsToJournals`) | 0 unlinked non-draft payments/credit notes |
| f3 | BILL-2002 (fully credited) now `paid` (live + seed) | — |
| h | BILL-2003 seeded as `draft` (code matches DB) | — |
| S1/S2 | Direct INSERT on `journals` must be `draft`; lines must belong to a draft journal and accounts of the same company | policies replaced |
| S3 | UPDATE policy on `accounting_periods` dropped; lock/unlock only through audited RPCs | policy removed |
| S4 | Moving a lock date earlier requires `periods.unlock` | RPC replaced |
| S6 | Trigger blocks `manual` journal lines on control accounts | trigger added |
| S8/S10/S11 | `seed_fx_accounts` revoked from all client roles; `lookup_fx_rate_to_base` needs membership; `anon`/PUBLIC revoked on `ensure_accounting_period_coverage` | ACLs |
| S12 | `is_company_advisor` requires active membership | function replaced |

Not yet done (tracked in `docs/plans/NEXT_ACTIONS.md`): balance trigger / composite FKs (S2 full), S5 reverse_journal reversal date, S7 subledger state machines, S9 table grants, S13–S17, A1/A2 atomic RPCs, g1/i bank `reconciliation_links` seeding, stale allocation on voided payment 12345, doc/journal date alignment (j), pgTAP DB tests. RLS was not exercised by role impersonation after the change.
