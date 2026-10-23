-- Workstream B (Sales / AR): atomic draft save for invoices, quotes and credit notes
-- (AR-11, AR-12, AR-13, AR-14, AR-15, AR-16).
--
-- One transaction: allocate the document number (no gaps if the save fails), write the header,
-- replace the lines, and (for quote -> invoice) claim the quote with a row lock so two clicks can
-- never create two invoices. Line math (net/tax/gross) is computed by the app; this function
-- re-checks that each line adds up and derives the header totals from the lines.
--
-- payload:
--   kind: 'invoice' | 'quote' | 'credit_note'
--   company_id, [id] (omit to create), contact_id, doc_date, [due_date] (invoice) / [expiry_date] (quote),
--   [number], [memo], currency_code, [fx_rate_to_base], [invoice_id] (credit note source), [quote_id] (invoice from quote),
--   lines: [{description, account_id, quantity, unit_price_minor, discount_minor, tax_rate_bps,
--            tax_code_id, product_id, net_minor, tax_minor, gross_minor}]
-- returns: {id, number}

CREATE OR REPLACE FUNCTION public.save_sales_document_draft(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _kind TEXT := payload->>'kind';
  _company_id UUID;
  _id UUID;
  _contact_id UUID;
  _date DATE;
  _due DATE;
  _expiry DATE;
  _number TEXT;
  _memo TEXT;
  _currency CHAR(3);
  _base CHAR(3);
  _fx NUMERIC(18, 8);
  _src_invoice UUID;
  _quote_id UUID;
  _lines JSONB;
  _l JSONB;
  _n INT := 0;
  _sub BIGINT := 0;
  _tax BIGINT := 0;
  _net BIGINT;
  _taxl BIGINT;
  _gross BIGINT;
  _contact_ok BOOLEAN;
  _acct RECORD;
  _existing RECORD;
  _q RECORD;
  _si RECORD;
  _doc_type TEXT;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF _kind IS NULL OR _kind NOT IN ('invoice', 'quote', 'credit_note') THEN
    RAISE EXCEPTION 'Unknown document kind';
  END IF;
  _company_id := NULLIF(payload->>'company_id', '')::UUID;
  IF _company_id IS NULL THEN RAISE EXCEPTION 'company_id is required'; END IF;
  IF NOT public.is_company_member(_company_id) THEN RAISE EXCEPTION 'You do not have access to that organisation'; END IF;
  IF NOT public.has_company_permission(_company_id, 'sales.draft') THEN
    RAISE EXCEPTION 'You do not have permission to create or edit sales drafts';
  END IF;

  _id := NULLIF(payload->>'id', '')::UUID;
  _contact_id := NULLIF(payload->>'contact_id', '')::UUID;
  _date := NULLIF(payload->>'doc_date', '')::DATE;
  _due := NULLIF(payload->>'due_date', '')::DATE;
  _expiry := NULLIF(payload->>'expiry_date', '')::DATE;
  _number := NULLIF(left(trim(COALESCE(payload->>'number', '')), 40), '');
  _memo := NULLIF(left(trim(COALESCE(payload->>'memo', '')), 500), '');
  _fx := COALESCE(NULLIF(payload->>'fx_rate_to_base', '')::NUMERIC, 1);
  _src_invoice := NULLIF(payload->>'invoice_id', '')::UUID;
  _quote_id := NULLIF(payload->>'quote_id', '')::UUID;
  _lines := payload->'lines';

  IF _contact_id IS NULL THEN RAISE EXCEPTION 'Customer is required'; END IF;
  IF _date IS NULL THEN RAISE EXCEPTION 'Document date is required'; END IF;
  IF _fx <= 0 THEN RAISE EXCEPTION 'fx_rate_to_base must be positive'; END IF;
  IF _lines IS NULL OR jsonb_typeof(_lines) <> 'array' OR jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'At least one line is required';
  END IF;
  IF _kind = 'invoice' THEN
    IF _due IS NULL THEN RAISE EXCEPTION 'Due date is required'; END IF;
    IF _due < _date THEN RAISE EXCEPTION 'Due date cannot be before invoice date'; END IF;
  END IF;

  SELECT base_currency INTO _base FROM public.companies WHERE id = _company_id;
  _currency := upper(COALESCE(NULLIF(payload->>'currency_code', ''), _base));

  SELECT (c.kind IN ('customer', 'both') AND c.is_active) INTO _contact_ok
  FROM public.contacts c WHERE c.id = _contact_id AND c.company_id = _company_id;
  IF _contact_ok IS NULL THEN RAISE EXCEPTION 'Customer not found in this organisation'; END IF;
  IF NOT _contact_ok THEN RAISE EXCEPTION 'Contact is not an active customer'; END IF;

  -- Validate lines (account in company, postable, not a control account; per-line sums add up).
  FOR _l IN SELECT value FROM jsonb_array_elements(_lines)
  LOOP
    _n := _n + 1;
    _net := (_l->>'net_minor')::BIGINT;
    _taxl := (_l->>'tax_minor')::BIGINT;
    _gross := (_l->>'gross_minor')::BIGINT;
    IF NULLIF(trim(COALESCE(_l->>'description', '')), '') IS NULL THEN
      RAISE EXCEPTION 'Line %: description is required', _n;
    END IF;
    IF _net IS NULL OR _taxl IS NULL OR _gross IS NULL OR _net < 0 OR _taxl < 0 OR _net + _taxl <> _gross THEN
      RAISE EXCEPTION 'Line %: amounts are invalid', _n;
    END IF;
    SELECT id, is_active, archived_at, is_postable, is_control INTO _acct
    FROM public.accounts WHERE id = NULLIF(_l->>'account_id', '')::UUID AND company_id = _company_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Line %: account not found in this organisation', _n; END IF;
    IF NOT _acct.is_active OR _acct.archived_at IS NOT NULL THEN RAISE EXCEPTION 'Line %: account is inactive', _n; END IF;
    IF NOT _acct.is_postable THEN RAISE EXCEPTION 'Line %: account is not postable', _n; END IF;
    IF _acct.is_control THEN RAISE EXCEPTION 'Line %: a control account cannot be used on a sales line', _n; END IF;
    IF NULLIF(_l->>'tax_code_id', '') IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.tax_codes tc
      WHERE tc.id = (_l->>'tax_code_id')::UUID AND tc.company_id = _company_id
    ) THEN
      RAISE EXCEPTION 'Line %: tax code not found in this organisation', _n;
    END IF;
    _sub := _sub + _net;
    _tax := _tax + _taxl;
  END LOOP;

  _doc_type := CASE _kind WHEN 'invoice' THEN 'sales_invoice'
                          WHEN 'quote' THEN 'sales_quote'
                          ELSE 'sales_credit_note' END;

  -- ---- Credit note: optional source invoice must belong to the same company + customer ----
  IF _kind = 'credit_note' AND _src_invoice IS NOT NULL THEN
    SELECT contact_id, currency_code, status INTO _si
    FROM public.sales_invoices WHERE id = _src_invoice AND company_id = _company_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Source invoice not found in this organisation'; END IF;
    IF _si.contact_id <> _contact_id THEN RAISE EXCEPTION 'Source invoice belongs to a different customer'; END IF;
    IF _si.currency_code <> _currency THEN RAISE EXCEPTION 'Source invoice is in a different currency'; END IF;
    IF _si.status IN ('draft', 'void') THEN RAISE EXCEPTION 'Cannot credit a % invoice', _si.status; END IF;
  END IF;

  -- ---- Invoice from quote: claim the quote under a row lock ----
  IF _kind = 'invoice' AND _quote_id IS NOT NULL THEN
    IF _id IS NOT NULL THEN RAISE EXCEPTION 'quote_id can only be used when creating an invoice'; END IF;
    SELECT * INTO _q FROM public.sales_quotes
    WHERE id = _quote_id AND company_id = _company_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found'; END IF;
    IF _q.status = 'converted' OR _q.converted_invoice_id IS NOT NULL THEN RAISE EXCEPTION 'Quote already converted'; END IF;
    IF _q.status NOT IN ('draft', 'sent', 'accepted') THEN
      RAISE EXCEPTION 'A % quote cannot be converted', _q.status;
    END IF;
    IF _q.contact_id <> _contact_id THEN RAISE EXCEPTION 'Quote belongs to a different customer'; END IF;
  END IF;

  -- ---- Header ----
  IF _id IS NOT NULL THEN
    IF _kind = 'invoice' THEN
      SELECT id, status::TEXT AS status, invoice_number AS num INTO _existing
      FROM public.sales_invoices WHERE id = _id AND company_id = _company_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
      IF _existing.status <> 'draft' THEN RAISE EXCEPTION 'Only draft invoices can be edited'; END IF;
    ELSIF _kind = 'quote' THEN
      SELECT id, status::TEXT AS status, quote_number AS num INTO _existing
      FROM public.sales_quotes WHERE id = _id AND company_id = _company_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found'; END IF;
      IF _existing.status IN ('converted', 'void') THEN RAISE EXCEPTION 'Converted or void quotes cannot be edited'; END IF;
    ELSE
      SELECT id, status::TEXT AS status, credit_number AS num INTO _existing
      FROM public.sales_credit_notes WHERE id = _id AND company_id = _company_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Credit note not found'; END IF;
      IF _existing.status <> 'draft' THEN RAISE EXCEPTION 'Only draft credit notes can be edited'; END IF;
    END IF;
    _number := COALESCE(_number, _existing.num);
  END IF;

  IF _number IS NULL THEN
    -- Companies that were not seeded get distinct prefixes instead of the generic 'SAL-' for all
    -- three document types (allocate_document_number would otherwise derive 'SAL-' from the type).
    INSERT INTO public.document_sequences (company_id, document_type, prefix, next_number, padding)
    VALUES (
      _company_id, _doc_type,
      CASE _kind WHEN 'invoice' THEN 'INV-' WHEN 'quote' THEN 'QU-' ELSE 'SCN-' END,
      1, 4
    )
    ON CONFLICT (company_id, document_type) DO NOTHING;
    _number := public.allocate_document_number(_company_id, _doc_type);
  END IF;

  IF _kind = 'invoice' THEN
    IF _id IS NULL THEN
      INSERT INTO public.sales_invoices (
        company_id, contact_id, invoice_number, invoice_date, due_date, currency_code, fx_rate_to_base,
        status, subtotal_minor, tax_minor, total_minor, memo, quote_id, created_by
      ) VALUES (
        _company_id, _contact_id, _number, _date, _due, _currency, _fx,
        'draft', _sub, _tax, _sub + _tax, _memo, _quote_id, _uid
      ) RETURNING id INTO _id;
    ELSE
      UPDATE public.sales_invoices
      SET contact_id = _contact_id, invoice_number = _number, invoice_date = _date, due_date = _due,
          currency_code = _currency, fx_rate_to_base = _fx, subtotal_minor = _sub, tax_minor = _tax,
          total_minor = _sub + _tax, memo = _memo, updated_at = now()
      WHERE id = _id AND company_id = _company_id;
      DELETE FROM public.sales_invoice_lines WHERE invoice_id = _id AND company_id = _company_id;
    END IF;
  ELSIF _kind = 'quote' THEN
    IF _id IS NULL THEN
      INSERT INTO public.sales_quotes (
        company_id, contact_id, quote_number, quote_date, expiry_date, currency_code, fx_rate_to_base,
        status, subtotal_minor, tax_minor, total_minor, memo, created_by
      ) VALUES (
        _company_id, _contact_id, _number, _date, _expiry, _currency, _fx,
        'draft', _sub, _tax, _sub + _tax, _memo, _uid
      ) RETURNING id INTO _id;
    ELSE
      UPDATE public.sales_quotes
      SET contact_id = _contact_id, quote_number = _number, quote_date = _date, expiry_date = _expiry,
          currency_code = _currency, fx_rate_to_base = _fx, subtotal_minor = _sub, tax_minor = _tax,
          total_minor = _sub + _tax, memo = _memo, updated_at = now()
      WHERE id = _id AND company_id = _company_id;
      DELETE FROM public.sales_quote_lines WHERE quote_id = _id AND company_id = _company_id;
    END IF;
  ELSE
    IF _id IS NULL THEN
      INSERT INTO public.sales_credit_notes (
        company_id, contact_id, credit_number, credit_date, currency_code, fx_rate_to_base,
        status, subtotal_minor, tax_minor, total_minor, memo, invoice_id, created_by
      ) VALUES (
        _company_id, _contact_id, _number, _date, _currency, _fx,
        'draft', _sub, _tax, _sub + _tax, _memo, _src_invoice, _uid
      ) RETURNING id INTO _id;
    ELSE
      UPDATE public.sales_credit_notes
      SET contact_id = _contact_id, credit_number = _number, credit_date = _date,
          currency_code = _currency, fx_rate_to_base = _fx, subtotal_minor = _sub, tax_minor = _tax,
          total_minor = _sub + _tax, memo = _memo, invoice_id = _src_invoice, updated_at = now()
      WHERE id = _id AND company_id = _company_id;
      DELETE FROM public.sales_credit_note_lines WHERE credit_note_id = _id AND company_id = _company_id;
    END IF;
  END IF;

  -- ---- Lines ----
  _n := 0;
  FOR _l IN SELECT value FROM jsonb_array_elements(_lines)
  LOOP
    _n := _n + 1;
    IF _kind = 'invoice' THEN
      INSERT INTO public.sales_invoice_lines (
        company_id, invoice_id, line_order, description, account_id, quantity, unit_price_minor,
        discount_minor, tax_rate_bps, net_minor, tax_minor, gross_minor, product_id, tax_code_id
      ) VALUES (
        _company_id, _id, _n, trim(_l->>'description'), (_l->>'account_id')::UUID,
        (_l->>'quantity')::NUMERIC, (_l->>'unit_price_minor')::BIGINT,
        COALESCE((_l->>'discount_minor')::BIGINT, 0), COALESCE((_l->>'tax_rate_bps')::INT, 0),
        (_l->>'net_minor')::BIGINT, (_l->>'tax_minor')::BIGINT, (_l->>'gross_minor')::BIGINT,
        NULLIF(_l->>'product_id', '')::UUID, NULLIF(_l->>'tax_code_id', '')::UUID
      );
    ELSIF _kind = 'quote' THEN
      INSERT INTO public.sales_quote_lines (
        company_id, quote_id, line_order, description, account_id, quantity, unit_price_minor,
        discount_minor, tax_rate_bps, net_minor, tax_minor, gross_minor, product_id, tax_code_id
      ) VALUES (
        _company_id, _id, _n, trim(_l->>'description'), (_l->>'account_id')::UUID,
        (_l->>'quantity')::NUMERIC, (_l->>'unit_price_minor')::BIGINT,
        COALESCE((_l->>'discount_minor')::BIGINT, 0), COALESCE((_l->>'tax_rate_bps')::INT, 0),
        (_l->>'net_minor')::BIGINT, (_l->>'tax_minor')::BIGINT, (_l->>'gross_minor')::BIGINT,
        NULLIF(_l->>'product_id', '')::UUID, NULLIF(_l->>'tax_code_id', '')::UUID
      );
    ELSE
      INSERT INTO public.sales_credit_note_lines (
        company_id, credit_note_id, line_order, description, account_id, quantity, unit_price_minor,
        discount_minor, tax_rate_bps, net_minor, tax_minor, gross_minor, product_id, tax_code_id
      ) VALUES (
        _company_id, _id, _n, trim(_l->>'description'), (_l->>'account_id')::UUID,
        (_l->>'quantity')::NUMERIC, (_l->>'unit_price_minor')::BIGINT,
        COALESCE((_l->>'discount_minor')::BIGINT, 0), COALESCE((_l->>'tax_rate_bps')::INT, 0),
        (_l->>'net_minor')::BIGINT, (_l->>'tax_minor')::BIGINT, (_l->>'gross_minor')::BIGINT,
        NULLIF(_l->>'product_id', '')::UUID, NULLIF(_l->>'tax_code_id', '')::UUID
      );
    END IF;
  END LOOP;

  IF _kind = 'invoice' AND _quote_id IS NOT NULL THEN
    UPDATE public.sales_quotes
    SET status = 'converted', converted_invoice_id = _id, updated_at = now()
    WHERE id = _quote_id AND company_id = _company_id;
  END IF;

  RETURN jsonb_build_object('id', _id, 'number', _number);

EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'A document with number % already exists', _number;
END;
$$;

REVOKE ALL ON FUNCTION public.save_sales_document_draft(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_sales_document_draft(JSONB) TO authenticated;
