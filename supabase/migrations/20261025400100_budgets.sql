-- Wave 2 / I: budgets.
--
-- A budget covers one fiscal year (12 months from fiscal_year_start) with one amount per income or
-- expense account per month, in the company base currency, as integer minor units. Budgets never
-- touch the ledger. Writes go only through the SECURITY DEFINER RPCs below (no INSERT / UPDATE /
-- DELETE policies for clients); members can read.
--
--   save_budget(company, budget|null, name, fiscal_year_start, notes)  -> budget id
--   save_budget_lines(budget, lines jsonb, mode 'replace'|'merge')      -> number of lines stored
--   delete_budget(budget)
--
-- Permission: accounts.manage (owner, admin, accountant) — the same people who maintain the chart.
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS public.budgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  fiscal_year_start DATE NOT NULL,
  notes TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT budgets_name_len CHECK (char_length(trim(name)) BETWEEN 1 AND 120),
  CONSTRAINT budgets_fy_first_of_month CHECK (EXTRACT(DAY FROM fiscal_year_start) = 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS budgets_company_name_year_uidx
  ON public.budgets (company_id, lower(name), fiscal_year_start);
CREATE INDEX IF NOT EXISTS budgets_company_year_idx
  ON public.budgets (company_id, fiscal_year_start DESC);

CREATE TABLE IF NOT EXISTS public.budget_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  budget_id UUID NOT NULL REFERENCES public.budgets(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  period_month DATE NOT NULL,
  amount_minor BIGINT NOT NULL,
  CONSTRAINT budget_lines_month_first CHECK (EXTRACT(DAY FROM period_month) = 1),
  CONSTRAINT budget_lines_unique UNIQUE (budget_id, account_id, period_month)
);

CREATE INDEX IF NOT EXISTS budget_lines_company_idx ON public.budget_lines (company_id, budget_id);
CREATE INDEX IF NOT EXISTS budget_lines_account_idx ON public.budget_lines (account_id);

ALTER TABLE public.budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budget_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view budgets" ON public.budgets;
CREATE POLICY "Members can view budgets"
  ON public.budgets FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

DROP POLICY IF EXISTS "Members can view budget lines" ON public.budget_lines;
CREATE POLICY "Members can view budget lines"
  ON public.budget_lines FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

REVOKE ALL ON public.budgets, public.budget_lines FROM PUBLIC, anon;
GRANT SELECT ON public.budgets, public.budget_lines TO authenticated;

-- ---------------------------------------------------------------------------
-- save_budget: create or rename a budget. The fiscal year cannot move once lines exist.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_budget(
  _company_id UUID,
  _budget_id UUID,
  _name TEXT,
  _fiscal_year_start DATE,
  _notes TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _fy DATE;
  _n TEXT := NULLIF(trim(COALESCE(_name, '')), '');
  _b RECORD;
  _id UUID;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF _company_id IS NULL THEN RAISE EXCEPTION 'Organisation is required'; END IF;
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT public.has_company_permission(_company_id, 'accounts.manage') THEN
    RAISE EXCEPTION 'You do not have permission to manage budgets';
  END IF;
  IF _n IS NULL OR char_length(_n) > 120 THEN
    RAISE EXCEPTION 'Budget name must be 1 to 120 characters';
  END IF;
  IF _fiscal_year_start IS NULL THEN RAISE EXCEPTION 'Fiscal year start is required'; END IF;
  _fy := date_trunc('month', _fiscal_year_start)::DATE;

  IF _budget_id IS NULL THEN
    INSERT INTO public.budgets (company_id, name, fiscal_year_start, notes, created_by)
    VALUES (_company_id, _n, _fy, NULLIF(trim(COALESCE(_notes, '')), ''), _uid)
    RETURNING id INTO _id;
    PERFORM public.record_audit_event(_company_id, 'budget.created', 'budget', _id,
      jsonb_build_object('name', _n, 'fiscal_year_start', _fy));
    RETURN _id;
  END IF;

  SELECT * INTO _b FROM public.budgets WHERE id = _budget_id AND company_id = _company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Budget not found'; END IF;
  IF _b.fiscal_year_start <> _fy AND EXISTS (SELECT 1 FROM public.budget_lines WHERE budget_id = _budget_id) THEN
    RAISE EXCEPTION 'The fiscal year cannot change once the budget has amounts. Copy it to a new budget instead.';
  END IF;
  UPDATE public.budgets
  SET name = _n, fiscal_year_start = _fy, notes = NULLIF(trim(COALESCE(_notes, '')), ''), updated_at = now()
  WHERE id = _budget_id;
  PERFORM public.record_audit_event(_company_id, 'budget.updated', 'budget', _budget_id,
    jsonb_build_object('name', _n, 'fiscal_year_start', _fy));
  RETURN _budget_id;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'A budget with that name already exists for this fiscal year';
END;
$$;

REVOKE ALL ON FUNCTION public.save_budget(UUID, UUID, TEXT, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_budget(UUID, UUID, TEXT, DATE, TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- save_budget_lines: _lines = [{account_id, period_month, amount_minor}, ...]
--   replace: the budget ends up with exactly these lines (zero amounts are dropped)
--   merge:   upsert these lines; a zero amount removes that cell
-- Everything is validated before anything is written; the whole call is one transaction.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_budget_lines(
  _budget_id UUID,
  _lines JSONB,
  _mode TEXT DEFAULT 'replace'
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _b RECORD;
  _l JSONB;
  _acc UUID;
  _month DATE;
  _amt BIGINT;
  _seen TEXT[] := ARRAY[]::TEXT[];
  _key TEXT;
  _type public.account_type;
  _stored INT := 0;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF _mode NOT IN ('replace', 'merge') THEN RAISE EXCEPTION 'Mode must be replace or merge'; END IF;
  IF _lines IS NULL OR jsonb_typeof(_lines) <> 'array' THEN
    RAISE EXCEPTION 'Lines must be a JSON array';
  END IF;
  IF jsonb_array_length(_lines) > 20000 THEN RAISE EXCEPTION 'Too many budget lines in one save'; END IF;

  SELECT * INTO _b FROM public.budgets WHERE id = _budget_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Budget not found'; END IF;
  IF NOT public.is_company_member(_b.company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT public.has_company_permission(_b.company_id, 'accounts.manage') THEN
    RAISE EXCEPTION 'You do not have permission to manage budgets';
  END IF;

  -- Validate every line first.
  FOR _l IN SELECT value FROM jsonb_array_elements(_lines)
  LOOP
    BEGIN
      _acc := (_l->>'account_id')::UUID;
      _month := (_l->>'period_month')::DATE;
      IF jsonb_typeof(_l->'amount_minor') <> 'number' OR (_l->>'amount_minor') !~ '^-?[0-9]+$' THEN
        RAISE EXCEPTION 'amount_minor must be a whole number of minor units';
      END IF;
      _amt := (_l->>'amount_minor')::BIGINT;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow THEN
      RAISE EXCEPTION 'A budget line has an invalid account, month or amount';
    END;
    IF _acc IS NULL OR _month IS NULL THEN RAISE EXCEPTION 'A budget line is missing its account or month'; END IF;
    IF EXTRACT(DAY FROM _month) <> 1 THEN RAISE EXCEPTION 'Budget months must start on the 1st (%).', _month; END IF;
    IF _month < _b.fiscal_year_start OR _month >= (_b.fiscal_year_start + INTERVAL '12 months')::DATE THEN
      RAISE EXCEPTION 'Month % is outside this budget''s fiscal year', _month;
    END IF;
    IF abs(_amt) > 900000000000000 THEN RAISE EXCEPTION 'Budget amount is too large'; END IF;
    _key := _acc::TEXT || '|' || _month::TEXT;
    IF _key = ANY(_seen) THEN RAISE EXCEPTION 'Duplicate budget line for account % and month %', _acc, _month; END IF;
    _seen := _seen || _key;

    SELECT account_type INTO _type FROM public.accounts
    WHERE id = _acc AND company_id = _b.company_id AND is_active AND archived_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'Account % is not an active account of this organisation', _acc; END IF;
    IF _type NOT IN ('income', 'expense') THEN
      RAISE EXCEPTION 'Budgets can only be set on income and expense accounts';
    END IF;
  END LOOP;

  IF _mode = 'replace' THEN
    DELETE FROM public.budget_lines WHERE budget_id = _budget_id;
  END IF;

  FOR _l IN SELECT value FROM jsonb_array_elements(_lines)
  LOOP
    _acc := (_l->>'account_id')::UUID;
    _month := (_l->>'period_month')::DATE;
    _amt := (_l->>'amount_minor')::BIGINT;
    IF _amt = 0 THEN
      DELETE FROM public.budget_lines WHERE budget_id = _budget_id AND account_id = _acc AND period_month = _month;
    ELSE
      INSERT INTO public.budget_lines (budget_id, company_id, account_id, period_month, amount_minor)
      VALUES (_budget_id, _b.company_id, _acc, _month, _amt)
      ON CONFLICT (budget_id, account_id, period_month) DO UPDATE SET amount_minor = EXCLUDED.amount_minor;
      _stored := _stored + 1;
    END IF;
  END LOOP;

  UPDATE public.budgets SET updated_at = now() WHERE id = _budget_id;
  PERFORM public.record_audit_event(_b.company_id, 'budget.lines_saved', 'budget', _budget_id,
    jsonb_build_object('mode', _mode, 'lines', _stored));
  RETURN _stored;
END;
$$;

REVOKE ALL ON FUNCTION public.save_budget_lines(UUID, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_budget_lines(UUID, JSONB, TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- delete_budget
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_budget(_budget_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _b RECORD;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  SELECT * INTO _b FROM public.budgets WHERE id = _budget_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Budget not found'; END IF;
  IF NOT public.is_company_member(_b.company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT public.has_company_permission(_b.company_id, 'accounts.manage') THEN
    RAISE EXCEPTION 'You do not have permission to manage budgets';
  END IF;
  DELETE FROM public.budgets WHERE id = _budget_id;
  PERFORM public.record_audit_event(_b.company_id, 'budget.deleted', 'budget', _budget_id,
    jsonb_build_object('name', _b.name, 'fiscal_year_start', _b.fiscal_year_start));
END;
$$;

REVOKE ALL ON FUNCTION public.delete_budget(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_budget(UUID) TO authenticated;
