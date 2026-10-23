-- BK-05: one-off clean-up of Demo bank lines seeded as 'matched' / 'reconciled'
-- with no journal and no reconciliation link (they cannot be real).
--
-- NOT APPLIED. Review, then run manually in the Supabase SQL editor.
-- Safe to re-run. Touches only Demo companies (is_demo guard on a destructive clean-up)
-- and only lines that have no reconciliation_links row.
--
-- After this, the Demo lines show under "For review" and can be coded, matched and
-- reconciled through the normal engine.

BEGIN;

-- 1. Preview (read-only)
SELECT c.name, bt.status, count(*) AS lines
FROM public.bank_transactions bt
JOIN public.companies c ON c.id = bt.company_id
WHERE c.is_demo
  AND bt.status IN ('matched', 'reconciled')
  AND NOT EXISTS (
    SELECT 1 FROM public.reconciliation_links rl WHERE rl.bank_transaction_id = bt.id
  )
GROUP BY c.name, bt.status;

-- 2. Reset the orphan lines
UPDATE public.bank_transactions bt
SET status = 'uncategorised'
FROM public.companies c
WHERE c.id = bt.company_id
  AND c.is_demo
  AND bt.status IN ('matched', 'reconciled')
  AND NOT EXISTS (
    SELECT 1 FROM public.reconciliation_links rl WHERE rl.bank_transaction_id = bt.id
  );

-- 3. Integrity check: anything non-uncategorised, non-excluded, and unlinked (all companies).
--    Expect 0 rows for Demo after step 2. Real companies are listed for review only.
SELECT bt.company_id, bt.status, count(*) AS unlinked_lines
FROM public.bank_transactions bt
WHERE bt.status IN ('matched', 'reconciled')
  AND NOT EXISTS (
    SELECT 1 FROM public.reconciliation_links rl WHERE rl.bank_transaction_id = bt.id
  )
GROUP BY bt.company_id, bt.status;

COMMIT;
