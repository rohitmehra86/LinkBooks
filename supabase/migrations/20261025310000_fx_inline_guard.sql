-- Integration of wave 2 E (separate realised-FX journals via allocation triggers) with wave 2 H
-- (record_supplier_payment posts the realised FX inside the payment journal).
-- ops_record_supplier_payment sets the transaction-local flag linkbooks.fx_inline = 'on'; the two
-- purchase triggers below then skip, so a supplier payment never gets its FX posted twice.
-- Payments created any other way (no flag) keep the trigger behaviour. Idempotent.

CREATE OR REPLACE FUNCTION public.trg_fx_purchase_payment_update()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _a RECORD;
  _on DATE;
BEGIN
  IF current_setting('linkbooks.fx_inline', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF NEW.status::TEXT = 'paid' AND NEW.posted_journal_id IS NOT NULL
     AND (OLD.status::TEXT IS DISTINCT FROM 'paid' OR OLD.posted_journal_id IS DISTINCT FROM NEW.posted_journal_id) THEN
    FOR _a IN SELECT id FROM public.supplier_payment_allocations WHERE payment_id = NEW.id ORDER BY id LOOP
      PERFORM public.fx_realise_allocation('purchases', _a.id);
    END LOOP;
  ELSIF NEW.status::TEXT = 'void' AND OLD.status::TEXT IS DISTINCT FROM 'void' THEN
    SELECT rj.journal_date INTO _on
    FROM public.journals pj JOIN public.journals rj ON rj.id = pj.reversed_by_journal_id
    WHERE pj.id = NEW.posted_journal_id;
    FOR _a IN SELECT id FROM public.supplier_payment_allocations WHERE payment_id = NEW.id ORDER BY id LOOP
      PERFORM public.fx_reverse_realised('purchases', _a.id, COALESCE(_on, CURRENT_DATE));
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_fx_purchase_alloc_insert()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF current_setting('linkbooks.fx_inline', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.supplier_payments p WHERE p.id = NEW.payment_id AND p.status::TEXT = 'paid') THEN
    PERFORM public.fx_realise_allocation('purchases', NEW.id);
  END IF;
  RETURN NEW;
END;
$$;
