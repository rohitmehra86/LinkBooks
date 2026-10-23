-- Workstream D: VAT/GST returns (TX-01).
-- A return is calculated from document tax lines (never from settlement journals), saved as a draft,
-- then filed. Filing freezes the snapshot. Writes go through the RPCs below, not direct DML.
-- Additive and idempotent. Apply after 20261024130100_fiscal_periods_and_archive.sql.

CREATE TABLE IF NOT EXISTS public.tax_returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  basis text NOT NULL DEFAULT 'accrual',
  jurisdiction_code text,
  status text NOT NULL DEFAULT 'draft',
  -- Counts, warnings and the net tax figure the screen shows. Informational; boxes live in lines.
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  net_tax_minor bigint NOT NULL DEFAULT 0,
  currency_code char(3),
  filed_at timestamptz,
  filed_by uuid,
  settlement_journal_id uuid REFERENCES public.journals(id),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tax_returns_period_check CHECK (period_start <= period_end),
  CONSTRAINT tax_returns_basis_check CHECK (basis IN ('accrual', 'cash')),
  CONSTRAINT tax_returns_status_check CHECK (status IN ('draft', 'filed'))
);

CREATE INDEX IF NOT EXISTS tax_returns_company_period_idx
  ON public.tax_returns (company_id, period_end DESC);

-- At most one filed return may cover any date.
DO $$ BEGIN
  ALTER TABLE public.tax_returns
    ADD CONSTRAINT tax_returns_filed_no_overlap
    EXCLUDE USING gist (
      company_id WITH =,
      daterange(period_start, period_end, '[]') WITH &&
    ) WHERE (status = 'filed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN duplicate_table THEN NULL; -- the exclusion index already exists
  WHEN undefined_object THEN NULL; -- btree_gist missing in some environments
END $$;

CREATE TABLE IF NOT EXISTS public.tax_return_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id uuid NOT NULL REFERENCES public.tax_returns(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  box_key text NOT NULL,
  label text NOT NULL,
  amount_minor bigint NOT NULL,
  sort_order int NOT NULL DEFAULT 0,
  UNIQUE (return_id, box_key)
);

CREATE INDEX IF NOT EXISTS tax_return_lines_return_idx ON public.tax_return_lines (return_id);

ALTER TABLE public.tax_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_return_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view tax returns" ON public.tax_returns;
CREATE POLICY "Members can view tax returns" ON public.tax_returns
  FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

DROP POLICY IF EXISTS "Members can view tax return lines" ON public.tax_return_lines;
CREATE POLICY "Members can view tax return lines" ON public.tax_return_lines
  FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

REVOKE ALL ON public.tax_returns FROM PUBLIC, anon;
REVOKE ALL ON public.tax_return_lines FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.tax_returns FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.tax_return_lines FROM authenticated;
GRANT SELECT ON public.tax_returns TO authenticated;
GRANT SELECT ON public.tax_return_lines TO authenticated;

-- ---------------------------------------------------------------------------
-- Filed returns are frozen. Only the settlement journal link may be set, once.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.protect_filed_tax_return()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'filed' THEN
      RAISE EXCEPTION 'A filed tax return cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'filed' THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.period_start IS DISTINCT FROM OLD.period_start
       OR NEW.period_end IS DISTINCT FROM OLD.period_end
       OR NEW.basis IS DISTINCT FROM OLD.basis
       OR NEW.net_tax_minor IS DISTINCT FROM OLD.net_tax_minor
       OR NEW.summary IS DISTINCT FROM OLD.summary
       OR NEW.filed_at IS DISTINCT FROM OLD.filed_at
       OR (OLD.settlement_journal_id IS NOT NULL
           AND NEW.settlement_journal_id IS DISTINCT FROM OLD.settlement_journal_id) THEN
      RAISE EXCEPTION 'A filed tax return cannot be changed';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_filed_tax_return ON public.tax_returns;
CREATE TRIGGER trg_protect_filed_tax_return
  BEFORE UPDATE OR DELETE ON public.tax_returns
  FOR EACH ROW EXECUTE FUNCTION public.protect_filed_tax_return();

CREATE OR REPLACE FUNCTION public.protect_filed_tax_return_lines()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  _status text;
  _rid uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.return_id ELSE NEW.return_id END;
BEGIN
  SELECT status INTO _status FROM public.tax_returns WHERE id = _rid;
  -- A cascade from deleting a draft return finds no parent row; that is fine.
  IF _status = 'filed' THEN
    RAISE EXCEPTION 'Lines of a filed tax return cannot be changed';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_filed_tax_return_lines ON public.tax_return_lines;
CREATE TRIGGER trg_protect_filed_tax_return_lines
  BEFORE INSERT OR UPDATE OR DELETE ON public.tax_return_lines
  FOR EACH ROW EXECUTE FUNCTION public.protect_filed_tax_return_lines();

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- Shared guard: signed in, member, may prepare tax returns.
CREATE OR REPLACE FUNCTION public.assert_can_manage_tax_returns(_company_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF _company_id IS NULL OR NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT (
    public.has_company_permission(_company_id, 'tax.settings')
    OR public.has_company_permission(_company_id, 'accounting.post')
  ) THEN
    RAISE EXCEPTION 'You do not have permission to prepare tax returns';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_can_manage_tax_returns(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assert_can_manage_tax_returns(uuid) TO authenticated;

-- Create or replace the draft for exactly this period. _lines: [{box_key,label,amount_minor,sort_order}]
CREATE OR REPLACE FUNCTION public.save_tax_return_draft(
  _company_id uuid,
  _period_start date,
  _period_end date,
  _basis text,
  _jurisdiction text,
  _currency text,
  _net_tax_minor bigint,
  _summary jsonb,
  _lines jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _id uuid;
  _line jsonb;
BEGIN
  PERFORM public.assert_can_manage_tax_returns(_company_id);
  IF _period_start IS NULL OR _period_end IS NULL OR _period_start > _period_end THEN
    RAISE EXCEPTION 'Invalid return period';
  END IF;
  IF _basis NOT IN ('accrual', 'cash') THEN RAISE EXCEPTION 'Invalid basis'; END IF;
  IF jsonb_typeof(_lines) <> 'array' THEN RAISE EXCEPTION 'Lines must be an array'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.tax_returns
    WHERE company_id = _company_id AND status = 'filed'
      AND daterange(period_start, period_end, '[]') && daterange(_period_start, _period_end, '[]')
  ) THEN
    RAISE EXCEPTION 'A filed return already covers part of this period';
  END IF;

  SELECT id INTO _id FROM public.tax_returns
  WHERE company_id = _company_id AND status = 'draft'
    AND period_start = _period_start AND period_end = _period_end;

  IF _id IS NULL THEN
    INSERT INTO public.tax_returns (
      company_id, period_start, period_end, basis, jurisdiction_code, status,
      summary, net_tax_minor, currency_code, created_by
    ) VALUES (
      _company_id, _period_start, _period_end, _basis, _jurisdiction, 'draft',
      COALESCE(_summary, '{}'::jsonb), COALESCE(_net_tax_minor, 0), NULLIF(upper(_currency), '')::char(3), auth.uid()
    ) RETURNING id INTO _id;
  ELSE
    UPDATE public.tax_returns
    SET basis = _basis, jurisdiction_code = _jurisdiction, summary = COALESCE(_summary, '{}'::jsonb),
        net_tax_minor = COALESCE(_net_tax_minor, 0), currency_code = NULLIF(upper(_currency), '')::char(3)
    WHERE id = _id;
    DELETE FROM public.tax_return_lines WHERE return_id = _id;
  END IF;

  FOR _line IN SELECT * FROM jsonb_array_elements(_lines) LOOP
    INSERT INTO public.tax_return_lines (return_id, company_id, box_key, label, amount_minor, sort_order)
    VALUES (
      _id, _company_id, _line->>'box_key', _line->>'label',
      (_line->>'amount_minor')::bigint, COALESCE((_line->>'sort_order')::int, 0)
    );
  END LOOP;

  RETURN _id;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_draft_tax_return(_return_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row public.tax_returns%ROWTYPE;
BEGIN
  SELECT * INTO _row FROM public.tax_returns WHERE id = _return_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tax return not found'; END IF;
  PERFORM public.assert_can_manage_tax_returns(_row.company_id);
  IF _row.status <> 'draft' THEN RAISE EXCEPTION 'Only a draft return can be deleted'; END IF;
  DELETE FROM public.tax_returns WHERE id = _return_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.file_tax_return(_return_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row public.tax_returns%ROWTYPE;
BEGIN
  SELECT * INTO _row FROM public.tax_returns WHERE id = _return_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tax return not found'; END IF;
  PERFORM public.assert_can_manage_tax_returns(_row.company_id);
  IF _row.status <> 'draft' THEN RAISE EXCEPTION 'This return is already filed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tax_return_lines WHERE return_id = _return_id) THEN
    RAISE EXCEPTION 'The return has no figures';
  END IF;
  UPDATE public.tax_returns
  SET status = 'filed', filed_at = now(), filed_by = auth.uid()
  WHERE id = _return_id;
  PERFORM public.record_audit_event(
    _row.company_id, 'tax_return.filed', 'tax_return', _return_id,
    jsonb_build_object(
      'period_start', _row.period_start, 'period_end', _row.period_end,
      'basis', _row.basis, 'net_tax_minor', _row.net_tax_minor
    )
  );
END;
$$;

-- Link the (already posted) settlement journal to a filed return, once.
CREATE OR REPLACE FUNCTION public.set_tax_return_settlement(_return_id uuid, _journal_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row public.tax_returns%ROWTYPE;
  _jc uuid;
  _jt public.journal_source_type;
BEGIN
  SELECT * INTO _row FROM public.tax_returns WHERE id = _return_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tax return not found'; END IF;
  PERFORM public.assert_can_manage_tax_returns(_row.company_id);
  IF _row.status <> 'filed' THEN RAISE EXCEPTION 'File the return before settling it'; END IF;
  IF _row.settlement_journal_id IS NOT NULL THEN
    RAISE EXCEPTION 'This return already has a settlement journal';
  END IF;
  SELECT company_id, source_type INTO _jc, _jt FROM public.journals WHERE id = _journal_id;
  IF _jc IS DISTINCT FROM _row.company_id OR _jt IS DISTINCT FROM 'tax_adjustment' THEN
    RAISE EXCEPTION 'The journal is not a tax settlement for this organisation';
  END IF;
  UPDATE public.tax_returns SET settlement_journal_id = _journal_id WHERE id = _return_id;
END;
$$;

DO $$
DECLARE
  _fn text;
BEGIN
  FOREACH _fn IN ARRAY ARRAY[
    'public.save_tax_return_draft(uuid, date, date, text, text, text, bigint, jsonb, jsonb)',
    'public.delete_draft_tax_return(uuid)',
    'public.file_tax_return(uuid)',
    'public.set_tax_return_settlement(uuid, uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', _fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', _fn);
  END LOOP;
END $$;
