-- Reports Centre: demote unposted volume shells, saved views, audit details alias safety.
-- Additive. Does not wipe journals or balances.

-- Volume demo INV-V / BILL-V shells were marked authorised without posted_journal_id,
-- which inflated AR/AP ageing vs control accounts. Demote those shells to draft.
UPDATE public.sales_invoices
SET status = 'draft',
    authorised_at = NULL,
    authorised_by = NULL,
    updated_at = now()
WHERE invoice_number LIKE 'INV-V%'
  AND posted_journal_id IS NULL
  AND status IN ('authorised', 'partly_paid');

UPDATE public.purchase_bills
SET status = 'draft',
    updated_at = now()
WHERE bill_number LIKE 'BILL-V%'
  AND posted_journal_id IS NULL
  AND status IN ('authorised', 'partly_paid');

-- Saved report configurations (filters/columns — not financial snapshots)
CREATE TABLE IF NOT EXISTS public.report_saved_views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  report_id TEXT NOT NULL,
  name TEXT NOT NULL,
  is_favourite BOOLEAN NOT NULL DEFAULT false,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT report_saved_views_name_nonempty CHECK (length(trim(name)) > 0)
);

CREATE INDEX IF NOT EXISTS report_saved_views_company_user_idx
  ON public.report_saved_views (company_id, user_id, report_id);

ALTER TABLE public.report_saved_views ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members manage own report views" ON public.report_saved_views;
CREATE POLICY "Members manage own report views"
  ON public.report_saved_views FOR ALL TO authenticated
  USING (
    public.is_company_member(company_id)
    AND user_id = auth.uid()
  )
  WITH CHECK (
    public.is_company_member(company_id)
    AND user_id = auth.uid()
  );

-- audit_events.payload does not exist — application reads `details` (canonical).
