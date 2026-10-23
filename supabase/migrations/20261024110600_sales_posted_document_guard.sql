-- Sales / AR (AR-02, partial): posted documents are immutable from direct client writes.
-- The UPDATE policies on sales_invoices / sales_credit_notes allow anyone with sales.draft to change any
-- column. These triggers stop a signed-in client from rewriting the amounts, dates, number, currency or
-- journal link of a document that is no longer a draft, and from moving a posted document back to draft.
-- SECURITY DEFINER RPCs (current_user = owner) and the service role are not affected, so the app's own
-- posting, void and allocation paths keep working. Paid / credited amounts stay writable because the
-- TypeScript fallback paths (used only while the RPC migrations are not applied) update them directly.
-- Additive and idempotent.

CREATE OR REPLACE FUNCTION public.guard_posted_sales_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN RETURN NEW; END IF;
  IF OLD.status = 'draft' THEN RETURN NEW; END IF;
  IF NEW.status = 'draft' THEN
    RAISE EXCEPTION 'A posted invoice cannot be moved back to draft';
  END IF;
  IF NEW.subtotal_minor IS DISTINCT FROM OLD.subtotal_minor
     OR NEW.tax_minor IS DISTINCT FROM OLD.tax_minor
     OR NEW.total_minor IS DISTINCT FROM OLD.total_minor
     OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
     OR NEW.invoice_date IS DISTINCT FROM OLD.invoice_date
     OR NEW.invoice_number IS DISTINCT FROM OLD.invoice_number
     OR NEW.posted_journal_id IS DISTINCT FROM OLD.posted_journal_id THEN
    RAISE EXCEPTION 'A posted invoice cannot be changed. Void it and issue a new one.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sales_invoices_guard_posted ON public.sales_invoices;
CREATE TRIGGER sales_invoices_guard_posted
  BEFORE UPDATE ON public.sales_invoices
  FOR EACH ROW EXECUTE FUNCTION public.guard_posted_sales_invoice();

CREATE OR REPLACE FUNCTION public.guard_posted_sales_credit_note()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user NOT IN ('authenticated', 'anon') THEN RETURN NEW; END IF;
  IF OLD.status = 'draft' THEN RETURN NEW; END IF;
  IF NEW.status = 'draft' THEN
    RAISE EXCEPTION 'A posted credit note cannot be moved back to draft';
  END IF;
  IF NEW.subtotal_minor IS DISTINCT FROM OLD.subtotal_minor
     OR NEW.tax_minor IS DISTINCT FROM OLD.tax_minor
     OR NEW.total_minor IS DISTINCT FROM OLD.total_minor
     OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
     OR NEW.credit_date IS DISTINCT FROM OLD.credit_date
     OR NEW.credit_number IS DISTINCT FROM OLD.credit_number
     OR NEW.posted_journal_id IS DISTINCT FROM OLD.posted_journal_id THEN
    RAISE EXCEPTION 'A posted credit note cannot be changed. Void it and issue a new one.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sales_credit_notes_guard_posted ON public.sales_credit_notes;
CREATE TRIGGER sales_credit_notes_guard_posted
  BEFORE UPDATE ON public.sales_credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.guard_posted_sales_credit_note();
