-- Wave 2 / E: foreign-currency gains and losses (AR-10) + auto-reversing journals (AC-05).
--
-- 1. Realised FX: when a foreign-currency receipt / supplier payment is allocated to an invoice / bill whose
--    booking rate differs from the settlement rate, one base-currency journal (source 'fx_realised') moves
--    the difference between the AR / AP control account and "Realised FX gains" (7700) / "losses" (7710).
--    Rates are read from the two source journals (the rate each document was actually posted at), so no
--    rate feed is involved. Triggers keep it in step with the allocation lifecycle (allocate, unallocate,
--    void). The journals go through post_journal like everything else.
-- 2. Unrealised FX: preview_fx_revaluation / post_fx_revaluation revalue open foreign AR / AP and foreign
--    bank accounts at MANUAL rates (entered on the screen or stored in exchange_rates; there is no rate
--    feed, a missing rate is an error). One base-currency journal per currency, source 'fx_revaluation',
--    scheduled to reverse on the next day.
-- 3. Auto-reversing journals: journal_auto_reversals + post_auto_reversing_journal +
--    process_due_auto_reversals (user triggered) + process_due_auto_reversals_system (scheduler hook).
--
-- Journals stay immutable; every correction is a reversal. Additive and idempotent.

-- ---------------------------------------------------------------------------
-- Tags: which foreign currency a base-currency FX adjustment journal belongs to
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fx_journal_tags (
  journal_id UUID PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  currency_code CHAR(3) NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('realised', 'revaluation')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fx_journal_tags_company_idx ON public.fx_journal_tags (company_id, currency_code);
ALTER TABLE public.fx_journal_tags ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members view fx journal tags" ON public.fx_journal_tags;
CREATE POLICY "Members view fx journal tags" ON public.fx_journal_tags
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));
GRANT SELECT ON public.fx_journal_tags TO authenticated;

-- ---------------------------------------------------------------------------
-- Realised FX postings (one row per allocation, idempotent)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fx_realised_postings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('sales', 'purchases')),
  allocation_id UUID NOT NULL,
  document_id UUID NOT NULL,
  currency_code CHAR(3) NOT NULL,
  settled_minor BIGINT NOT NULL,
  document_rate NUMERIC(18, 8) NOT NULL,
  settlement_rate NUMERIC(18, 8) NOT NULL,
  gain_loss_base_minor BIGINT NOT NULL,        -- >0 gain, <0 loss, in base-currency minor units
  journal_id UUID,                             -- NULL when the rates gave no difference
  reversal_journal_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reversed_at TIMESTAMPTZ,
  UNIQUE (kind, allocation_id)
);
CREATE INDEX IF NOT EXISTS fx_realised_postings_company_idx ON public.fx_realised_postings (company_id, created_at DESC);
ALTER TABLE public.fx_realised_postings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members view realised fx" ON public.fx_realised_postings;
CREATE POLICY "Members view realised fx" ON public.fx_realised_postings
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));
GRANT SELECT ON public.fx_realised_postings TO authenticated;

-- ---------------------------------------------------------------------------
-- fx_realise_allocation(kind, allocation_id): internal; post the realised FX journal for one allocation.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fx_realise_allocation(_kind TEXT, _alloc_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _company UUID;
  _doc UUID;
  _amt BIGINT;
  _ccy CHAR(3);
  _base CHAR(3);
  _date DATE;
  _settle_j UUID;
  _doc_j UUID;
  _settle_rate NUMERIC;
  _doc_rate NUMERIC;
  _orig BIGINT;
  _settle BIGINT;
  _gl BIGINT;
  _ctrl UUID;
  _fx_acct UUID;
  _jid UUID;
  _existing public.fx_realised_postings%ROWTYPE;
  _lines JSONB;
  _label TEXT;
BEGIN
  SELECT * INTO _existing FROM public.fx_realised_postings WHERE kind = _kind AND allocation_id = _alloc_id;
  IF FOUND THEN RETURN _existing.journal_id; END IF;

  IF _kind = 'sales' THEN
    SELECT a.company_id, a.invoice_id, a.amount_minor, COALESCE(a.allocated_on, r.receipt_date),
           r.posted_journal_id, r.currency_code, i.posted_journal_id
      INTO _company, _doc, _amt, _date, _settle_j, _ccy, _doc_j
    FROM public.sales_receipt_allocations a
    JOIN public.sales_receipts r ON r.id = a.receipt_id AND r.status = 'posted'
    JOIN public.sales_invoices i ON i.id = a.invoice_id
    WHERE a.id = _alloc_id AND a.reversed_on IS NULL;
    _label := 'customer receipt';
  ELSIF _kind = 'purchases' THEN
    SELECT a.company_id, a.bill_id, a.amount_minor, p.payment_date,
           p.posted_journal_id, p.currency_code, b.posted_journal_id
      INTO _company, _doc, _amt, _date, _settle_j, _ccy, _doc_j
    FROM public.supplier_payment_allocations a
    JOIN public.supplier_payments p ON p.id = a.payment_id AND p.status::TEXT = 'paid'
    JOIN public.purchase_bills b ON b.id = a.bill_id
    WHERE a.id = _alloc_id;
    _label := 'supplier payment';
  ELSE
    RAISE EXCEPTION 'Unknown FX allocation kind %', _kind;
  END IF;

  IF _company IS NULL OR _settle_j IS NULL OR _doc_j IS NULL THEN RETURN NULL; END IF;

  SELECT base_currency INTO _base FROM public.companies WHERE id = _company;
  IF upper(_ccy::TEXT) = upper(_base::TEXT) THEN RETURN NULL; END IF;

  SELECT fx_rate_to_base INTO _settle_rate FROM public.journals WHERE id = _settle_j;
  SELECT fx_rate_to_base INTO _doc_rate FROM public.journals WHERE id = _doc_j;
  IF _settle_rate IS NULL OR _doc_rate IS NULL THEN RETURN NULL; END IF;

  _orig := public.fx_to_base_minor(_amt, _doc_rate, _ccy, _base);
  _settle := public.fx_to_base_minor(_amt, _settle_rate, _ccy, _base);
  -- Receipts: receiving more base than booked is a gain. Payments: paying less base than booked is a gain.
  _gl := CASE WHEN _kind = 'sales' THEN _settle - _orig ELSE _orig - _settle END;

  IF _gl = 0 THEN
    INSERT INTO public.fx_realised_postings (
      company_id, kind, allocation_id, document_id, currency_code, settled_minor,
      document_rate, settlement_rate, gain_loss_base_minor, journal_id
    ) VALUES (_company, _kind, _alloc_id, _doc, _ccy, _amt, _doc_rate, _settle_rate, 0, NULL)
    ON CONFLICT (kind, allocation_id) DO NOTHING;
    RETURN NULL;
  END IF;

  _ctrl := public.ledger_control_account(_company, CASE WHEN _kind = 'sales' THEN 'ar' ELSE 'ap' END);
  IF _ctrl IS NULL THEN
    RAISE EXCEPTION 'The % control account is missing, so realised FX cannot be posted', CASE WHEN _kind = 'sales' THEN 'receivables' ELSE 'payables' END;
  END IF;
  _fx_acct := public.ensure_fx_account(_company, CASE WHEN _gl > 0 THEN 'realised_gain' ELSE 'realised_loss' END);

  IF _gl > 0 THEN
    _lines := jsonb_build_array(
      jsonb_build_object('account_id', _ctrl, 'description', 'Realised FX', 'debit_minor', _gl, 'credit_minor', 0),
      jsonb_build_object('account_id', _fx_acct, 'description', 'Realised FX gain', 'debit_minor', 0, 'credit_minor', _gl));
  ELSE
    _lines := jsonb_build_array(
      jsonb_build_object('account_id', _fx_acct, 'description', 'Realised FX loss', 'debit_minor', -_gl, 'credit_minor', 0),
      jsonb_build_object('account_id', _ctrl, 'description', 'Realised FX', 'debit_minor', 0, 'credit_minor', -_gl));
  END IF;

  _jid := public.post_journal(jsonb_build_object(
    'company_id', _company,
    'journal_date', _date,
    'memo', 'Realised FX on ' || _label || ' (' || _ccy || ' booked at ' || _doc_rate::TEXT || ', settled at ' || _settle_rate::TEXT || ')',
    'currency_code', _base,
    'fx_rate_to_base', 1,
    'source_type', 'fx_realised',
    'source_id', _alloc_id,
    'idempotency_key', 'fx_realised:' || _kind || ':' || _alloc_id::TEXT || ':post',
    'lines', _lines
  ));

  INSERT INTO public.fx_journal_tags (journal_id, company_id, currency_code, kind)
  VALUES (_jid, _company, _ccy, 'realised') ON CONFLICT (journal_id) DO NOTHING;

  INSERT INTO public.fx_realised_postings (
    company_id, kind, allocation_id, document_id, currency_code, settled_minor,
    document_rate, settlement_rate, gain_loss_base_minor, journal_id
  ) VALUES (_company, _kind, _alloc_id, _doc, _ccy, _amt, _doc_rate, _settle_rate, _gl, _jid)
  ON CONFLICT (kind, allocation_id) DO NOTHING;

  RETURN _jid;
END;
$$;

REVOKE ALL ON FUNCTION public.fx_realise_allocation(TEXT, UUID) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- fx_reverse_realised(kind, allocation_id, date): internal; reverse the realised FX journal of an allocation.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fx_reverse_realised(_kind TEXT, _alloc_id UUID, _on DATE)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _p public.fx_realised_postings%ROWTYPE;
  _jdate DATE;
  _rev UUID;
BEGIN
  SELECT * INTO _p FROM public.fx_realised_postings
  WHERE kind = _kind AND allocation_id = _alloc_id AND reversed_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF _p.journal_id IS NOT NULL THEN
    SELECT journal_date INTO _jdate FROM public.journals WHERE id = _p.journal_id;
    IF _jdate IS NOT NULL THEN
      _rev := public.reverse_journal_on(
        _p.journal_id, GREATEST(COALESCE(_on, CURRENT_DATE), _jdate),
        'fx_realised:' || _kind || ':' || _alloc_id::TEXT || ':reverse'
      );
    END IF;
  END IF;

  UPDATE public.fx_realised_postings
  SET reversed_at = now(), reversal_journal_id = _rev
  WHERE id = _p.id;
  RETURN _rev;
END;
$$;

REVOKE ALL ON FUNCTION public.fx_reverse_realised(TEXT, UUID, DATE) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Triggers: sales receipt allocations
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_fx_sales_alloc_insert()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.reversed_on IS NULL THEN PERFORM public.fx_realise_allocation('sales', NEW.id); END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_fx_sales_alloc_update()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.reversed_on IS NULL AND NEW.reversed_on IS NOT NULL THEN
    PERFORM public.fx_reverse_realised('sales', NEW.id, NEW.reversed_on);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_fx_alloc_delete(_kind TEXT, _id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Bulk resets (demo reset) run trusted; they remove the journals themselves.
  IF current_setting('linkbooks.trusted', true) = 'on' THEN RETURN; END IF;
  PERFORM public.fx_reverse_realised(_kind, _id, CURRENT_DATE);
END;
$$;
REVOKE ALL ON FUNCTION public.trg_fx_alloc_delete(TEXT, UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.trg_fx_sales_alloc_delete()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.trg_fx_alloc_delete('sales', OLD.id);
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS fx_sales_alloc_insert ON public.sales_receipt_allocations;
CREATE TRIGGER fx_sales_alloc_insert AFTER INSERT ON public.sales_receipt_allocations
  FOR EACH ROW EXECUTE FUNCTION public.trg_fx_sales_alloc_insert();
DROP TRIGGER IF EXISTS fx_sales_alloc_update ON public.sales_receipt_allocations;
CREATE TRIGGER fx_sales_alloc_update AFTER UPDATE OF reversed_on ON public.sales_receipt_allocations
  FOR EACH ROW EXECUTE FUNCTION public.trg_fx_sales_alloc_update();
DROP TRIGGER IF EXISTS fx_sales_alloc_delete ON public.sales_receipt_allocations;
CREATE TRIGGER fx_sales_alloc_delete BEFORE DELETE ON public.sales_receipt_allocations
  FOR EACH ROW EXECUTE FUNCTION public.trg_fx_sales_alloc_delete();

-- ---------------------------------------------------------------------------
-- Triggers: supplier payments (posted with status 'paid', voided with status 'void')
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trg_fx_purchase_payment_update()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _a RECORD;
  _on DATE;
BEGIN
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
  -- Allocating to an already-paid payment (the usual path allocates before it is marked paid).
  IF EXISTS (SELECT 1 FROM public.supplier_payments p WHERE p.id = NEW.payment_id AND p.status::TEXT = 'paid') THEN
    PERFORM public.fx_realise_allocation('purchases', NEW.id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_fx_purchase_alloc_delete()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM public.trg_fx_alloc_delete('purchases', OLD.id);
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS fx_purchase_payment_update ON public.supplier_payments;
CREATE TRIGGER fx_purchase_payment_update AFTER UPDATE OF status, posted_journal_id ON public.supplier_payments
  FOR EACH ROW EXECUTE FUNCTION public.trg_fx_purchase_payment_update();
DROP TRIGGER IF EXISTS fx_purchase_alloc_insert ON public.supplier_payment_allocations;
CREATE TRIGGER fx_purchase_alloc_insert AFTER INSERT ON public.supplier_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION public.trg_fx_purchase_alloc_insert();
DROP TRIGGER IF EXISTS fx_purchase_alloc_delete ON public.supplier_payment_allocations;
CREATE TRIGGER fx_purchase_alloc_delete BEFORE DELETE ON public.supplier_payment_allocations
  FOR EACH ROW EXECUTE FUNCTION public.trg_fx_purchase_alloc_delete();

-- ---------------------------------------------------------------------------
-- Auto-reversing journals (AC-05)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.journal_auto_reversals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  journal_id UUID NOT NULL,
  reverse_on DATE NOT NULL,
  origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'fx_revaluation')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed', 'cancelled')),
  reversal_journal_id UUID,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  UNIQUE (journal_id)
);
CREATE INDEX IF NOT EXISTS journal_auto_reversals_due_idx
  ON public.journal_auto_reversals (company_id, reverse_on) WHERE status IN ('pending', 'failed');
ALTER TABLE public.journal_auto_reversals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members view auto reversals" ON public.journal_auto_reversals;
CREATE POLICY "Members view auto reversals" ON public.journal_auto_reversals
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));
GRANT SELECT ON public.journal_auto_reversals TO authenticated;

-- post_auto_reversing_journal(payload): payload as post_journal plus reverse_on (date after journal_date).
CREATE OR REPLACE FUNCTION public.post_auto_reversing_journal(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _company UUID := NULLIF(payload->>'company_id', '')::UUID;
  _date DATE := NULLIF(payload->>'journal_date', '')::DATE;
  _on DATE := NULLIF(payload->>'reverse_on', '')::DATE;
  _src TEXT := COALESCE(NULLIF(payload->>'source_type', ''), 'manual');
  _jid UUID;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF _company IS NULL THEN RAISE EXCEPTION 'company_id is required'; END IF;
  IF NOT public.is_company_member(_company) THEN RAISE EXCEPTION 'You do not have access to that organisation'; END IF;
  IF NOT (public.has_company_permission(_company, 'accounting.post') OR public.has_company_permission(_company, 'journals.manual')) THEN
    RAISE EXCEPTION 'You do not have permission to post journals';
  END IF;
  IF _date IS NULL THEN RAISE EXCEPTION 'journal_date is required'; END IF;
  IF _on IS NULL THEN RAISE EXCEPTION 'reverse_on is required'; END IF;
  IF _on <= _date THEN RAISE EXCEPTION 'The reversal date must be after the journal date'; END IF;
  IF _src <> 'manual' THEN RAISE EXCEPTION 'Only manual journals can be auto-reversing'; END IF;

  _jid := public.post_journal(payload - 'reverse_on');

  INSERT INTO public.journal_auto_reversals (company_id, journal_id, reverse_on, origin, created_by)
  VALUES (_company, _jid, _on, 'manual', _uid)
  ON CONFLICT (journal_id) DO NOTHING;

  PERFORM public.record_audit_event(_company, 'journal.auto_reverse.scheduled', 'journal', _jid,
    jsonb_build_object('reverse_on', _on));
  RETURN jsonb_build_object('journal_id', _jid, 'reverse_on', _on);
END;
$$;

REVOKE ALL ON FUNCTION public.post_auto_reversing_journal(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_auto_reversing_journal(JSONB) TO authenticated;

-- cancel_auto_reversal(payload{company_id, journal_id})
CREATE OR REPLACE FUNCTION public.cancel_auto_reversal(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _company UUID := NULLIF(payload->>'company_id', '')::UUID;
  _jid UUID := NULLIF(payload->>'journal_id', '')::UUID;
  _row public.journal_auto_reversals%ROWTYPE;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF _company IS NULL OR _jid IS NULL THEN RAISE EXCEPTION 'company_id and journal_id are required'; END IF;
  IF NOT public.is_company_member(_company) THEN RAISE EXCEPTION 'You do not have access to that organisation'; END IF;
  IF NOT (public.has_company_permission(_company, 'accounting.post') OR public.has_company_permission(_company, 'journals.manual')) THEN
    RAISE EXCEPTION 'You do not have permission to change auto-reversals';
  END IF;
  SELECT * INTO _row FROM public.journal_auto_reversals
  WHERE company_id = _company AND journal_id = _jid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'No auto-reversal is scheduled for this journal'; END IF;
  IF _row.status NOT IN ('pending', 'failed') THEN
    RAISE EXCEPTION 'This auto-reversal is already %', _row.status;
  END IF;
  UPDATE public.journal_auto_reversals SET status = 'cancelled', processed_at = now() WHERE id = _row.id;
  PERFORM public.record_audit_event(_company, 'journal.auto_reverse.cancelled', 'journal', _jid, '{}'::jsonb);
  RETURN jsonb_build_object('journal_id', _jid, 'status', 'cancelled');
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_auto_reversal(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_auto_reversal(JSONB) TO authenticated;

-- Internal worker. Runs as the CURRENT auth.uid(); returns {processed, failed, items}.
CREATE OR REPLACE FUNCTION public.process_auto_reversals_worker(_company UUID, _up_to DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _r public.journal_auto_reversals%ROWTYPE;
  _j RECORD;
  _rev UUID;
  _done INTEGER := 0;
  _fail INTEGER := 0;
  _items JSONB := '[]'::jsonb;
BEGIN
  FOR _r IN
    SELECT * FROM public.journal_auto_reversals
    WHERE company_id = _company AND status IN ('pending', 'failed') AND reverse_on <= _up_to
    ORDER BY reverse_on, created_at
    FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      SELECT id, status, reversed_by_journal_id INTO _j FROM public.journals WHERE id = _r.journal_id;
      IF NOT FOUND THEN
        UPDATE public.journal_auto_reversals
        SET status = 'cancelled', last_error = 'The journal no longer exists', processed_at = now() WHERE id = _r.id;
        _items := _items || jsonb_build_array(jsonb_build_object('journal_id', _r.journal_id, 'status', 'cancelled'));
      ELSIF _j.reversed_by_journal_id IS NOT NULL THEN
        UPDATE public.journal_auto_reversals
        SET status = 'done', reversal_journal_id = _j.reversed_by_journal_id,
            last_error = 'Already reversed manually', processed_at = now() WHERE id = _r.id;
        _items := _items || jsonb_build_array(jsonb_build_object('journal_id', _r.journal_id, 'status', 'already_reversed'));
      ELSE
        _rev := public.reverse_journal_on(_r.journal_id, _r.reverse_on, 'auto_reversal:' || _r.journal_id::TEXT);
        UPDATE public.journal_auto_reversals
        SET status = 'done', reversal_journal_id = _rev, last_error = NULL,
            attempts = attempts + 1, processed_at = now() WHERE id = _r.id;
        _done := _done + 1;
        _items := _items || jsonb_build_array(jsonb_build_object(
          'journal_id', _r.journal_id, 'status', 'reversed', 'reversal_journal_id', _rev));
      END IF;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.journal_auto_reversals
      SET status = 'failed', last_error = left(SQLERRM, 500), attempts = attempts + 1 WHERE id = _r.id;
      _fail := _fail + 1;
      _items := _items || jsonb_build_array(jsonb_build_object(
        'journal_id', _r.journal_id, 'status', 'failed', 'error', left(SQLERRM, 300)));
    END;
  END LOOP;
  RETURN jsonb_build_object('processed', _done, 'failed', _fail, 'items', _items);
END;
$$;

REVOKE ALL ON FUNCTION public.process_auto_reversals_worker(UUID, DATE) FROM PUBLIC, anon, authenticated;

-- process_due_auto_reversals(payload{company_id, [up_to_date]}): UI-triggerable.
CREATE OR REPLACE FUNCTION public.process_due_auto_reversals(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _company UUID := NULLIF(payload->>'company_id', '')::UUID;
  _up_to DATE := COALESCE(NULLIF(payload->>'up_to_date', '')::DATE, CURRENT_DATE);
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF _company IS NULL THEN RAISE EXCEPTION 'company_id is required'; END IF;
  IF NOT public.is_company_member(_company) THEN RAISE EXCEPTION 'You do not have access to that organisation'; END IF;
  IF NOT (public.has_company_permission(_company, 'accounting.post') OR public.has_company_permission(_company, 'journals.manual')) THEN
    RAISE EXCEPTION 'You do not have permission to post journals';
  END IF;
  IF _up_to > CURRENT_DATE THEN _up_to := CURRENT_DATE; END IF;
  RETURN public.process_auto_reversals_worker(_company, _up_to);
END;
$$;

REVOKE ALL ON FUNCTION public.process_due_auto_reversals(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.process_due_auto_reversals(JSONB) TO authenticated;

-- Scheduler hook (all companies). NOT callable by app users. A scheduler running as a privileged database
-- role (pg_cron, Supabase scheduled function with the service role) calls it once a day:
--   select public.process_due_auto_reversals_system();
-- Each reversal is posted through post_journal AS the user who scheduled it (their id is set as the
-- request subject for the transaction), so that user must still be an active member with posting rights;
-- otherwise the item is marked 'failed' with the reason and can be retried from Accounting.
CREATE OR REPLACE FUNCTION public.process_due_auto_reversals_system(_up_to DATE DEFAULT CURRENT_DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _c RECORD;
  _res JSONB;
  _done INTEGER := 0;
  _fail INTEGER := 0;
BEGIN
  FOR _c IN
    SELECT DISTINCT r.company_id, r.created_by
    FROM public.journal_auto_reversals r
    WHERE r.status IN ('pending', 'failed') AND r.reverse_on <= _up_to AND r.created_by IS NOT NULL
    ORDER BY r.company_id, r.created_by
  LOOP
    PERFORM set_config('request.jwt.claim.sub', _c.created_by::TEXT, true);
    _res := public.process_auto_reversals_worker(_c.company_id, _up_to);
    _done := _done + COALESCE((_res->>'processed')::INTEGER, 0);
    _fail := _fail + COALESCE((_res->>'failed')::INTEGER, 0);
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  RETURN jsonb_build_object('processed', _done, 'failed', _fail);
END;
$$;

REVOKE ALL ON FUNCTION public.process_due_auto_reversals_system(DATE) FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.process_due_auto_reversals_system(DATE) TO service_role;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Unrealised FX revaluation
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fx_revaluation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  as_of_date DATE NOT NULL,
  seq INTEGER NOT NULL DEFAULT 1,
  rates JSONB NOT NULL DEFAULT '{}'::jsonb,
  journal_ids UUID[] NOT NULL DEFAULT '{}',
  total_gain_minor BIGINT NOT NULL DEFAULT 0,
  total_loss_minor BIGINT NOT NULL DEFAULT 0,
  reverse_on DATE NOT NULL,
  note TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, as_of_date, seq)
);
ALTER TABLE public.fx_revaluation_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members view fx revaluation runs" ON public.fx_revaluation_runs;
CREATE POLICY "Members view fx revaluation runs" ON public.fx_revaluation_runs
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));
GRANT SELECT ON public.fx_revaluation_runs TO authenticated;

-- Internal calculation: returns {lines:[...], missing:[ccy,...]} for open foreign balances as at _as_of.
CREATE OR REPLACE FUNCTION public.fx_revaluation_compute(_company UUID, _as_of DATE, _rates JSONB)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _base CHAR(3);
  _ar UUID := public.ledger_control_account(_company, 'ar');
  _ap UUID := public.ledger_control_account(_company, 'ap');
  _r RECORD;
  _rate NUMERIC;
  _src TEXT;
  _rdate DATE;
  _closing BIGINT;
  _lines JSONB := '[]'::jsonb;
  _missing JSONB := '[]'::jsonb;
  _stale BOOLEAN;
BEGIN
  SELECT base_currency INTO _base FROM public.companies WHERE id = _company;
  IF _base IS NULL THEN RAISE EXCEPTION 'Organisation not found'; END IF;

  FOR _r IN
    WITH x AS (
      SELECT jl.account_id,
             COALESCE(t.currency_code, t2.currency_code, jr.currency_code)::TEXT AS ccy,
             jr.currency_code::TEXT AS jccy,
             jr.fx_rate_to_base AS rate,
             jl.debit_minor, jl.credit_minor
      FROM public.journal_lines jl
      JOIN public.journals jr ON jr.id = jl.journal_id
      LEFT JOIN public.fx_journal_tags t ON t.journal_id = jr.id
      LEFT JOIN public.fx_journal_tags t2 ON t2.journal_id = jr.reverses_journal_id
      WHERE jl.company_id = _company AND jr.status = 'posted' AND jr.journal_date <= _as_of
    )
    SELECT x.account_id, a.code, a.name, x.ccy,
           SUM(CASE WHEN x.jccy = x.ccy THEN x.debit_minor - x.credit_minor ELSE 0 END)::BIGINT AS txn_net,
           SUM(public.fx_to_base_minor(x.debit_minor, x.rate, x.jccy::CHAR(3), _base)
               - public.fx_to_base_minor(x.credit_minor, x.rate, x.jccy::CHAR(3), _base))::BIGINT AS booked
    FROM x
    JOIN public.accounts a ON a.id = x.account_id
    WHERE x.ccy <> upper(_base::TEXT)
      AND (x.account_id IN (_ar, _ap) OR upper(a.currency_code::TEXT) = x.ccy)
    GROUP BY x.account_id, a.code, a.name, x.ccy
    HAVING SUM(CASE WHEN x.jccy = x.ccy THEN x.debit_minor - x.credit_minor ELSE 0 END) <> 0
        OR SUM(public.fx_to_base_minor(x.debit_minor, x.rate, x.jccy::CHAR(3), _base)
               - public.fx_to_base_minor(x.credit_minor, x.rate, x.jccy::CHAR(3), _base)) <> 0
    ORDER BY a.code, x.ccy
  LOOP
    _rate := NULL; _src := NULL; _rdate := NULL;
    IF _rates IS NOT NULL AND NULLIF(_rates->>_r.ccy, '') IS NOT NULL THEN
      _rate := (_rates->>_r.ccy)::NUMERIC;
      IF _rate <= 0 THEN RAISE EXCEPTION 'The exchange rate for % must be positive', _r.ccy; END IF;
      _src := 'manual';
      _rdate := _as_of;
    ELSE
      SELECT e.rate, e.rate_date INTO _rate, _rdate
      FROM public.exchange_rates e
      WHERE e.company_id = _company AND e.from_currency = _r.ccy AND e.to_currency = upper(_base::TEXT)
        AND e.rate_date <= _as_of AND e.voided_at IS NULL
      ORDER BY e.rate_date DESC LIMIT 1;
      IF _rate IS NOT NULL THEN _src := 'exchange_rates'; END IF;
    END IF;

    IF _rate IS NULL THEN
      IF NOT (_missing ? _r.ccy) THEN _missing := _missing || to_jsonb(_r.ccy); END IF;
      _lines := _lines || jsonb_build_array(jsonb_build_object(
        'account_id', _r.account_id, 'account_code', _r.code, 'account_name', _r.name,
        'currency_code', _r.ccy, 'txn_net_minor', _r.txn_net, 'booked_base_minor', _r.booked,
        'rate', NULL, 'rate_source', NULL, 'rate_date', NULL,
        'closing_base_minor', NULL, 'adjustment_minor', NULL, 'stale', FALSE));
    ELSE
      _closing := public.fx_to_base_minor(_r.txn_net, _rate, _r.ccy::CHAR(3), _base);
      _stale := _src = 'exchange_rates' AND _rdate < _as_of - 31;
      _lines := _lines || jsonb_build_array(jsonb_build_object(
        'account_id', _r.account_id, 'account_code', _r.code, 'account_name', _r.name,
        'currency_code', _r.ccy, 'txn_net_minor', _r.txn_net, 'booked_base_minor', _r.booked,
        'rate', _rate, 'rate_source', _src, 'rate_date', _rdate,
        'closing_base_minor', _closing, 'adjustment_minor', _closing - _r.booked, 'stale', _stale));
    END IF;
  END LOOP;

  RETURN jsonb_build_object('base_currency', _base, 'as_of_date', _as_of, 'lines', _lines, 'missing', _missing);
END;
$$;

REVOKE ALL ON FUNCTION public.fx_revaluation_compute(UUID, DATE, JSONB) FROM PUBLIC, anon, authenticated;

-- preview_fx_revaluation(payload{company_id, as_of_date, [rates:{EUR:"1.10"}]})
CREATE OR REPLACE FUNCTION public.preview_fx_revaluation(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _company UUID := NULLIF(payload->>'company_id', '')::UUID;
  _as_of DATE := NULLIF(payload->>'as_of_date', '')::DATE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF _company IS NULL THEN RAISE EXCEPTION 'company_id is required'; END IF;
  IF NOT public.is_company_member(_company) THEN RAISE EXCEPTION 'You do not have access to that organisation'; END IF;
  IF NOT public.has_company_permission(_company, 'accounting.view') THEN
    RAISE EXCEPTION 'You do not have permission to view the ledger';
  END IF;
  IF _as_of IS NULL THEN RAISE EXCEPTION 'as_of_date is required'; END IF;
  RETURN public.fx_revaluation_compute(_company, _as_of, COALESCE(payload->'rates', '{}'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION public.preview_fx_revaluation(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_fx_revaluation(JSONB) TO authenticated;

-- post_fx_revaluation(payload{company_id, as_of_date, [rates], [note]})
--   One base-currency journal per currency, source 'fx_revaluation', each scheduled to auto-reverse on as_of + 1.
CREATE OR REPLACE FUNCTION public.post_fx_revaluation(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _company UUID := NULLIF(payload->>'company_id', '')::UUID;
  _as_of DATE := NULLIF(payload->>'as_of_date', '')::DATE;
  _note TEXT := NULLIF(left(trim(COALESCE(payload->>'note', '')), 300), '');
  _rates JSONB := COALESCE(payload->'rates', '{}'::jsonb);
  _calc JSONB;
  _base CHAR(3);
  _run UUID := gen_random_uuid();
  _seq INTEGER;
  _rev_on DATE;
  _ccy TEXT;
  _l JSONB;
  _lines JSONB;
  _adj BIGINT;
  _debits BIGINT;
  _credits BIGINT;
  _gain BIGINT := 0;
  _loss BIGINT := 0;
  _total_gain BIGINT := 0;
  _total_loss BIGINT := 0;
  _jid UUID;
  _jids UUID[] := '{}';
  _gl_acct UUID;
  _any BOOLEAN := FALSE;
  _prior JSONB;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF _company IS NULL THEN RAISE EXCEPTION 'company_id is required'; END IF;
  IF NOT public.is_company_member(_company) THEN RAISE EXCEPTION 'You do not have access to that organisation'; END IF;
  IF NOT (public.has_company_permission(_company, 'accounting.post') OR public.has_company_permission(_company, 'journals.manual')) THEN
    RAISE EXCEPTION 'You do not have permission to post journals';
  END IF;
  IF _as_of IS NULL THEN RAISE EXCEPTION 'as_of_date is required'; END IF;
  IF _as_of > CURRENT_DATE THEN RAISE EXCEPTION 'Revalue as at today or an earlier date'; END IF;
  _rev_on := _as_of + 1;

  -- Serialise runs per company and clear earlier auto-reversals that are already due, so the balances
  -- being revalued no longer carry a previous revaluation.
  PERFORM 1 FROM public.companies WHERE id = _company FOR UPDATE;
  _prior := public.process_auto_reversals_worker(_company, _as_of);
  IF COALESCE((_prior->>'failed')::INTEGER, 0) > 0 THEN
    RAISE EXCEPTION 'An earlier auto-reversal could not be posted (see Journals > Auto-reversals). Resolve it before revaluing.';
  END IF;

  _calc := public.fx_revaluation_compute(_company, _as_of, _rates);
  IF jsonb_array_length(_calc->'missing') > 0 THEN
    RAISE EXCEPTION 'Enter an exchange rate for: %', (SELECT string_agg(value #>> '{}', ', ') FROM jsonb_array_elements(_calc->'missing'));
  END IF;
  _base := (_calc->>'base_currency')::CHAR(3);

  SELECT COALESCE(max(seq), 0) + 1 INTO _seq
  FROM public.fx_revaluation_runs WHERE company_id = _company AND as_of_date = _as_of;

  FOR _ccy IN
    SELECT DISTINCT l->>'currency_code' FROM jsonb_array_elements(_calc->'lines') l
    WHERE (l->>'adjustment_minor')::BIGINT <> 0 ORDER BY 1
  LOOP
    _lines := '[]'::jsonb; _debits := 0; _credits := 0;
    FOR _l IN SELECT value FROM jsonb_array_elements(_calc->'lines') WHERE value->>'currency_code' = _ccy ORDER BY value->>'account_code'
    LOOP
      _adj := (_l->>'adjustment_minor')::BIGINT;
      CONTINUE WHEN _adj = 0;
      IF _adj > 0 THEN
        _lines := _lines || jsonb_build_array(jsonb_build_object(
          'account_id', _l->>'account_id', 'description', 'Unrealised FX ' || _ccy,
          'debit_minor', _adj, 'credit_minor', 0));
        _debits := _debits + _adj;
      ELSE
        _lines := _lines || jsonb_build_array(jsonb_build_object(
          'account_id', _l->>'account_id', 'description', 'Unrealised FX ' || _ccy,
          'debit_minor', 0, 'credit_minor', -_adj));
        _credits := _credits - _adj;
      END IF;
    END LOOP;

    IF _debits > _credits THEN      -- accounts debited more: unrealised gain
      _gl_acct := public.ensure_fx_account(_company, 'unrealised_gain');
      _lines := _lines || jsonb_build_array(jsonb_build_object(
        'account_id', _gl_acct, 'description', 'Unrealised FX gain ' || _ccy,
        'debit_minor', 0, 'credit_minor', _debits - _credits));
      _gain := _debits - _credits; _loss := 0;
    ELSIF _credits > _debits THEN
      _gl_acct := public.ensure_fx_account(_company, 'unrealised_loss');
      _lines := _lines || jsonb_build_array(jsonb_build_object(
        'account_id', _gl_acct, 'description', 'Unrealised FX loss ' || _ccy,
        'debit_minor', _credits - _debits, 'credit_minor', 0));
      _loss := _credits - _debits; _gain := 0;
    ELSE
      _gain := 0; _loss := 0;
    END IF;

    _jid := public.post_journal(jsonb_build_object(
      'company_id', _company,
      'journal_date', _as_of,
      'memo', 'Unrealised FX revaluation ' || _ccy || ' as at ' || _as_of::TEXT
              || ' (auto-reverses ' || _rev_on::TEXT || ')' || COALESCE(' - ' || _note, ''),
      'currency_code', _base,
      'fx_rate_to_base', 1,
      'source_type', 'fx_revaluation',
      'source_id', _run,
      'idempotency_key', 'fx_reval:' || _run::TEXT || ':' || _ccy,
      'lines', _lines
    ));
    INSERT INTO public.fx_journal_tags (journal_id, company_id, currency_code, kind)
    VALUES (_jid, _company, _ccy::CHAR(3), 'revaluation') ON CONFLICT (journal_id) DO NOTHING;
    INSERT INTO public.journal_auto_reversals (company_id, journal_id, reverse_on, origin, created_by)
    VALUES (_company, _jid, _rev_on, 'fx_revaluation', _uid) ON CONFLICT (journal_id) DO NOTHING;

    _jids := _jids || _jid;
    _total_gain := _total_gain + _gain;
    _total_loss := _total_loss + _loss;
    _any := TRUE;
  END LOOP;

  IF NOT _any THEN
    RETURN jsonb_build_object('posted', FALSE, 'message', 'Nothing to revalue: balances already agree with the rates.', 'journal_ids', '[]'::jsonb);
  END IF;

  INSERT INTO public.fx_revaluation_runs (
    id, company_id, as_of_date, seq, rates, journal_ids, total_gain_minor, total_loss_minor, reverse_on, note, created_by
  ) VALUES (
    _run, _company, _as_of, _seq,
    (SELECT COALESCE(jsonb_object_agg(l->>'currency_code', l->>'rate'), '{}'::jsonb) FROM jsonb_array_elements(_calc->'lines') l),
    _jids, _total_gain, _total_loss, _rev_on, _note, _uid
  );

  PERFORM public.record_audit_event(_company, 'fx.revaluation.posted', 'fx_revaluation_run', _run,
    jsonb_build_object('as_of_date', _as_of, 'journals', cardinality(_jids),
                       'gain_minor', _total_gain, 'loss_minor', _total_loss, 'reverse_on', _rev_on));

  RETURN jsonb_build_object('posted', TRUE, 'run_id', _run, 'journal_ids', to_jsonb(_jids),
                            'total_gain_minor', _total_gain, 'total_loss_minor', _total_loss, 'reverse_on', _rev_on);
END;
$$;

REVOKE ALL ON FUNCTION public.post_fx_revaluation(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_fx_revaluation(JSONB) TO authenticated;
