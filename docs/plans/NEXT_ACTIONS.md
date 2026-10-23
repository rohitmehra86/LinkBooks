# Exact next executable steps

## After wave 2 (23 Oct 2026)
1. Apply the new look to the bills list and the document create/edit forms (UI wave leftovers).
2. Install schedulers: auto-reversals (`process_due_auto_reversals_system`), recurring journals (`process_all_due_recurring_journals`), reminders. Make recurring invoice/bill generators callable by the service role.
3. Server-side PDF and PDF attachment in emails; supplier statements; online payment provider (only when real).
4. Bank feeds provider, e-filing of tax returns, reverse-charge on credit notes and bank-coded spend.
5. Tracking categories and per-line project tags; budget summary on the dashboard.
6. Add pgTAP / saved SQL scenario tests for the RPCs (currently verified by hand under RLS).
7. Older items below that are still open: deferred balance trigger, composite FKs, S5, S7, S9/S10, demo date alignment, RLS impersonation tests.

---

## Earlier plan (kept for reference)

1. **M2 — Flyover foundation**
   - Extend reusable Create flyover shell (focus trap, unsaved guard, nested Add New) already partially in `create-new/`.
   - Unblock `manual_journal` Create action only after signed-in post verified against Accounting page parity.
2. **M1 follow-up**
   - Re-verify AP open vs AP GL on both demos after bill links.
   - Add Vitest asserting seed link helper maps keys → tables.
3. **M4/M5**
   - Sales refund + supplier refund (currently Create-blocked).
   - Upgrade invoice/quote forms toward New Bill parity (fields, supplier/customer summary).
4. **Push / PR**
   - Push `cto-master-programme` and open PR to `main` when M2 slice is green.
5. **Do not** mark portals/feeds/AI execute as live.

## Added 23 Oct 2026 — from independent review (docs/audit/SONNET_INDEPENDENT_REVIEW.md)
- [ ] Deferred constraint trigger: posted journal ΣD = ΣC; composite FKs `(journal_id, company_id)`, `(account_id, company_id)`; block line inserts into posted journals (S2).
- [ ] `reverse_journal`: accept reversal date (today when original period locked); block reversing document-sourced journals outside document flow (S5).
- [ ] Subledger state machines + atomic RPCs for payment/credit/void/categorise (S7, A1, A2); clear allocation on void.
- [ ] Revoke TRUNCATE/REFERENCES/TRIGGER from client roles; revoke `anon` on remaining SECURITY DEFINER functions (S9, S10).
- [ ] Bank: demo `matched`/`reconciled` txns need `reconciliation_links` or must be seeded as unmatched (g1, i).
- [ ] Align demo document dates with journal dates (j); fix stale allocation on voided supplier payment 12345.
- [ ] Add DB-level tests (pgTAP) for GL = subledger, no unlinked non-draft docs, no manual control-account journals.
- [ ] Role-impersonation RLS tests for the policies changed in migration 20261023170000.
