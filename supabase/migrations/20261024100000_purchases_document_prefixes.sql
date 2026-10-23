-- Workstream A (P-12): purchase documents must not share one number prefix.
-- The generic allocator used UPPER(LEFT(document_type, 3)) || '-', so purchase_bill,
-- purchase_order and purchase_credit_note all produced "PUR-0001". New sequences now
-- get a distinct prefix; existing sequences keep issuing from their counter but with the
-- distinct prefix going forward. Already-issued numbers are never rewritten.

CREATE OR REPLACE FUNCTION public.allocate_document_number(_company_id UUID, _document_type TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _prefix TEXT;
  _next INTEGER;
  _pad INTEGER;
  _default_prefix TEXT;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'Not a member of this company';
  END IF;

  _default_prefix := CASE _document_type
    WHEN 'purchase_bill' THEN 'BILL-'
    WHEN 'purchase_order' THEN 'PO-'
    WHEN 'purchase_credit_note' THEN 'SCN-'
    ELSE UPPER(LEFT(_document_type, 3)) || '-'
  END;

  INSERT INTO public.document_sequences (company_id, document_type, prefix, next_number, padding)
  VALUES (_company_id, _document_type, _default_prefix, 1, 4)
  ON CONFLICT (company_id, document_type) DO NOTHING;

  UPDATE public.document_sequences
  SET next_number = next_number + 1
  WHERE company_id = _company_id AND document_type = _document_type
  RETURNING prefix, next_number - 1, padding INTO _prefix, _next, _pad;

  IF _next IS NULL THEN RAISE EXCEPTION 'Could not allocate document number'; END IF;
  RETURN _prefix || lpad(_next::TEXT, _pad, '0');
END;
$$;

REVOKE ALL ON FUNCTION public.allocate_document_number(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.allocate_document_number(UUID, TEXT) TO authenticated;

-- Existing sequences still on the shared default prefix: give purchase orders and credit
-- notes their own prefix from now on (bills keep PUR- so their numbering is unchanged).
UPDATE public.document_sequences
SET prefix = 'PO-'
WHERE document_type = 'purchase_order' AND prefix = 'PUR-';

UPDATE public.document_sequences
SET prefix = 'SCN-'
WHERE document_type = 'purchase_credit_note' AND prefix = 'PUR-';
