-- Recurring Transactions V2 — Stages 2–8 (schema extensions)

ALTER TYPE public.recurring_document_type ADD VALUE IF NOT EXISTS 'purchase_credit_note';
ALTER TYPE public.recurring_document_type ADD VALUE IF NOT EXISTS 'sales_credit_note';
ALTER TYPE public.recurring_document_type ADD VALUE IF NOT EXISTS 'purchase_expense';
ALTER TYPE public.recurring_document_type ADD VALUE IF NOT EXISTS 'sales_receipt';
ALTER TYPE public.recurring_document_type ADD VALUE IF NOT EXISTS 'manual_journal';
ALTER TYPE public.recurring_document_type ADD VALUE IF NOT EXISTS 'bank_transfer';

INSERT INTO public.role_permissions (role, permission) VALUES
  ('owner', 'recurring.auto_authorise'),
  ('admin', 'recurring.auto_authorise'),
  ('accountant', 'recurring.auto_authorise')
ON CONFLICT (role, permission) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.recurring_schedule_exceptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  schedule_id UUID NOT NULL REFERENCES public.recurring_schedules(id) ON DELETE CASCADE,
  exception_date DATE NOT NULL,
  exception_type TEXT NOT NULL CHECK (exception_type IN ('skip', 'shift')),
  shifted_to_date DATE,
  note TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (schedule_id, exception_date)
);

CREATE INDEX IF NOT EXISTS recurring_schedule_exceptions_company_idx
  ON public.recurring_schedule_exceptions (company_id, exception_date);

ALTER TABLE public.recurring_schedule_exceptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS recurring_schedule_exceptions_rw ON public.recurring_schedule_exceptions;
CREATE POLICY recurring_schedule_exceptions_rw ON public.recurring_schedule_exceptions FOR ALL TO authenticated
  USING (
    public.has_company_permission(company_id, 'purchases.draft')
    OR public.has_company_permission(company_id, 'sales.draft')
  )
  WITH CHECK (
    public.has_company_permission(company_id, 'purchases.draft')
    OR public.has_company_permission(company_id, 'sales.draft')
  );

CREATE INDEX IF NOT EXISTS recurring_occurrences_status_idx
  ON public.recurring_occurrences (company_id, status, scheduled_date DESC);

CREATE INDEX IF NOT EXISTS recurring_templates_company_type_idx
  ON public.recurring_templates (company_id, document_type);
