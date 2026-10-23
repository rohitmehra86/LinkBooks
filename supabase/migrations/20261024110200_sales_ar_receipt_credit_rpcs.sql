-- Workstream B (Sales / AR): atomic receipt + credit allocation RPCs (AR-01, AR-03, AR-04).
--
-- Every function: SECURITY DEFINER, search_path = public, checks auth.uid() and the company
-- permission, locks the rows it changes, validates BEFORE writing, and posts ledger entries only
-- through public.post_journal. One transaction: either everything is written or nothing is.
-- Requires 20261024110100_sales_ar_columns.sql (allocated_on / reversed_on columns).

-- ---------------------------------------------------------------------------
-- Internal helpers (not callable by clients)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sales_ar_control_account(_company_id UUID)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.id
  FROM public.accounts a
  WHERE a.company_id = _company_id
    AND a.is_active
    AND a.archived_at IS NULL
    AND (a.system_key = 'ar' OR a.code = '1100')
  ORDER BY (a.system_key = 'ar') DESC NULLS LAST, (a.code = '1100') DESC, a.created_at
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.sales_is_deposit_account(_company_id UUID, _account_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.accounts a
    WHERE a.id = _account_id
      AND a.company_id = _company_id
      AND a.is_active
      AND a.archived_at IS NULL
      AND a.is_postable
      AND NOT a.is_control
      AND a.account_type::text = 'asset'
      AND (
        a.account_kind IN ('bank', 'cash')
        OR a.subtype IN ('bank', 'cash')
        OR a.system_key IN ('bank', 'cash')
        OR a.is_payment_enabled
        -- Default-chart fallback (e.g. 1000 "Bank" before a bank_accounts row exists)
        OR a.name ILIKE '%bank%'
        OR a.name ILIKE '%cash%'
        OR EXISTS (
          SELECT 1 FROM public.bank_accounts b
          WHERE b.gl_account_id = a.id AND b.company_id = a.company_id AND b.is_active
        )
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.sales_derive_invoice_status(
  _total BIGINT, _paid BIGINT, _credited BIGINT
) RETURNS public.sales_doc_status
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN _total - _paid - _credited <= 0 THEN 'paid'::public.sales_doc_status
    WHEN _paid + _credited > 0 THEN 'partly_paid'::public.sales_doc_status
    ELSE 'authorised'::public.sales_doc_status
  END;
$$;

REVOKE ALL ON FUNCTION public.sales_ar_control_account(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sales_is_deposit_account(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sales_derive_invoice_status(BIGINT, BIGINT, BIGINT) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- record_customer_receipt(payload jsonb)
--   payload: company_id, contact_id, receipt_date, amount_minor, bank_account_id,
--            currency_code, [fx_rate_to_base], [reference], [memo],
--            allocations: [{invoice_id, amount_minor}]
--   returns: {receipt_id, journal_id, unallocated_minor}
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_customer_receipt(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _company_id UUID;
  _contact_id UUID;
  _date DATE;
  _amount BIGINT;
  _bank UUID;
  _currency CHAR(3);
  _base CHAR(3);
  _fx NUMERIC(18, 8);
  _ref TEXT;
  _memo TEXT;
  _allocs JSONB;
  _a JSONB;
  _inv RECORD;
  _ids UUID[] := '{}';
  _inv_id UUID;
  _amt BIGINT;
  _alloc_sum BIGINT := 0;
  _ar UUID;
  _receipt_id UUID;
  _journal_id UUID;
  _unalloc BIGINT;
  _contact_ok BOOLEAN;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;

  _company_id := NULLIF(payload->>'company_id', '')::UUID;
  IF _company_id IS NULL THEN RAISE EXCEPTION 'company_id is required'; END IF;
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT public.has_company_permission(_company_id, 'sales.payment') THEN
    RAISE EXCEPTION 'You do not have permission to record customer receipts';
  END IF;

  _contact_id := NULLIF(payload->>'contact_id', '')::UUID;
  _date := NULLIF(payload->>'receipt_date', '')::DATE;
  _amount := NULLIF(payload->>'amount_minor', '')::BIGINT;
  _bank := NULLIF(payload->>'bank_account_id', '')::UUID;
  _ref := NULLIF(left(trim(COALESCE(payload->>'reference', '')), 80), '');
  _memo := NULLIF(left(trim(COALESCE(payload->>'memo', '')), 500), '');
  _fx := COALESCE(NULLIF(payload->>'fx_rate_to_base', '')::NUMERIC, 1);
  _allocs := COALESCE(payload->'allocations', '[]'::jsonb);

  IF _contact_id IS NULL THEN RAISE EXCEPTION 'Customer is required'; END IF;
  IF _date IS NULL THEN RAISE EXCEPTION 'Receipt date is required'; END IF;
  IF _amount IS NULL OR _amount <= 0 THEN RAISE EXCEPTION 'Receipt amount must be positive'; END IF;
  IF _bank IS NULL THEN RAISE EXCEPTION 'Deposit account is required'; END IF;
  IF _fx <= 0 THEN RAISE EXCEPTION 'fx_rate_to_base must be positive'; END IF;
  IF jsonb_typeof(_allocs) <> 'array' THEN RAISE EXCEPTION 'allocations must be an array'; END IF;

  SELECT base_currency INTO _base FROM public.companies WHERE id = _company_id;
  _currency := upper(COALESCE(NULLIF(payload->>'currency_code', ''), _base));

  SELECT (c.kind IN ('customer', 'both') AND c.is_active) INTO _contact_ok
  FROM public.contacts c WHERE c.id = _contact_id AND c.company_id = _company_id;
  IF _contact_ok IS NULL THEN RAISE EXCEPTION 'Customer not found in this organisation'; END IF;
  IF NOT _contact_ok THEN RAISE EXCEPTION 'Contact is not an active customer'; END IF;

  IF NOT public.sales_is_deposit_account(_company_id, _bank) THEN
    RAISE EXCEPTION 'Deposit account must be an active bank or cash account of this organisation';
  END IF;

  _ar := public.sales_ar_control_account(_company_id);
  IF _ar IS NULL THEN
    RAISE EXCEPTION 'Accounts receivable control account is missing. Seed the chart of accounts first.';
  END IF;

  -- ---- Parse + validate allocation inputs (no writes yet) ----
  FOR _a IN SELECT value FROM jsonb_array_elements(_allocs)
  LOOP
    _inv_id := NULLIF(_a->>'invoice_id', '')::UUID;
    _amt := NULLIF(_a->>'amount_minor', '')::BIGINT;
    IF _inv_id IS NULL THEN RAISE EXCEPTION 'Allocation is missing invoice_id'; END IF;
    IF _amt IS NULL OR _amt <= 0 THEN RAISE EXCEPTION 'Allocation amounts must be positive'; END IF;
    IF _inv_id = ANY (_ids) THEN RAISE EXCEPTION 'An invoice can only appear once per receipt'; END IF;
    _ids := _ids || _inv_id;
    _alloc_sum := _alloc_sum + _amt;
  END LOOP;
  IF _alloc_sum > _amount THEN RAISE EXCEPTION 'Allocations exceed receipt amount'; END IF;

  -- ---- Lock target invoices in a stable order (deadlock-safe), then validate each ----
  IF cardinality(_ids) > 0 THEN
    PERFORM 1 FROM public.sales_invoices
    WHERE id = ANY (_ids) AND company_id = _company_id
    ORDER BY id
    FOR UPDATE;

    FOR _a IN SELECT value FROM jsonb_array_elements(_allocs)
    LOOP
      _inv_id := (_a->>'invoice_id')::UUID;
      _amt := (_a->>'amount_minor')::BIGINT;
      SELECT * INTO _inv FROM public.sales_invoices WHERE id = _inv_id AND company_id = _company_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found for allocation'; END IF;
      IF _inv.contact_id <> _contact_id THEN
        RAISE EXCEPTION 'Invoice % belongs to a different customer', COALESCE(_inv.invoice_number, _inv_id::TEXT);
      END IF;
      IF _inv.currency_code <> _currency THEN
        RAISE EXCEPTION 'Invoice % is in % but the receipt is in %',
          COALESCE(_inv.invoice_number, _inv_id::TEXT), _inv.currency_code, _currency;
      END IF;
      IF _inv.status NOT IN ('authorised', 'partly_paid') THEN
        RAISE EXCEPTION 'Invoice % is % and cannot receive a payment',
          COALESCE(_inv.invoice_number, _inv_id::TEXT), _inv.status;
      END IF;
      IF _amt > _inv.total_minor - _inv.amount_paid_minor - _inv.amount_credited_minor THEN
        RAISE EXCEPTION 'Allocation exceeds the outstanding balance of invoice %',
          COALESCE(_inv.invoice_number, _inv_id::TEXT);
      END IF;
    END LOOP;
  END IF;

  _unalloc := _amount - _alloc_sum;

  -- ---- Writes ----
  INSERT INTO public.sales_receipts (
    company_id, contact_id, receipt_date, currency_code, amount_minor, unallocated_minor,
    bank_account_id, reference, memo, status, fx_rate_to_base, created_by
  ) VALUES (
    _company_id, _contact_id, _date, _currency, _amount, _unalloc,
    _bank, _ref, _memo, 'posted', _fx, _uid
  ) RETURNING id INTO _receipt_id;

  _journal_id := public.post_journal(jsonb_build_object(
    'company_id', _company_id,
    'journal_date', _date,
    'memo', _memo,
    'currency_code', _currency,
    'fx_rate_to_base', _fx,
    'source_type', 'customer_payment',
    'source_id', _receipt_id,
    'idempotency_key', 'customer_receipt:' || _receipt_id::TEXT || ':post',
    'lines', jsonb_build_array(
      jsonb_build_object('account_id', _bank, 'description', COALESCE(_memo, 'Bank'),
                         'debit_minor', _amount, 'credit_minor', 0),
      jsonb_build_object('account_id', _ar, 'description', COALESCE(_memo, 'Customer receipt'),
                         'debit_minor', 0, 'credit_minor', _amount)
    )
  ));

  UPDATE public.sales_receipts SET posted_journal_id = _journal_id, updated_at = now()
  WHERE id = _receipt_id;

  FOR _a IN SELECT value FROM jsonb_array_elements(_allocs)
  LOOP
    _inv_id := (_a->>'invoice_id')::UUID;
    _amt := (_a->>'amount_minor')::BIGINT;

    INSERT INTO public.sales_receipt_allocations (
      company_id, receipt_id, invoice_id, amount_minor, allocated_on, created_by
    ) VALUES (_company_id, _receipt_id, _inv_id, _amt, _date, _uid);

    -- Atomic increment; status derived from the row's own values in the same statement.
    UPDATE public.sales_invoices
    SET amount_paid_minor = amount_paid_minor + _amt,
        status = public.sales_derive_invoice_status(
          total_minor, amount_paid_minor + _amt, amount_credited_minor),
        updated_at = now()
    WHERE id = _inv_id AND company_id = _company_id;
  END LOOP;

  PERFORM public.record_audit_event(
    _company_id, 'sales.receipt.recorded', 'sales_receipt', _receipt_id,
    jsonb_build_object('amount_minor', _amount, 'allocated_minor', _alloc_sum,
                       'journal_id', _journal_id, 'contact_id', _contact_id)
  );

  RETURN jsonb_build_object(
    'receipt_id', _receipt_id,
    'journal_id', _journal_id,
    'unallocated_minor', _unalloc
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- allocate_sales_credit_note(payload jsonb)
--   payload: company_id, credit_note_id, [allocation_date], allocations:[{invoice_id, amount_minor}]
--   returns: {credit_note_id, allocated_minor, remaining_minor}
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.allocate_sales_credit_note(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _company_id UUID;
  _cn_id UUID;
  _on DATE;
  _cn RECORD;
  _allocs JSONB;
  _a JSONB;
  _inv RECORD;
  _ids UUID[] := '{}';
  _inv_id UUID;
  _amt BIGINT;
  _sum BIGINT := 0;
  _new_alloc BIGINT;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  _company_id := NULLIF(payload->>'company_id', '')::UUID;
  _cn_id := NULLIF(payload->>'credit_note_id', '')::UUID;
  IF _company_id IS NULL OR _cn_id IS NULL THEN RAISE EXCEPTION 'company_id and credit_note_id are required'; END IF;
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT public.has_company_permission(_company_id, 'sales.payment') THEN
    RAISE EXCEPTION 'You do not have permission to allocate credit notes';
  END IF;

  _allocs := COALESCE(payload->'allocations', '[]'::jsonb);
  IF jsonb_typeof(_allocs) <> 'array' OR jsonb_array_length(_allocs) = 0 THEN
    RAISE EXCEPTION 'At least one allocation is required';
  END IF;
  _on := COALESCE(NULLIF(payload->>'allocation_date', '')::DATE, CURRENT_DATE);

  SELECT * INTO _cn FROM public.sales_credit_notes
  WHERE id = _cn_id AND company_id = _company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Credit note not found'; END IF;
  IF _cn.status NOT IN ('authorised', 'partly_paid') THEN
    RAISE EXCEPTION 'Credit note must be authorised (and not fully applied or void) before allocation';
  END IF;
  IF _on < _cn.credit_date THEN
    RAISE EXCEPTION 'Allocation date cannot be before the credit note date %', _cn.credit_date;
  END IF;

  FOR _a IN SELECT value FROM jsonb_array_elements(_allocs)
  LOOP
    _inv_id := NULLIF(_a->>'invoice_id', '')::UUID;
    _amt := NULLIF(_a->>'amount_minor', '')::BIGINT;
    IF _inv_id IS NULL THEN RAISE EXCEPTION 'Allocation is missing invoice_id'; END IF;
    IF _amt IS NULL OR _amt <= 0 THEN RAISE EXCEPTION 'Allocation amounts must be positive'; END IF;
    IF _inv_id = ANY (_ids) THEN RAISE EXCEPTION 'An invoice can only appear once per allocation request'; END IF;
    _ids := _ids || _inv_id;
    _sum := _sum + _amt;
  END LOOP;
  IF _sum > _cn.total_minor - _cn.amount_allocated_minor THEN
    RAISE EXCEPTION 'Allocations exceed the remaining credit';
  END IF;

  PERFORM 1 FROM public.sales_invoices
  WHERE id = ANY (_ids) AND company_id = _company_id
  ORDER BY id
  FOR UPDATE;

  FOR _a IN SELECT value FROM jsonb_array_elements(_allocs)
  LOOP
    _inv_id := (_a->>'invoice_id')::UUID;
    _amt := (_a->>'amount_minor')::BIGINT;
    SELECT * INTO _inv FROM public.sales_invoices WHERE id = _inv_id AND company_id = _company_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
    IF _inv.contact_id <> _cn.contact_id THEN
      RAISE EXCEPTION 'Invoice % belongs to a different customer', COALESCE(_inv.invoice_number, _inv_id::TEXT);
    END IF;
    IF _inv.currency_code <> _cn.currency_code THEN
      RAISE EXCEPTION 'Currency mismatch between credit note and invoice %', COALESCE(_inv.invoice_number, _inv_id::TEXT);
    END IF;
    IF _inv.status NOT IN ('authorised', 'partly_paid') THEN
      RAISE EXCEPTION 'Invoice % is % and cannot receive a credit',
        COALESCE(_inv.invoice_number, _inv_id::TEXT), _inv.status;
    END IF;
    IF _on < _inv.invoice_date THEN
      RAISE EXCEPTION 'Allocation date cannot be before invoice % date %',
        COALESCE(_inv.invoice_number, _inv_id::TEXT), _inv.invoice_date;
    END IF;
    IF _amt > _inv.total_minor - _inv.amount_paid_minor - _inv.amount_credited_minor THEN
      RAISE EXCEPTION 'Allocation exceeds the outstanding balance of invoice %',
        COALESCE(_inv.invoice_number, _inv_id::TEXT);
    END IF;
  END LOOP;

  FOR _a IN SELECT value FROM jsonb_array_elements(_allocs)
  LOOP
    _inv_id := (_a->>'invoice_id')::UUID;
    _amt := (_a->>'amount_minor')::BIGINT;

    INSERT INTO public.sales_credit_allocations (
      company_id, credit_note_id, invoice_id, amount_minor, allocated_on, created_by
    ) VALUES (_company_id, _cn_id, _inv_id, _amt, _on, _uid)
    ON CONFLICT (credit_note_id, invoice_id) WHERE reversed_on IS NULL
    DO UPDATE SET amount_minor = public.sales_credit_allocations.amount_minor + EXCLUDED.amount_minor;

    UPDATE public.sales_invoices
    SET amount_credited_minor = amount_credited_minor + _amt,
        status = public.sales_derive_invoice_status(
          total_minor, amount_paid_minor, amount_credited_minor + _amt),
        updated_at = now()
    WHERE id = _inv_id AND company_id = _company_id;
  END LOOP;

  _new_alloc := _cn.amount_allocated_minor + _sum;
  UPDATE public.sales_credit_notes
  SET amount_allocated_minor = _new_alloc,
      status = CASE WHEN _new_alloc >= total_minor THEN 'paid'::public.sales_doc_status
                    ELSE 'partly_paid'::public.sales_doc_status END,
      updated_at = now()
  WHERE id = _cn_id;

  PERFORM public.record_audit_event(
    _company_id, 'sales.credit_note.allocated', 'sales_credit_note', _cn_id,
    jsonb_build_object('allocated_minor', _sum, 'allocation_date', _on)
  );

  RETURN jsonb_build_object(
    'credit_note_id', _cn_id,
    'allocated_minor', _new_alloc,
    'remaining_minor', _cn.total_minor - _new_alloc
  );
END;
$$;

REVOKE ALL ON FUNCTION public.record_customer_receipt(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.allocate_sales_credit_note(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_customer_receipt(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.allocate_sales_credit_note(JSONB) TO authenticated;
