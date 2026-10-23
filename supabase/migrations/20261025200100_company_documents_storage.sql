-- Wave 2-F: company documents (attachments) on private Storage.
-- Extends the existing public.document_attachments table (bill attachments store content inline
-- as base64 in the row; those rows keep working). New files go to the private
-- `company-documents` bucket under {company_id}/{entity_type}/{entity_id}/{uuid}-{file name}.
-- Access is by company membership AND the permission that owns the entity type.
-- Additive and idempotent.

-- ---------------------------------------------------------------------------
-- Permission helper shared by the table policies, the Storage policies and the e-mail log RPC.
-- _action: 'view' | 'manage'
-- ---------------------------------------------------------------------------
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
      WHEN _entity_type IN ('sales_invoice', 'sales_quote', 'sales_credit_note', 'sales_receipt')
        THEN public.has_company_permission(_company_id, 'sales.view')
      WHEN _entity_type IN ('purchase_bill', 'purchase_order', 'purchase_credit_note',
                            'recurring_bill', 'inbox_document')
        THEN public.has_company_permission(_company_id, 'purchases.view')
      WHEN _entity_type = 'journal'
        THEN public.has_company_permission(_company_id, 'accounting.view')
      WHEN _entity_type IN ('contact', 'company') THEN true
      ELSE false
    END;
  ELSIF _action = 'manage' THEN
    RETURN CASE
      WHEN _entity_type IN ('sales_invoice', 'sales_quote', 'sales_credit_note', 'sales_receipt')
        THEN public.has_company_permission(_company_id, 'sales.draft')
      WHEN _entity_type IN ('purchase_bill', 'purchase_order', 'purchase_credit_note',
                            'recurring_bill', 'inbox_document')
        THEN public.has_company_permission(_company_id, 'purchases.draft')
      WHEN _entity_type = 'contact'
        THEN public.has_company_permission(_company_id, 'contacts.manage')
      WHEN _entity_type = 'journal'
        THEN public.has_company_permission(_company_id, 'accounting.post')
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

-- Storage object name -> permission check. Malformed names are denied, never an error.
CREATE OR REPLACE FUNCTION public.can_access_storage_document(_name TEXT, _action TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _parts TEXT[] := string_to_array(_name, '/');
BEGIN
  IF array_length(_parts, 1) IS DISTINCT FROM 4 THEN RETURN false; END IF;
  IF _parts[1] !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
    RETURN false;
  END IF;
  RETURN public.can_access_attachment(_parts[1]::UUID, _parts[2], _action);
END;
$$;

REVOKE ALL ON FUNCTION public.can_access_storage_document(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_access_storage_document(TEXT, TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- document_attachments: bucket column, listing index, tighter RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.document_attachments
  ADD COLUMN IF NOT EXISTS storage_bucket TEXT;

CREATE INDEX IF NOT EXISTS document_attachments_company_created_idx
  ON public.document_attachments (company_id, created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'document_attachments_storage_scope'
      AND conrelid = 'public.document_attachments'::regclass
  ) THEN
    ALTER TABLE public.document_attachments
      ADD CONSTRAINT document_attachments_storage_scope CHECK (
        storage_bucket IS NULL
        OR (
          storage_bucket = 'company-documents'
          AND storage_path LIKE company_id::text || '/' || entity_type || '/' || entity_id::text || '/%'
        )
      );
  END IF;
END $$;

-- Insert guard for Storage-backed rows: the entity must exist in this company and the uploader
-- is always the signed-in user.
CREATE OR REPLACE FUNCTION public.document_attachments_before_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _table TEXT;
  _ok BOOLEAN;
BEGIN
  IF auth.uid() IS NOT NULL THEN NEW.uploaded_by := auth.uid(); END IF;
  IF NEW.storage_bucket IS NULL THEN RETURN NEW; END IF;

  IF NEW.entity_type = 'company' THEN
    IF NEW.entity_id <> NEW.company_id THEN
      RAISE EXCEPTION 'Unfiled documents belong to the organisation itself';
    END IF;
    RETURN NEW;
  END IF;

  _table := CASE NEW.entity_type
    WHEN 'sales_invoice' THEN 'sales_invoices'
    WHEN 'sales_quote' THEN 'sales_quotes'
    WHEN 'sales_credit_note' THEN 'sales_credit_notes'
    WHEN 'sales_receipt' THEN 'sales_receipts'
    WHEN 'purchase_bill' THEN 'purchase_bills'
    WHEN 'purchase_order' THEN 'purchase_orders'
    WHEN 'purchase_credit_note' THEN 'purchase_credit_notes'
    WHEN 'contact' THEN 'contacts'
    WHEN 'journal' THEN 'journals'
    ELSE NULL
  END;
  IF _table IS NULL THEN
    RAISE EXCEPTION 'Unsupported attachment target: %', NEW.entity_type;
  END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE id = $1 AND company_id = $2)', _table)
    INTO _ok USING NEW.entity_id, NEW.company_id;
  IF NOT _ok THEN
    RAISE EXCEPTION 'The record to attach to was not found in this organisation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS document_attachments_before_insert_trg ON public.document_attachments;
CREATE TRIGGER document_attachments_before_insert_trg
  BEFORE INSERT ON public.document_attachments
  FOR EACH ROW EXECUTE FUNCTION public.document_attachments_before_insert();

DROP POLICY IF EXISTS document_attachments_select ON public.document_attachments;
DROP POLICY IF EXISTS document_attachments_write ON public.document_attachments;
DROP POLICY IF EXISTS document_attachments_view ON public.document_attachments;
DROP POLICY IF EXISTS document_attachments_insert ON public.document_attachments;
DROP POLICY IF EXISTS document_attachments_update ON public.document_attachments;
DROP POLICY IF EXISTS document_attachments_delete ON public.document_attachments;

CREATE POLICY document_attachments_view ON public.document_attachments FOR SELECT TO authenticated
  USING (public.can_access_attachment(company_id, entity_type, 'view'));
CREATE POLICY document_attachments_insert ON public.document_attachments FOR INSERT TO authenticated
  WITH CHECK (public.can_access_attachment(company_id, entity_type, 'manage'));
CREATE POLICY document_attachments_update ON public.document_attachments FOR UPDATE TO authenticated
  USING (public.can_access_attachment(company_id, entity_type, 'manage'))
  WITH CHECK (public.can_access_attachment(company_id, entity_type, 'manage'));
CREATE POLICY document_attachments_delete ON public.document_attachments FOR DELETE TO authenticated
  USING (public.can_access_attachment(company_id, entity_type, 'manage'));

REVOKE ALL ON public.document_attachments FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_attachments TO authenticated;

-- ---------------------------------------------------------------------------
-- Private bucket + object policies. Update is not offered: replace = delete + upload.
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'company-documents',
  'company-documents',
  false,
  20971520,
  ARRAY[
    'application/pdf',
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic', 'image/heif',
    'text/csv', 'text/plain',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS company_documents_select ON storage.objects;
CREATE POLICY company_documents_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'company-documents' AND public.can_access_storage_document(name, 'view'));

DROP POLICY IF EXISTS company_documents_insert ON storage.objects;
CREATE POLICY company_documents_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'company-documents' AND public.can_access_storage_document(name, 'manage'));

DROP POLICY IF EXISTS company_documents_delete ON storage.objects;
CREATE POLICY company_documents_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'company-documents' AND public.can_access_storage_document(name, 'manage'));
