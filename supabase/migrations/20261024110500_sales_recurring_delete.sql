-- Sales / AR: delete a recurring invoice template that has never generated anything (AR-15).
-- Additive and idempotent. There is no DELETE policy on sales_recurring_invoices, so the client cannot
-- delete directly; this SECURITY DEFINER function is the only path and only allows never-run templates.
-- Templates that have generated invoices must be deactivated instead so history stays intact.

CREATE OR REPLACE FUNCTION public.delete_sales_recurring_invoice(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _company_id UUID;
  _id UUID;
  _row RECORD;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  _company_id := NULLIF(payload->>'company_id', '')::UUID;
  _id := NULLIF(payload->>'recurring_id', '')::UUID;
  IF _company_id IS NULL OR _id IS NULL THEN
    RAISE EXCEPTION 'company_id and recurring_id are required';
  END IF;
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT public.has_company_permission(_company_id, 'sales.draft') THEN
    RAISE EXCEPTION 'You do not have permission to delete recurring invoices';
  END IF;

  SELECT * INTO _row FROM public.sales_recurring_invoices
  WHERE id = _id AND company_id = _company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Recurring invoice not found'; END IF;
  IF _row.last_generated_on IS NOT NULL OR _row.last_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'This recurring invoice has already generated invoices — deactivate it instead of deleting';
  END IF;

  -- Stop the v2 scheduler from running an orphaned template (the FK only nulls the legacy link).
  IF to_regclass('public.recurring_templates') IS NOT NULL
     AND to_regclass('public.recurring_schedules') IS NOT NULL THEN
    UPDATE public.recurring_schedules s
    SET is_paused = true
    FROM public.recurring_templates t
    WHERE s.template_id = t.id AND t.legacy_sales_recurring_invoice_id = _id;
    UPDATE public.recurring_templates
    SET is_active = false
    WHERE legacy_sales_recurring_invoice_id = _id;
  END IF;

  DELETE FROM public.sales_recurring_invoice_lines WHERE recurring_id = _id AND company_id = _company_id;
  DELETE FROM public.sales_recurring_invoices WHERE id = _id AND company_id = _company_id;

  PERFORM public.record_audit_event(
    _company_id, 'sales.recurring.deleted', 'sales_recurring_invoice', _id, '{}'::jsonb
  );
  RETURN jsonb_build_object('deleted', true, 'id', _id);
END;
$$;

REVOKE ALL ON FUNCTION public.delete_sales_recurring_invoice(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_sales_recurring_invoice(JSONB) TO authenticated;
