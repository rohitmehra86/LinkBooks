-- Wave 2 H (operations) — AR-02 remainder: paid / credited / allocated columns and the line tables of
-- posted sales documents can no longer be written by a signed-in client.
--
-- Why now: the SECURITY DEFINER RPCs from 20261024110200..110500 (record_customer_receipt,
-- allocate_sales_credit_note, unallocate / void / remove allocation, save_sales_document_draft) own every
-- legitimate change to these columns. The earlier guard (20261024110600) deliberately left paid / credited
-- writable only because the TypeScript fallbacks needed them. Those fallbacks are removed in the same change.
--
-- How the guards tell a client from an RPC: `current_user`. Inside a SECURITY DEFINER function it is the
-- function owner; for a direct PostgREST write it is `authenticated` (or `anon`). The service role and RPCs
-- are never blocked.
--
-- Also here: a generic "void while refunded" guard. A refund (money document) consumes part of a credit note,
-- a customer receipt or a supplier payment. Voiding the source while the refund stands would leave the
-- ledger and the credit balance disagreeing, so it is rejected until the refund is voided first.
--
-- Additive and idempotent. Requires 20261024110100 / 110600 and 20261022210000_create_new_documents.

-- ---------------------------------------------------------------------------
-- Invoices
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_posted_sales_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN RETURN NEW; END IF;

  -- Paid / credited amounts are derived from allocations. Clients never write them.
  IF NEW.amount_paid_minor IS DISTINCT FROM OLD.amount_paid_minor
     OR NEW.amount_credited_minor IS DISTINCT FROM OLD.amount_credited_minor THEN
    RAISE EXCEPTION 'Paid and credited amounts are maintained by receipts and credit allocations and cannot be edited directly';
  END IF;

  IF OLD.status = 'draft' THEN RETURN NEW; END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'A posted invoice changes status only through receipts, credits, void or delete actions';
  END IF;
  IF NEW.subtotal_minor IS DISTINCT FROM OLD.subtotal_minor
     OR NEW.tax_minor IS DISTINCT FROM OLD.tax_minor
     OR NEW.total_minor IS DISTINCT FROM OLD.total_minor
     OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
     OR NEW.invoice_date IS DISTINCT FROM OLD.invoice_date
     OR NEW.invoice_number IS DISTINCT FROM OLD.invoice_number
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.fx_rate_to_base IS DISTINCT FROM OLD.fx_rate_to_base
     OR NEW.void_journal_id IS DISTINCT FROM OLD.void_journal_id
     OR (NEW.posted_journal_id IS DISTINCT FROM OLD.posted_journal_id
         AND OLD.posted_journal_id IS NOT NULL) THEN
    RAISE EXCEPTION 'A posted invoice cannot be changed. Void it and issue a new one.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sales_invoices_guard_posted ON public.sales_invoices;
CREATE TRIGGER sales_invoices_guard_posted
  BEFORE UPDATE ON public.sales_invoices
  FOR EACH ROW EXECUTE FUNCTION public.guard_posted_sales_invoice();

-- ---------------------------------------------------------------------------
-- Credit notes
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_posted_sales_credit_note()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN RETURN NEW; END IF;

  IF NEW.amount_allocated_minor IS DISTINCT FROM OLD.amount_allocated_minor THEN
    RAISE EXCEPTION 'The applied amount of a credit note is maintained by credit allocations and cannot be edited directly';
  END IF;

  IF OLD.status = 'draft' THEN RETURN NEW; END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'A posted credit note changes status only through allocation, refund or void actions';
  END IF;
  IF NEW.subtotal_minor IS DISTINCT FROM OLD.subtotal_minor
     OR NEW.tax_minor IS DISTINCT FROM OLD.tax_minor
     OR NEW.total_minor IS DISTINCT FROM OLD.total_minor
     OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
     OR NEW.credit_date IS DISTINCT FROM OLD.credit_date
     OR NEW.credit_number IS DISTINCT FROM OLD.credit_number
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.fx_rate_to_base IS DISTINCT FROM OLD.fx_rate_to_base
     OR NEW.void_journal_id IS DISTINCT FROM OLD.void_journal_id
     OR (NEW.posted_journal_id IS DISTINCT FROM OLD.posted_journal_id
         AND OLD.posted_journal_id IS NOT NULL) THEN
    RAISE EXCEPTION 'A posted credit note cannot be changed. Void it and issue a new one.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sales_credit_notes_guard_posted ON public.sales_credit_notes;
CREATE TRIGGER sales_credit_notes_guard_posted
  BEFORE UPDATE ON public.sales_credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.guard_posted_sales_credit_note();

-- ---------------------------------------------------------------------------
-- Receipts: only the reference and memo are client-editable once saved.
-- (INSERT stays open: the Demo seed inserts through the signed-in client.)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_sales_receipt_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN RETURN NEW; END IF;
  IF NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
     OR NEW.unallocated_minor IS DISTINCT FROM OLD.unallocated_minor
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.bank_account_id IS DISTINCT FROM OLD.bank_account_id
     OR NEW.receipt_date IS DISTINCT FROM OLD.receipt_date
     OR NEW.fx_rate_to_base IS DISTINCT FROM OLD.fx_rate_to_base
     OR NEW.void_journal_id IS DISTINCT FROM OLD.void_journal_id
     OR (NEW.posted_journal_id IS DISTINCT FROM OLD.posted_journal_id
         AND OLD.posted_journal_id IS NOT NULL) THEN
    RAISE EXCEPTION 'A saved receipt can only have its reference or memo edited. Void it and record a new one.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sales_receipts_guard_update ON public.sales_receipts;
CREATE TRIGGER sales_receipts_guard_update
  BEFORE UPDATE ON public.sales_receipts
  FOR EACH ROW EXECUTE FUNCTION public.guard_sales_receipt_update();

-- ---------------------------------------------------------------------------
-- Line tables: no client writes once the parent document is linked to a journal.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_posted_sales_lines()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  _parent_id UUID;
  _posted BOOLEAN;
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_TABLE_NAME = 'sales_invoice_lines' THEN
    _parent_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.invoice_id ELSE NEW.invoice_id END;
    SELECT (status <> 'draft' AND posted_journal_id IS NOT NULL) INTO _posted
    FROM public.sales_invoices WHERE id = _parent_id;
  ELSE
    _parent_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.credit_note_id ELSE NEW.credit_note_id END;
    SELECT (status <> 'draft' AND posted_journal_id IS NOT NULL) INTO _posted
    FROM public.sales_credit_notes WHERE id = _parent_id;
  END IF;

  IF COALESCE(_posted, FALSE) THEN
    RAISE EXCEPTION 'Lines of a posted document cannot be changed. Void the document and issue a new one.';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS sales_invoice_lines_guard_posted ON public.sales_invoice_lines;
CREATE TRIGGER sales_invoice_lines_guard_posted
  BEFORE INSERT OR UPDATE OR DELETE ON public.sales_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION public.guard_posted_sales_lines();

DROP TRIGGER IF EXISTS sales_credit_note_lines_guard_posted ON public.sales_credit_note_lines;
CREATE TRIGGER sales_credit_note_lines_guard_posted
  BEFORE INSERT OR UPDATE OR DELETE ON public.sales_credit_note_lines
  FOR EACH ROW EXECUTE FUNCTION public.guard_posted_sales_lines();

-- ---------------------------------------------------------------------------
-- Allocation rows are written only by RPCs (UPDATE / DELETE blocked for clients).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_sales_allocation_rows()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  RAISE EXCEPTION 'Allocations are managed by receipt and credit actions and cannot be edited directly';
END;
$$;

DROP TRIGGER IF EXISTS sales_receipt_allocations_guard ON public.sales_receipt_allocations;
CREATE TRIGGER sales_receipt_allocations_guard
  BEFORE UPDATE OR DELETE ON public.sales_receipt_allocations
  FOR EACH ROW EXECUTE FUNCTION public.guard_sales_allocation_rows();

DROP TRIGGER IF EXISTS sales_credit_allocations_guard ON public.sales_credit_allocations;
CREATE TRIGGER sales_credit_allocations_guard
  BEFORE UPDATE OR DELETE ON public.sales_credit_allocations
  FOR EACH ROW EXECUTE FUNCTION public.guard_sales_allocation_rows();

-- ---------------------------------------------------------------------------
-- Void while a refund stands (all roles, including RPCs): the refund must be voided first.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_void_when_refunded()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  _kind TEXT;
BEGIN
  IF NEW.status::TEXT <> 'void' OR OLD.status::TEXT = 'void' THEN RETURN NEW; END IF;
  _kind := CASE TG_TABLE_NAME
    WHEN 'sales_credit_notes' THEN 'sales_credit_note'
    WHEN 'purchase_credit_notes' THEN 'purchase_credit_note'
    WHEN 'sales_receipts' THEN 'sales_receipt'
    WHEN 'supplier_payments' THEN 'supplier_payment'
    ELSE NULL
  END;
  IF _kind IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.money_document_credit_uses u
    JOIN public.money_documents d ON d.id = u.document_id
    WHERE u.source_kind = _kind AND u.source_id = NEW.id AND d.status <> 'void'
  ) THEN
    RAISE EXCEPTION 'This document has been refunded. Void the refund first.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sales_credit_notes_void_refund_guard ON public.sales_credit_notes;
CREATE TRIGGER sales_credit_notes_void_refund_guard
  BEFORE UPDATE OF status ON public.sales_credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.guard_void_when_refunded();

DROP TRIGGER IF EXISTS purchase_credit_notes_void_refund_guard ON public.purchase_credit_notes;
CREATE TRIGGER purchase_credit_notes_void_refund_guard
  BEFORE UPDATE OF status ON public.purchase_credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.guard_void_when_refunded();

DROP TRIGGER IF EXISTS sales_receipts_void_refund_guard ON public.sales_receipts;
CREATE TRIGGER sales_receipts_void_refund_guard
  BEFORE UPDATE OF status ON public.sales_receipts
  FOR EACH ROW EXECUTE FUNCTION public.guard_void_when_refunded();

DROP TRIGGER IF EXISTS supplier_payments_void_refund_guard ON public.supplier_payments;
CREATE TRIGGER supplier_payments_void_refund_guard
  BEFORE UPDATE OF status ON public.supplier_payments
  FOR EACH ROW EXECUTE FUNCTION public.guard_void_when_refunded();
