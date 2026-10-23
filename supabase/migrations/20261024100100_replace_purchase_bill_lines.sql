-- Workstream A (P-08): replace all lines of a draft bill in ONE transaction.
-- Previously the app deleted the lines then inserted new ones in separate requests, so a
-- failed insert could leave a bill with no lines. The app calls this RPC when installed and
-- falls back to a checked delete/insert with restore when it is not.

CREATE OR REPLACE FUNCTION public.replace_purchase_bill_lines(
  _company_id UUID,
  _bill_id UUID,
  _lines JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _status TEXT;
  _count INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF NOT public.has_company_permission(_company_id, 'purchases.draft') THEN
    RAISE EXCEPTION 'You do not have permission to edit bills';
  END IF;
  IF _lines IS NULL OR jsonb_typeof(_lines) <> 'array' OR jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'A bill needs at least one line';
  END IF;

  SELECT status::TEXT INTO _status
  FROM public.purchase_bills
  WHERE id = _bill_id AND company_id = _company_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bill not found'; END IF;
  IF _status NOT IN ('draft', 'awaiting_approval') THEN
    RAISE EXCEPTION 'Only draft bills can have their lines replaced';
  END IF;

  DELETE FROM public.purchase_bill_lines
  WHERE bill_id = _bill_id AND company_id = _company_id;

  INSERT INTO public.purchase_bill_lines (
    company_id, bill_id, line_no, description, account_id, product_id, tax_code_id,
    quantity, unit_price_minor, discount_minor, tax_rate_bps, net_minor, tax_minor,
    class_option_id, location_option_id, project_option_id, customer_contact_id, is_billable
  )
  SELECT
    _company_id, _bill_id, l.line_no, l.description, l.account_id, l.product_id, l.tax_code_id,
    COALESCE(l.quantity, 1), COALESCE(l.unit_price_minor, 0), COALESCE(l.discount_minor, 0),
    COALESCE(l.tax_rate_bps, 0), COALESCE(l.net_minor, 0), COALESCE(l.tax_minor, 0),
    l.class_option_id, l.location_option_id, l.project_option_id, l.customer_contact_id,
    COALESCE(l.is_billable, false)
  FROM jsonb_to_recordset(_lines) AS l(
    line_no INTEGER, description TEXT, account_id UUID, product_id UUID, tax_code_id UUID,
    quantity NUMERIC, unit_price_minor BIGINT, discount_minor BIGINT, tax_rate_bps INTEGER,
    net_minor BIGINT, tax_minor BIGINT, class_option_id UUID, location_option_id UUID,
    project_option_id UUID, customer_contact_id UUID, is_billable BOOLEAN
  );

  GET DIAGNOSTICS _count = ROW_COUNT;
  RETURN _count;
END;
$$;

REVOKE ALL ON FUNCTION public.replace_purchase_bill_lines(UUID, UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.replace_purchase_bill_lines(UUID, UUID, JSONB) TO authenticated;
