-- Money documents: void support and credit consumption tracking.
-- A refund consumes customer/supplier credit (credit note remaining or receipt
-- unallocated balance). Recording the consumption lets a void restore it exactly.

ALTER TABLE public.money_documents
  ADD COLUMN IF NOT EXISTS void_journal_id UUID REFERENCES public.journals(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS void_reason TEXT;

CREATE TABLE IF NOT EXISTS public.money_document_credit_uses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES public.money_documents(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('sales_credit_note', 'purchase_credit_note', 'sales_receipt')),
  source_id UUID NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS money_document_credit_uses_doc
  ON public.money_document_credit_uses (document_id);

ALTER TABLE public.money_document_credit_uses ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS money_document_credit_uses_select ON public.money_document_credit_uses;
CREATE POLICY money_document_credit_uses_select ON public.money_document_credit_uses
  FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

DROP POLICY IF EXISTS money_document_credit_uses_write ON public.money_document_credit_uses;
CREATE POLICY money_document_credit_uses_write ON public.money_document_credit_uses
  FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'accounting.post'))
  WITH CHECK (public.has_company_permission(company_id, 'accounting.post'));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.money_document_credit_uses TO authenticated;
