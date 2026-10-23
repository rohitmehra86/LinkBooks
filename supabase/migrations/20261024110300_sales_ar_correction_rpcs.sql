-- Workstream B (Sales / AR): correction tools (AR-05, AR-21, AR-22).
--   unallocate_customer_receipt, void_customer_receipt, remove_sales_credit_allocation,
--   void_sales_credit_note, void_sales_invoice, delete_draft_sales_document.
--
-- All SECURITY DEFINER, search_path = public, permission-checked, row-locked, reason-mandatory,
-- and atomic. Reversals go through public.reverse_journal_on (explicit reversal date, must be in an
-- open period) which itself posts via public.post_journal. Posted journals are never edited.
-- Requires 20261024110000 (reverse_journal_on), 20261024110100 (columns), 20261024110200 (helpers).

-- ---------------------------------------------------------------------------
-- unallocate_customer_receipt
--   payload: company_id, receipt_id, reason, [invoice_id] (omit = remove every allocation),
--            [reversal_date] (default today)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.unallocate_customer_receipt(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _company_id UUID;
  _receipt_id UUID;
  _invoice_id UUID;
  _reason TEXT;
  _on DATE;
  _r RECORD;
  _al RECORD;
  _ids UUID[];
  _freed BIGINT := 0;
  _n INT := 0;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  _company_id := NULLIF(payload->>'company_id', '')::UUID;
  _receipt_id := NULLIF(payload->>'receipt_id', '')::UUID;
  _invoice_id := NULLIF(payload->>'invoice_id', '')::UUID;
  _reason := NULLIF(trim(COALESCE(payload->>'reason', '')), '');
  _on := COALESCE(NULLIF(payload->>'reversal_date', '')::DATE, CURRENT_DATE);
  IF _company_id IS NULL OR _receipt_id IS NULL THEN RAISE EXCEPTION 'company_id and receipt_id are required'; END IF;
  IF NOT public.is_company_member(_company_id) THEN RAISE EXCEPTION 'You do not have access to that organisation'; END IF;
  IF NOT public.has_company_permission(_company_id, 'sales.payment') THEN
    RAISE EXCEPTION 'You do not have permission to change receipt allocations';
  END IF;
  IF _reason IS NULL THEN RAISE EXCEPTION 'A reason is required'; END IF;

  SELECT * INTO _r FROM public.sales_receipts
  WHERE id = _receipt_id AND company_id = _company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receipt not found'; END IF;
  IF _r.status <> 'posted' THEN RAISE EXCEPTION 'Only posted receipts can be unallocated'; END IF;

  SELECT array_agg(invoice_id ORDER BY invoice_id) INTO _ids
  FROM public.sales_receipt_allocations
  WHERE receipt_id = _receipt_id AND reversed_on IS NULL
    AND (_invoice_id IS NULL OR invoice_id = _invoice_id);
  IF _ids IS NULL THEN RAISE EXCEPTION 'No active allocations to remove'; END IF;

  PERFORM 1 FROM public.sales_invoices WHERE id = ANY (_ids) AND company_id = _company_id ORDER BY id FOR UPDATE;

  FOR _al IN
    SELECT * FROM public.sales_receipt_allocations
    WHERE receipt_id = _receipt_id AND reversed_on IS NULL
      AND (_invoice_id IS NULL OR invoice_id = _invoice_id)
    ORDER BY invoice_id
  LOOP
    IF _on < _al.allocated_on THEN
      RAISE EXCEPTION 'Reversal date % cannot be before the allocation date %', _on, _al.allocated_on;
    END IF;
    UPDATE public.sales_receipt_allocations
    SET reversed_on = _on, reversed_at = now(), reversed_by = _uid, reverse_reason = _reason
    WHERE id = _al.id;

    UPDATE public.sales_invoices
    SET amount_paid_minor = amount_paid_minor - _al.amount_minor,
        status = public.sales_derive_invoice_status(
          total_minor, amount_paid_minor - _al.amount_minor, amount_credited_minor),
        updated_at = now()
    WHERE id = _al.invoice_id AND company_id = _company_id AND status <> 'void';

    _freed := _freed + _al.amount_minor;
    _n := _n + 1;
  END LOOP;

  UPDATE public.sales_receipts
  SET unallocated_minor = unallocated_minor + _freed, updated_at = now()
  WHERE id = _receipt_id;

  PERFORM public.record_audit_event(
    _company_id, 'sales.receipt.unallocated', 'sales_receipt', _receipt_id,
    jsonb_build_object('freed_minor', _freed, 'allocations', _n, 'reason', _reason)
  );
  RETURN jsonb_build_object('receipt_id', _receipt_id, 'freed_minor', _freed, 'allocations_removed', _n);
END;
$$;

-- ---------------------------------------------------------------------------
-- void_customer_receipt
--   payload: company_id, receipt_id, reason, [void_date] (default today)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.void_customer_receipt(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _company_id UUID;
  _receipt_id UUID;
  _reason TEXT;
  _on DATE;
  _r RECORD;
  _al RECORD;
  _ids UUID[];
  _active BIGINT;
  _void_journal UUID;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  _company_id := NULLIF(payload->>'company_id', '')::UUID;
  _receipt_id := NULLIF(payload->>'receipt_id', '')::UUID;
  _reason := NULLIF(trim(COALESCE(payload->>'reason', '')), '');
  _on := COALESCE(NULLIF(payload->>'void_date', '')::DATE, CURRENT_DATE);
  IF _company_id IS NULL OR _receipt_id IS NULL THEN RAISE EXCEPTION 'company_id and receipt_id are required'; END IF;
  IF NOT public.is_company_member(_company_id) THEN RAISE EXCEPTION 'You do not have access to that organisation'; END IF;
  IF NOT public.has_company_permission(_company_id, 'sales.void') THEN
    RAISE EXCEPTION 'You do not have permission to void receipts';
  END IF;
  IF _reason IS NULL THEN RAISE EXCEPTION 'A reason is required to void a receipt'; END IF;

  SELECT * INTO _r FROM public.sales_receipts
  WHERE id = _receipt_id AND company_id = _company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receipt not found'; END IF;
  IF _r.status = 'void' THEN RAISE EXCEPTION 'Receipt is already void'; END IF;
  IF _r.posted_journal_id IS NULL THEN RAISE EXCEPTION 'Receipt has no posted journal'; END IF;
  IF _on < _r.receipt_date THEN
    RAISE EXCEPTION 'Void date % cannot be before the receipt date %', _on, _r.receipt_date;
  END IF;

  SELECT COALESCE(sum(amount_minor), 0) INTO _active
  FROM public.sales_receipt_allocations WHERE receipt_id = _receipt_id AND reversed_on IS NULL;
  IF _r.unallocated_minor + _active <> _r.amount_minor THEN
    RAISE EXCEPTION 'Part of this receipt has already been refunded or used elsewhere. Void that document first.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.reconciliation_links rl
    JOIN public.journal_lines jl ON jl.id = rl.journal_line_id
    WHERE jl.journal_id = _r.posted_journal_id
  ) THEN
    RAISE EXCEPTION 'This receipt is reconciled to a bank transaction. Unreconcile it in Banking first.';
  END IF;

  SELECT array_agg(invoice_id ORDER BY invoice_id) INTO _ids
  FROM public.sales_receipt_allocations WHERE receipt_id = _receipt_id AND reversed_on IS NULL;
  IF _ids IS NOT NULL THEN
    PERFORM 1 FROM public.sales_invoices WHERE id = ANY (_ids) AND company_id = _company_id ORDER BY id FOR UPDATE;
  END IF;

  -- Reverse the journal first: if the period is locked this raises and nothing else has changed.
  _void_journal := public.reverse_journal_on(
    _r.posted_journal_id, _on, 'customer_receipt:' || _receipt_id::TEXT || ':void');

  FOR _al IN
    SELECT * FROM public.sales_receipt_allocations
    WHERE receipt_id = _receipt_id AND reversed_on IS NULL ORDER BY invoice_id
  LOOP
    UPDATE public.sales_receipt_allocations
    SET reversed_on = _on, reversed_at = now(), reversed_by = _uid,
        reverse_reason = 'Receipt voided: ' || _reason
    WHERE id = _al.id;

    UPDATE public.sales_invoices
    SET amount_paid_minor = amount_paid_minor - _al.amount_minor,
        status = public.sales_derive_invoice_status(
          total_minor, amount_paid_minor - _al.amount_minor, amount_credited_minor),
        updated_at = now()
    WHERE id = _al.invoice_id AND company_id = _company_id AND status <> 'void';
  END LOOP;

  UPDATE public.sales_receipts
  SET status = 'void', unallocated_minor = 0, void_journal_id = _void_journal,
      voided_at = now(), voided_by = _uid, void_reason = _reason, void_date = _on,
      updated_at = now()
  WHERE id = _receipt_id;

  PERFORM public.record_audit_event(
    _company_id, 'sales.receipt.voided', 'sales_receipt', _receipt_id,
    jsonb_build_object('reason', _reason, 'void_date', _on, 'void_journal_id', _void_journal)
  );
  RETURN jsonb_build_object('receipt_id', _receipt_id, 'void_journal_id', _void_journal);
END;
$$;

-- ---------------------------------------------------------------------------
-- remove_sales_credit_allocation
--   payload: company_id, allocation_id, reason, [reversal_date]
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.remove_sales_credit_allocation(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _company_id UUID;
  _alloc_id UUID;
  _reason TEXT;
  _on DATE;
  _al RECORD;
  _cn RECORD;
  _new_alloc BIGINT;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  _company_id := NULLIF(payload->>'company_id', '')::UUID;
  _alloc_id := NULLIF(payload->>'allocation_id', '')::UUID;
  _reason := NULLIF(trim(COALESCE(payload->>'reason', '')), '');
  _on := COALESCE(NULLIF(payload->>'reversal_date', '')::DATE, CURRENT_DATE);
  IF _company_id IS NULL OR _alloc_id IS NULL THEN RAISE EXCEPTION 'company_id and allocation_id are required'; END IF;
  IF NOT public.is_company_member(_company_id) THEN RAISE EXCEPTION 'You do not have access to that organisation'; END IF;
  IF NOT public.has_company_permission(_company_id, 'sales.payment') THEN
    RAISE EXCEPTION 'You do not have permission to change credit allocations';
  END IF;
  IF _reason IS NULL THEN RAISE EXCEPTION 'A reason is required'; END IF;

  SELECT * INTO _al FROM public.sales_credit_allocations
  WHERE id = _alloc_id AND company_id = _company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Allocation not found'; END IF;
  IF _al.reversed_on IS NOT NULL THEN RAISE EXCEPTION 'Allocation is already removed'; END IF;
  IF _on < _al.allocated_on THEN
    RAISE EXCEPTION 'Reversal date % cannot be before the allocation date %', _on, _al.allocated_on;
  END IF;

  SELECT * INTO _cn FROM public.sales_credit_notes
  WHERE id = _al.credit_note_id AND company_id = _company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Credit note not found'; END IF;
  IF _cn.status = 'void' THEN RAISE EXCEPTION 'Credit note is void'; END IF;

  PERFORM 1 FROM public.sales_invoices WHERE id = _al.invoice_id AND company_id = _company_id FOR UPDATE;

  UPDATE public.sales_credit_allocations
  SET reversed_on = _on, reversed_at = now(), reversed_by = _uid, reverse_reason = _reason
  WHERE id = _alloc_id;

  UPDATE public.sales_invoices
  SET amount_credited_minor = amount_credited_minor - _al.amount_minor,
      status = public.sales_derive_invoice_status(
        total_minor, amount_paid_minor, amount_credited_minor - _al.amount_minor),
      updated_at = now()
  WHERE id = _al.invoice_id AND company_id = _company_id AND status <> 'void';

  _new_alloc := _cn.amount_allocated_minor - _al.amount_minor;
  UPDATE public.sales_credit_notes
  SET amount_allocated_minor = _new_alloc,
      status = CASE WHEN _new_alloc <= 0 THEN 'authorised'::public.sales_doc_status
                    WHEN _new_alloc >= total_minor THEN 'paid'::public.sales_doc_status
                    ELSE 'partly_paid'::public.sales_doc_status END,
      updated_at = now()
  WHERE id = _cn.id;

  PERFORM public.record_audit_event(
    _company_id, 'sales.credit_allocation.removed', 'sales_credit_note', _cn.id,
    jsonb_build_object('allocation_id', _alloc_id, 'amount_minor', _al.amount_minor, 'reason', _reason)
  );
  RETURN jsonb_build_object('credit_note_id', _cn.id, 'allocated_minor', _new_alloc);
END;
$$;

-- ---------------------------------------------------------------------------
-- void_sales_credit_note
--   payload: company_id, credit_note_id, reason, [void_date]
--   Requires zero applied credit (remove allocations first) and no refund against it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.void_sales_credit_note(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _company_id UUID;
  _cn_id UUID;
  _reason TEXT;
  _on DATE;
  _cn RECORD;
  _void_journal UUID;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  _company_id := NULLIF(payload->>'company_id', '')::UUID;
  _cn_id := NULLIF(payload->>'credit_note_id', '')::UUID;
  _reason := NULLIF(trim(COALESCE(payload->>'reason', '')), '');
  _on := COALESCE(NULLIF(payload->>'void_date', '')::DATE, CURRENT_DATE);
  IF _company_id IS NULL OR _cn_id IS NULL THEN RAISE EXCEPTION 'company_id and credit_note_id are required'; END IF;
  IF NOT public.is_company_member(_company_id) THEN RAISE EXCEPTION 'You do not have access to that organisation'; END IF;
  IF NOT public.has_company_permission(_company_id, 'sales.void') THEN
    RAISE EXCEPTION 'You do not have permission to void credit notes';
  END IF;
  IF _reason IS NULL THEN RAISE EXCEPTION 'A reason is required to void a credit note'; END IF;

  SELECT * INTO _cn FROM public.sales_credit_notes
  WHERE id = _cn_id AND company_id = _company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Credit note not found'; END IF;
  IF _cn.status = 'void' THEN RAISE EXCEPTION 'Credit note is already void'; END IF;
  IF _cn.status = 'draft' OR _cn.posted_journal_id IS NULL THEN
    RAISE EXCEPTION 'Draft credit notes are deleted, not voided';
  END IF;
  IF _cn.amount_allocated_minor > 0 OR EXISTS (
    SELECT 1 FROM public.sales_credit_allocations WHERE credit_note_id = _cn_id AND reversed_on IS NULL
  ) THEN
    RAISE EXCEPTION 'Remove the credit allocations (and any refund) before voiding this credit note';
  END IF;
  IF _on < _cn.credit_date THEN
    RAISE EXCEPTION 'Void date % cannot be before the credit note date %', _on, _cn.credit_date;
  END IF;

  _void_journal := public.reverse_journal_on(
    _cn.posted_journal_id, _on, 'sales_credit_note:' || _cn_id::TEXT || ':void');

  UPDATE public.sales_credit_notes
  SET status = 'void', void_journal_id = _void_journal, voided_at = now(), voided_by = _uid,
      void_reason = _reason, void_date = _on, updated_at = now()
  WHERE id = _cn_id;

  PERFORM public.record_audit_event(
    _company_id, 'sales.credit_note.voided', 'sales_credit_note', _cn_id,
    jsonb_build_object('reason', _reason, 'void_date', _on, 'void_journal_id', _void_journal)
  );
  RETURN jsonb_build_object('credit_note_id', _cn_id, 'void_journal_id', _void_journal);
END;
$$;

-- ---------------------------------------------------------------------------
-- void_sales_invoice
--   payload: company_id, invoice_id, reason, [void_date]
--   Only authorised invoices with no payments/credits. Drafts are deleted instead.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.void_sales_invoice(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _company_id UUID;
  _inv_id UUID;
  _reason TEXT;
  _on DATE;
  _inv RECORD;
  _void_journal UUID;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  _company_id := NULLIF(payload->>'company_id', '')::UUID;
  _inv_id := NULLIF(payload->>'invoice_id', '')::UUID;
  _reason := NULLIF(trim(COALESCE(payload->>'reason', '')), '');
  _on := COALESCE(NULLIF(payload->>'void_date', '')::DATE, CURRENT_DATE);
  IF _company_id IS NULL OR _inv_id IS NULL THEN RAISE EXCEPTION 'company_id and invoice_id are required'; END IF;
  IF NOT public.is_company_member(_company_id) THEN RAISE EXCEPTION 'You do not have access to that organisation'; END IF;
  IF NOT public.has_company_permission(_company_id, 'sales.void') THEN
    RAISE EXCEPTION 'You do not have permission to void invoices';
  END IF;
  IF _reason IS NULL THEN RAISE EXCEPTION 'A reason is required to void an invoice'; END IF;

  SELECT * INTO _inv FROM public.sales_invoices
  WHERE id = _inv_id AND company_id = _company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  IF _inv.status = 'void' THEN RAISE EXCEPTION 'Invoice is already void'; END IF;
  IF _inv.status = 'draft' OR _inv.posted_journal_id IS NULL THEN
    RAISE EXCEPTION 'Draft invoices are deleted, not voided';
  END IF;
  IF _inv.amount_paid_minor > 0 OR _inv.amount_credited_minor > 0 OR EXISTS (
    SELECT 1 FROM public.sales_receipt_allocations WHERE invoice_id = _inv_id AND reversed_on IS NULL
    UNION ALL
    SELECT 1 FROM public.sales_credit_allocations WHERE invoice_id = _inv_id AND reversed_on IS NULL
  ) THEN
    RAISE EXCEPTION 'Remove the payments and credits applied to this invoice before voiding it';
  END IF;
  IF _on < _inv.invoice_date THEN
    RAISE EXCEPTION 'Void date % cannot be before the invoice date %', _on, _inv.invoice_date;
  END IF;

  _void_journal := public.reverse_journal_on(
    _inv.posted_journal_id, _on, 'sales_invoice:' || _inv_id::TEXT || ':void');

  UPDATE public.sales_invoices
  SET status = 'void', void_journal_id = _void_journal, voided_at = now(), voided_by = _uid,
      void_reason = _reason, void_date = _on, updated_at = now()
  WHERE id = _inv_id;

  PERFORM public.record_audit_event(
    _company_id, 'sales.invoice.voided', 'sales_invoice', _inv_id,
    jsonb_build_object('reason', _reason, 'void_date', _on, 'void_journal_id', _void_journal)
  );
  RETURN jsonb_build_object('invoice_id', _inv_id, 'void_journal_id', _void_journal);
END;
$$;

-- ---------------------------------------------------------------------------
-- delete_draft_sales_document  (AR-21: drafts can be deleted)
--   payload: company_id, kind ('invoice'|'quote'|'credit_note'), id
--   Only drafts that never posted a journal. A draft invoice created from a quote reopens it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_draft_sales_document(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _company_id UUID;
  _kind TEXT;
  _id UUID;
  _status TEXT;
  _journal UUID;
  _quote_id UUID;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  _company_id := NULLIF(payload->>'company_id', '')::UUID;
  _kind := payload->>'kind';
  _id := NULLIF(payload->>'id', '')::UUID;
  IF _company_id IS NULL OR _id IS NULL THEN RAISE EXCEPTION 'company_id and id are required'; END IF;
  IF NOT public.is_company_member(_company_id) THEN RAISE EXCEPTION 'You do not have access to that organisation'; END IF;
  IF NOT public.has_company_permission(_company_id, 'sales.draft') THEN
    RAISE EXCEPTION 'You do not have permission to delete drafts';
  END IF;

  IF _kind = 'invoice' THEN
    SELECT status::TEXT, posted_journal_id, quote_id INTO _status, _journal, _quote_id
    FROM public.sales_invoices WHERE id = _id AND company_id = _company_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found'; END IF;
    IF _status <> 'draft' OR _journal IS NOT NULL THEN RAISE EXCEPTION 'Only unposted draft invoices can be deleted'; END IF;
    -- Reopen the source quote first (the FK nulls converted_invoice_id on delete).
    IF _quote_id IS NOT NULL THEN
      UPDATE public.sales_quotes
      SET status = 'accepted', converted_invoice_id = NULL, updated_at = now()
      WHERE id = _quote_id AND company_id = _company_id AND converted_invoice_id = _id;
    END IF;
    DELETE FROM public.sales_invoice_lines WHERE invoice_id = _id AND company_id = _company_id;
    DELETE FROM public.sales_invoices WHERE id = _id AND company_id = _company_id;
  ELSIF _kind = 'quote' THEN
    SELECT status::TEXT INTO _status FROM public.sales_quotes
    WHERE id = _id AND company_id = _company_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found'; END IF;
    IF _status NOT IN ('draft', 'declined', 'expired') THEN
      RAISE EXCEPTION 'Only draft, declined or expired quotes can be deleted';
    END IF;
    IF EXISTS (SELECT 1 FROM public.sales_invoices WHERE quote_id = _id) THEN
      RAISE EXCEPTION 'This quote has an invoice and cannot be deleted';
    END IF;
    DELETE FROM public.sales_quote_lines WHERE quote_id = _id AND company_id = _company_id;
    DELETE FROM public.sales_quotes WHERE id = _id AND company_id = _company_id;
  ELSIF _kind = 'credit_note' THEN
    SELECT status::TEXT, posted_journal_id INTO _status, _journal
    FROM public.sales_credit_notes WHERE id = _id AND company_id = _company_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Credit note not found'; END IF;
    IF _status <> 'draft' OR _journal IS NOT NULL THEN RAISE EXCEPTION 'Only unposted draft credit notes can be deleted'; END IF;
    DELETE FROM public.sales_credit_note_lines WHERE credit_note_id = _id AND company_id = _company_id;
    DELETE FROM public.sales_credit_notes WHERE id = _id AND company_id = _company_id;
  ELSE
    RAISE EXCEPTION 'Unknown document kind';
  END IF;

  PERFORM public.record_audit_event(
    _company_id, 'sales.' || _kind || '.draft_deleted', 'sales_' || _kind, _id, '{}'::jsonb
  );
  RETURN jsonb_build_object('deleted', true, 'id', _id);
END;
$$;

REVOKE ALL ON FUNCTION public.unallocate_customer_receipt(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.void_customer_receipt(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.remove_sales_credit_allocation(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.void_sales_credit_note(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.void_sales_invoice(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.delete_draft_sales_document(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unallocate_customer_receipt(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_customer_receipt(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_sales_credit_allocation(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_sales_credit_note(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_sales_invoice(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_draft_sales_document(JSONB) TO authenticated;
