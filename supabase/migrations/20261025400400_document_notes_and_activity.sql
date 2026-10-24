-- Internal notes and activity for every document type that can hold files.
-- Bills keep bill_internal_notes. Every other record uses document_internal_notes.
-- can_access_attachment is the same permission map as ATTACHMENT_ENTITIES.
-- Activity is read through list_document_activity so a user who can open the
-- record can see its history without audit.view on the whole organisation.
-- Additive. Does not change posting, validation, or printed documents.

CREATE OR REPLACE FUNCTION public.can_access_attachment(
  _company_id UUID,
  _entity_type TEXT,
  _action TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR _company_id IS NULL THEN RETURN false; END IF;
  IF NOT public.is_company_member(_company_id) THEN RETURN false; END IF;

  IF _action = 'view' THEN
    RETURN CASE
      WHEN _entity_type IN ('sales_invoice', 'sales_quote', 'sales_credit_note', 'sales_receipt',
                            'money_sales_receipt', 'money_customer_refund')
        THEN public.has_company_permission(_company_id, 'sales.view')
      WHEN _entity_type IN ('purchase_bill', 'purchase_order', 'purchase_credit_note',
                            'purchase_expense', 'recurring_bill', 'inbox_document',
                            'money_supplier_refund')
        THEN public.has_company_permission(_company_id, 'purchases.view')
      WHEN _entity_type IN ('journal', 'recurring_journal')
        THEN public.has_company_permission(_company_id, 'accounting.view')
      WHEN _entity_type = 'project' THEN (
        public.has_company_permission(_company_id, 'accounting.view')
        OR public.has_company_permission(_company_id, 'accounts.manage')
      )
      WHEN _entity_type IN ('money_receive', 'money_deposit', 'money_card_payment',
                            'money_adjustment', 'bank_transfer')
        THEN public.has_company_permission(_company_id, 'banking.view')
      WHEN _entity_type = 'product' THEN (
        public.has_company_permission(_company_id, 'products.manage')
        OR public.has_company_permission(_company_id, 'sales.view')
        OR public.has_company_permission(_company_id, 'purchases.view')
      )
      WHEN _entity_type IN ('contact', 'company') THEN true
      ELSE false
    END;
  ELSIF _action = 'manage' THEN
    RETURN CASE
      WHEN _entity_type IN ('sales_invoice', 'sales_quote', 'sales_credit_note', 'sales_receipt')
        THEN public.has_company_permission(_company_id, 'sales.draft')
      WHEN _entity_type IN ('money_sales_receipt', 'money_customer_refund')
        THEN public.has_company_permission(_company_id, 'sales.payment')
      WHEN _entity_type IN ('purchase_bill', 'purchase_order', 'purchase_credit_note',
                            'purchase_expense', 'recurring_bill', 'inbox_document')
        THEN public.has_company_permission(_company_id, 'purchases.draft')
      WHEN _entity_type = 'money_supplier_refund'
        THEN public.has_company_permission(_company_id, 'purchases.payment')
      WHEN _entity_type = 'contact'
        THEN public.has_company_permission(_company_id, 'contacts.manage')
      WHEN _entity_type = 'journal'
        THEN public.has_company_permission(_company_id, 'accounting.post')
      WHEN _entity_type = 'recurring_journal'
        THEN public.has_company_permission(_company_id, 'journals.manual')
      WHEN _entity_type = 'project'
        THEN public.has_company_permission(_company_id, 'accounts.manage')
      WHEN _entity_type = 'product'
        THEN public.has_company_permission(_company_id, 'products.manage')
      WHEN _entity_type IN ('money_receive', 'money_deposit', 'money_card_payment',
                            'money_adjustment', 'bank_transfer')
        THEN public.has_company_permission(_company_id, 'banking.categorise')
      WHEN _entity_type = 'company' THEN (
        public.has_company_permission(_company_id, 'sales.draft')
        OR public.has_company_permission(_company_id, 'purchases.draft')
        OR public.has_company_permission(_company_id, 'accounting.post')
      )
      ELSE false
    END;
  END IF;
  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.can_access_attachment(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_access_attachment(UUID, TEXT, TEXT) TO authenticated;

-- True only when the row exists in this organisation. Money documents must match kind.
CREATE OR REPLACE FUNCTION public.document_entity_exists(
  _company_id UUID,
  _entity_type TEXT,
  _entity_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _table TEXT;
  _kind TEXT;
  _ok BOOLEAN;
BEGIN
  IF _company_id IS NULL OR _entity_id IS NULL OR _entity_type IS NULL THEN
    RETURN false;
  END IF;
  IF _entity_type = 'company' THEN
    RETURN _entity_id = _company_id;
  END IF;

  _table := CASE _entity_type
    WHEN 'sales_invoice' THEN 'sales_invoices'
    WHEN 'sales_quote' THEN 'sales_quotes'
    WHEN 'sales_credit_note' THEN 'sales_credit_notes'
    WHEN 'sales_receipt' THEN 'sales_receipts'
    WHEN 'purchase_bill' THEN 'purchase_bills'
    WHEN 'purchase_order' THEN 'purchase_orders'
    WHEN 'purchase_credit_note' THEN 'purchase_credit_notes'
    WHEN 'purchase_expense' THEN 'purchase_expenses'
    WHEN 'recurring_bill' THEN 'recurring_bills'
    WHEN 'inbox_document' THEN 'inbox_documents'
    WHEN 'contact' THEN 'contacts'
    WHEN 'journal' THEN 'journals'
    WHEN 'recurring_journal' THEN 'recurring_journal_templates'
    WHEN 'product' THEN 'products'
    WHEN 'project' THEN 'projects'
    WHEN 'bank_transfer' THEN 'bank_transfers'
    WHEN 'money_sales_receipt' THEN 'money_documents'
    WHEN 'money_customer_refund' THEN 'money_documents'
    WHEN 'money_supplier_refund' THEN 'money_documents'
    WHEN 'money_receive' THEN 'money_documents'
    WHEN 'money_deposit' THEN 'money_documents'
    WHEN 'money_card_payment' THEN 'money_documents'
    WHEN 'money_adjustment' THEN 'money_documents'
    ELSE NULL
  END;
  IF _table IS NULL THEN
    RETURN false;
  END IF;

  IF _table = 'money_documents' THEN
    _kind := CASE _entity_type
      WHEN 'money_sales_receipt' THEN 'sales_receipt'
      WHEN 'money_customer_refund' THEN 'customer_refund'
      WHEN 'money_supplier_refund' THEN 'supplier_refund'
      WHEN 'money_receive' THEN 'receive_money'
      WHEN 'money_deposit' THEN 'bank_deposit'
      WHEN 'money_card_payment' THEN 'card_payment'
      WHEN 'money_adjustment' THEN 'bank_adjustment'
      ELSE NULL
    END;
    SELECT EXISTS (
      SELECT 1 FROM public.money_documents
      WHERE id = _entity_id AND company_id = _company_id AND kind = _kind
    ) INTO _ok;
    RETURN COALESCE(_ok, false);
  END IF;

  EXECUTE format(
    'SELECT EXISTS (SELECT 1 FROM public.%I WHERE id = $1 AND company_id = $2)',
    _table
  ) INTO _ok USING _entity_id, _company_id;
  RETURN COALESCE(_ok, false);
END;
$$;

REVOKE ALL ON FUNCTION public.document_entity_exists(UUID, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.document_entity_exists(UUID, TEXT, UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.document_attachments_before_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NOT NULL THEN NEW.uploaded_by := auth.uid(); END IF;
  IF NEW.storage_bucket IS NULL THEN RETURN NEW; END IF;

  IF NEW.entity_type = 'company' THEN
    IF NEW.entity_id <> NEW.company_id THEN
      RAISE EXCEPTION 'Unfiled documents belong to the organisation itself';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT public.document_entity_exists(NEW.company_id, NEW.entity_type, NEW.entity_id) THEN
    RAISE EXCEPTION 'The record to attach to was not found in this organisation';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Append-only internal notes. Not included on printed or emailed documents.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.document_internal_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  body TEXT NOT NULL,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT document_internal_notes_body_len CHECK (char_length(btrim(body)) BETWEEN 1 AND 4000)
);

CREATE INDEX IF NOT EXISTS document_internal_notes_entity_idx
  ON public.document_internal_notes (company_id, entity_type, entity_id, created_at DESC);

ALTER TABLE public.document_internal_notes ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.document_internal_notes_before_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in to add a note';
  END IF;
  NEW.created_by := auth.uid();
  NEW.body := btrim(NEW.body);
  IF char_length(NEW.body) < 1 OR char_length(NEW.body) > 4000 THEN
    RAISE EXCEPTION 'Notes are limited to 4000 characters';
  END IF;
  IF NOT public.document_entity_exists(NEW.company_id, NEW.entity_type, NEW.entity_id) THEN
    RAISE EXCEPTION 'The record was not found in this organisation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS document_internal_notes_before_insert_trg ON public.document_internal_notes;
CREATE TRIGGER document_internal_notes_before_insert_trg
  BEFORE INSERT ON public.document_internal_notes
  FOR EACH ROW EXECUTE FUNCTION public.document_internal_notes_before_insert();

DROP POLICY IF EXISTS document_internal_notes_view ON public.document_internal_notes;
DROP POLICY IF EXISTS document_internal_notes_insert ON public.document_internal_notes;
CREATE POLICY document_internal_notes_view ON public.document_internal_notes
  FOR SELECT TO authenticated
  USING (public.can_access_attachment(company_id, entity_type, 'view'));
CREATE POLICY document_internal_notes_insert ON public.document_internal_notes
  FOR INSERT TO authenticated
  WITH CHECK (public.can_access_attachment(company_id, entity_type, 'manage'));

REVOKE ALL ON public.document_internal_notes FROM anon;
GRANT SELECT, INSERT ON public.document_internal_notes TO authenticated;

-- History of one record, for someone who can view that record.
CREATE OR REPLACE FUNCTION public.list_document_activity(
  _company_id UUID,
  _entity_type TEXT,
  _entity_id UUID
)
RETURNS TABLE (
  id UUID,
  action TEXT,
  created_at TIMESTAMPTZ,
  actor_user_id UUID,
  actor_name TEXT,
  details JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.can_access_attachment(_company_id, _entity_type, 'view') THEN
    RAISE EXCEPTION 'You do not have permission to view this activity';
  END IF;
  RETURN QUERY
  SELECT
    e.id,
    e.action,
    e.created_at,
    e.actor_user_id,
    COALESCE(NULLIF(btrim(p.full_name), ''), NULLIF(btrim(p.email), ''), '') AS actor_name,
    e.details
  FROM public.audit_events e
  LEFT JOIN public.profiles p ON p.id = e.actor_user_id
  WHERE e.company_id = _company_id
    AND e.entity_type = _entity_type
    AND e.entity_id = _entity_id
  ORDER BY e.created_at DESC
  LIMIT 100;
END;
$$;

REVOKE ALL ON FUNCTION public.list_document_activity(UUID, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_document_activity(UUID, TEXT, UUID) TO authenticated;
