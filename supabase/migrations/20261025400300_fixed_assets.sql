-- Wave 2 / I: fixed-asset register, monthly depreciation and disposal.
--
-- Requires 20261025400200 (journal source types 'depreciation' / 'asset_disposal').
--
-- Rules
--  * Every ledger entry goes through public.post_journal (period status, lock dates, active and
--    postable accounts, balanced lines, audit). Nothing here inserts into journals directly.
--  * Registering an asset does NOT post anything: the purchase is already in the ledger (bill,
--    expense or journal). The register records what to depreciate and where.
--  * Depreciation runs are monthly, idempotent per asset + period (unique entry, depreciated_through
--    and row locks), previewable, and strictly sequential per asset so the schedule is exact.
--  * All amounts are integer minor units in the company base currency.
--  * Clients can only read the tables (RLS); every write is a SECURITY DEFINER RPC that checks
--    auth.uid(), company membership and permission (accounts.manage to maintain the register;
--    accounting.post or journals.manual to post depreciation / disposals, like post_journal).
--
-- Additive and idempotent.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.asset_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  depreciation_method TEXT NOT NULL DEFAULT 'straight_line'
    CHECK (depreciation_method IN ('straight_line', 'reducing_balance', 'none')),
  useful_life_months INTEGER CHECK (useful_life_months IS NULL OR (useful_life_months BETWEEN 1 AND 1200)),
  annual_rate_bps INTEGER CHECK (annual_rate_bps IS NULL OR (annual_rate_bps BETWEEN 1 AND 10000)),
  asset_account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  accumulated_account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  expense_account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT asset_types_name_len CHECK (char_length(trim(name)) BETWEEN 1 AND 120)
);
CREATE UNIQUE INDEX IF NOT EXISTS asset_types_company_name_uidx
  ON public.asset_types (company_id, lower(name));

CREATE TABLE IF NOT EXISTS public.fixed_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  asset_type_id UUID REFERENCES public.asset_types(id) ON DELETE SET NULL,
  asset_number TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  notes TEXT,
  purchase_date DATE NOT NULL,
  depreciation_start_date DATE NOT NULL,
  cost_minor BIGINT NOT NULL CHECK (cost_minor > 0 AND cost_minor <= 900000000000000),
  residual_minor BIGINT NOT NULL DEFAULT 0 CHECK (residual_minor >= 0),
  opening_accumulated_minor BIGINT NOT NULL DEFAULT 0 CHECK (opening_accumulated_minor >= 0),
  depreciation_method TEXT NOT NULL
    CHECK (depreciation_method IN ('straight_line', 'reducing_balance', 'none')),
  useful_life_months INTEGER CHECK (useful_life_months IS NULL OR (useful_life_months BETWEEN 1 AND 1200)),
  annual_rate_bps INTEGER CHECK (annual_rate_bps IS NULL OR (annual_rate_bps BETWEEN 1 AND 10000)),
  asset_account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  accumulated_account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  expense_account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disposed')),
  depreciated_through DATE,
  source_bill_id UUID REFERENCES public.purchase_bills(id) ON DELETE SET NULL,
  source_bill_line_id UUID REFERENCES public.purchase_bill_lines(id) ON DELETE SET NULL,
  disposal_date DATE,
  disposal_proceeds_minor BIGINT CHECK (disposal_proceeds_minor IS NULL OR disposal_proceeds_minor >= 0),
  disposal_journal_id UUID REFERENCES public.journals(id) ON DELETE RESTRICT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fixed_assets_name_len CHECK (char_length(trim(name)) BETWEEN 1 AND 160),
  CONSTRAINT fixed_assets_residual_le_cost CHECK (residual_minor + opening_accumulated_minor <= cost_minor),
  CONSTRAINT fixed_assets_start_not_before_purchase CHECK (depreciation_start_date >= purchase_date),
  CONSTRAINT fixed_assets_disposed_has_date CHECK (status <> 'disposed' OR disposal_date IS NOT NULL),
  CONSTRAINT fixed_assets_number_uniq UNIQUE (company_id, asset_number)
);
CREATE INDEX IF NOT EXISTS fixed_assets_company_status_idx ON public.fixed_assets (company_id, status);
CREATE INDEX IF NOT EXISTS fixed_assets_bill_line_idx ON public.fixed_assets (source_bill_line_id)
  WHERE source_bill_line_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.asset_depreciation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  period_end DATE NOT NULL,
  journal_id UUID REFERENCES public.journals(id) ON DELETE RESTRICT,
  total_minor BIGINT NOT NULL DEFAULT 0,
  asset_count INTEGER NOT NULL DEFAULT 0,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS asset_depreciation_runs_company_idx
  ON public.asset_depreciation_runs (company_id, period_end DESC);

CREATE TABLE IF NOT EXISTS public.asset_depreciation_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  asset_id UUID NOT NULL REFERENCES public.fixed_assets(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES public.asset_depreciation_runs(id) ON DELETE CASCADE,
  period_end DATE NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  journal_id UUID NOT NULL REFERENCES public.journals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT asset_depreciation_entries_once UNIQUE (asset_id, period_end)
);
CREATE INDEX IF NOT EXISTS asset_depreciation_entries_company_idx
  ON public.asset_depreciation_entries (company_id, period_end);

ALTER TABLE public.asset_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fixed_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asset_depreciation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asset_depreciation_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view asset types" ON public.asset_types;
CREATE POLICY "Members can view asset types" ON public.asset_types
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));
DROP POLICY IF EXISTS "Members can view fixed assets" ON public.fixed_assets;
CREATE POLICY "Members can view fixed assets" ON public.fixed_assets
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));
DROP POLICY IF EXISTS "Members can view depreciation runs" ON public.asset_depreciation_runs;
CREATE POLICY "Members can view depreciation runs" ON public.asset_depreciation_runs
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));
DROP POLICY IF EXISTS "Members can view depreciation entries" ON public.asset_depreciation_entries;
CREATE POLICY "Members can view depreciation entries" ON public.asset_depreciation_entries
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));

REVOKE ALL ON public.asset_types, public.fixed_assets,
  public.asset_depreciation_runs, public.asset_depreciation_entries FROM PUBLIC, anon;
GRANT SELECT ON public.asset_types, public.fixed_assets,
  public.asset_depreciation_runs, public.asset_depreciation_entries TO authenticated;

-- ---------------------------------------------------------------------------
-- fa_month_amount: depreciation for one month. Pure; mirrors src/lib/fixed-assets/depreciation.ts.
--   month index _k is 1 for the month containing the depreciation start date.
--   _posted is what has been depreciated since the start date (excludes opening accumulated).
--   straight line: round(base / life) a month, the last month takes the remainder.
--   reducing balance: round((cost − opening − posted − residual) × rate / 12), never below residual.
-- Rounding is half up on non-negative numbers.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fa_month_amount(
  _method TEXT,
  _cost BIGINT,
  _residual BIGINT,
  _opening BIGINT,
  _life INTEGER,
  _rate_bps INTEGER,
  _k INTEGER,
  _posted BIGINT
)
RETURNS BIGINT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  _base BIGINT := GREATEST(0, _cost - _residual - _opening);
  _remaining BIGINT := GREATEST(0, GREATEST(0, _cost - _residual - _opening) - COALESCE(_posted, 0));
  _share BIGINT;
BEGIN
  IF _method = 'none' OR _k < 1 OR _remaining = 0 THEN RETURN 0; END IF;
  IF _method = 'straight_line' THEN
    IF _life IS NULL OR _life < 1 OR _k > _life THEN RETURN 0; END IF;
    IF _k = _life THEN RETURN _remaining; END IF;
    _share := floor((_base::NUMERIC * 2 + _life) / (_life::NUMERIC * 2))::BIGINT;
    RETURN LEAST(_share, _remaining);
  ELSIF _method = 'reducing_balance' THEN
    IF _rate_bps IS NULL OR _rate_bps < 1 THEN RETURN 0; END IF;
    _share := floor((_remaining::NUMERIC * _rate_bps * 2 + 120000) / 240000)::BIGINT;
    RETURN LEAST(_share, _remaining);
  END IF;
  RETURN 0;
END;
$$;

REVOKE ALL ON FUNCTION public.fa_month_amount(TEXT, BIGINT, BIGINT, BIGINT, INTEGER, INTEGER, INTEGER, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fa_month_amount(TEXT, BIGINT, BIGINT, BIGINT, INTEGER, INTEGER, INTEGER, BIGINT) TO authenticated;

-- Internal helper: month end of a date.
CREATE OR REPLACE FUNCTION public.fa_month_end(_d DATE)
RETURNS DATE
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$ SELECT (date_trunc('month', _d) + INTERVAL '1 month - 1 day')::DATE $$;
REVOKE ALL ON FUNCTION public.fa_month_end(DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fa_month_end(DATE) TO authenticated;

-- Internal helper: the account must belong to the company, be active and postable, and be of a type.
CREATE OR REPLACE FUNCTION public.fa_assert_account(
  _company_id UUID,
  _account_id UUID,
  _types public.account_type[],
  _label TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _a RECORD;
BEGIN
  IF _account_id IS NULL THEN RAISE EXCEPTION '% is required', _label; END IF;
  SELECT account_type, is_active, archived_at, is_postable INTO _a
  FROM public.accounts WHERE id = _account_id AND company_id = _company_id;
  IF NOT FOUND THEN RAISE EXCEPTION '% is not an account of this organisation', _label; END IF;
  IF NOT _a.is_active OR _a.archived_at IS NOT NULL THEN RAISE EXCEPTION '% is inactive', _label; END IF;
  IF NOT _a.is_postable THEN RAISE EXCEPTION '% is not postable', _label; END IF;
  IF NOT (_a.account_type = ANY(_types)) THEN
    RAISE EXCEPTION '% has the wrong account type (%)', _label, _a.account_type;
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.fa_assert_account(UUID, UUID, public.account_type[], TEXT) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- save_asset_type
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_asset_type(_company_id UUID, _type_id UUID, _payload JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _name TEXT := NULLIF(trim(COALESCE(_payload->>'name', '')), '');
  _method TEXT := COALESCE(_payload->>'depreciation_method', 'straight_line');
  _life INT := NULLIF(_payload->>'useful_life_months', '')::INT;
  _rate INT := NULLIF(_payload->>'annual_rate_bps', '')::INT;
  _asset UUID := NULLIF(_payload->>'asset_account_id', '')::UUID;
  _acc UUID := NULLIF(_payload->>'accumulated_account_id', '')::UUID;
  _exp UUID := NULLIF(_payload->>'expense_account_id', '')::UUID;
  _id UUID;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT public.has_company_permission(_company_id, 'accounts.manage') THEN
    RAISE EXCEPTION 'You do not have permission to manage fixed assets';
  END IF;
  IF _name IS NULL OR char_length(_name) > 120 THEN RAISE EXCEPTION 'Asset type name must be 1 to 120 characters'; END IF;
  IF _method NOT IN ('straight_line', 'reducing_balance', 'none') THEN RAISE EXCEPTION 'Unknown depreciation method'; END IF;
  IF _method = 'straight_line' AND (_life IS NULL OR _life < 1 OR _life > 1200) THEN
    RAISE EXCEPTION 'Straight line needs a useful life of 1 to 1200 months';
  END IF;
  IF _method = 'reducing_balance' AND (_rate IS NULL OR _rate < 1 OR _rate > 10000) THEN
    RAISE EXCEPTION 'Reducing balance needs an annual rate between 0.01%% and 100%%';
  END IF;
  PERFORM public.fa_assert_account(_company_id, _asset, ARRAY['asset']::public.account_type[], 'Asset account');
  PERFORM public.fa_assert_account(_company_id, _acc, ARRAY['asset']::public.account_type[], 'Accumulated depreciation account');
  PERFORM public.fa_assert_account(_company_id, _exp, ARRAY['expense']::public.account_type[], 'Depreciation expense account');
  IF _asset = _acc THEN RAISE EXCEPTION 'Asset and accumulated depreciation must be different accounts'; END IF;

  IF _type_id IS NULL THEN
    INSERT INTO public.asset_types (company_id, name, depreciation_method, useful_life_months, annual_rate_bps,
      asset_account_id, accumulated_account_id, expense_account_id)
    VALUES (_company_id, _name, _method,
      CASE WHEN _method = 'straight_line' THEN _life END,
      CASE WHEN _method = 'reducing_balance' THEN _rate END,
      _asset, _acc, _exp)
    RETURNING id INTO _id;
  ELSE
    UPDATE public.asset_types SET
      name = _name, depreciation_method = _method,
      useful_life_months = CASE WHEN _method = 'straight_line' THEN _life END,
      annual_rate_bps = CASE WHEN _method = 'reducing_balance' THEN _rate END,
      asset_account_id = _asset, accumulated_account_id = _acc, expense_account_id = _exp,
      updated_at = now()
    WHERE id = _type_id AND company_id = _company_id
    RETURNING id INTO _id;
    IF _id IS NULL THEN RAISE EXCEPTION 'Asset type not found'; END IF;
  END IF;
  PERFORM public.record_audit_event(_company_id, 'asset_type.saved', 'asset_type', _id,
    jsonb_build_object('name', _name, 'method', _method));
  RETURN _id;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'An asset type with that name already exists';
END;
$$;

REVOKE ALL ON FUNCTION public.save_asset_type(UUID, UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_asset_type(UUID, UUID, JSONB) TO authenticated;

-- ---------------------------------------------------------------------------
-- save_fixed_asset: create or edit a register entry (no ledger posting).
-- Once depreciation has been posted, or the asset is disposed, only descriptive fields can change.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_fixed_asset(_company_id UUID, _asset_id UUID, _payload JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _cur RECORD;
  _name TEXT := NULLIF(trim(COALESCE(_payload->>'name', '')), '');
  _desc TEXT := NULLIF(trim(COALESCE(_payload->>'description', '')), '');
  _notes TEXT := NULLIF(trim(COALESCE(_payload->>'notes', '')), '');
  _type UUID := NULLIF(_payload->>'asset_type_id', '')::UUID;
  _purchase DATE := NULLIF(_payload->>'purchase_date', '')::DATE;
  _start DATE := COALESCE(NULLIF(_payload->>'depreciation_start_date', '')::DATE, NULLIF(_payload->>'purchase_date', '')::DATE);
  _cost BIGINT;
  _residual BIGINT;
  _opening BIGINT;
  _method TEXT := COALESCE(_payload->>'depreciation_method', 'straight_line');
  _life INT := NULLIF(_payload->>'useful_life_months', '')::INT;
  _rate INT := NULLIF(_payload->>'annual_rate_bps', '')::INT;
  _asset UUID := NULLIF(_payload->>'asset_account_id', '')::UUID;
  _acc UUID := NULLIF(_payload->>'accumulated_account_id', '')::UUID;
  _exp UUID := NULLIF(_payload->>'expense_account_id', '')::UUID;
  _bill UUID := NULLIF(_payload->>'source_bill_id', '')::UUID;
  _line UUID := NULLIF(_payload->>'source_bill_line_id', '')::UUID;
  _bl RECORD;
  _linked BIGINT;
  _number TEXT;
  _id UUID;
  _has_dep BOOLEAN;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT public.has_company_permission(_company_id, 'accounts.manage') THEN
    RAISE EXCEPTION 'You do not have permission to manage fixed assets';
  END IF;
  IF _name IS NULL OR char_length(_name) > 160 THEN RAISE EXCEPTION 'Asset name must be 1 to 160 characters'; END IF;

  IF _asset_id IS NOT NULL THEN
    SELECT * INTO _cur FROM public.fixed_assets
    WHERE id = _asset_id AND company_id = _company_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Fixed asset not found'; END IF;
    IF _cur.status = 'disposed' THEN RAISE EXCEPTION 'A disposed asset cannot be edited'; END IF;
    SELECT EXISTS (SELECT 1 FROM public.asset_depreciation_entries WHERE asset_id = _asset_id) INTO _has_dep;
    IF _has_dep OR _cur.depreciated_through IS NOT NULL THEN
      -- Financial terms are frozen once depreciation has been posted.
      UPDATE public.fixed_assets
      SET name = _name, description = _desc, notes = _notes, asset_type_id = _type, updated_at = now()
      WHERE id = _asset_id;
      PERFORM public.record_audit_event(_company_id, 'fixed_asset.updated', 'fixed_asset', _asset_id,
        jsonb_build_object('name', _name, 'descriptive_only', true));
      RETURN _asset_id;
    END IF;
  END IF;

  BEGIN
    _cost := (_payload->>'cost_minor')::BIGINT;
    _residual := COALESCE(NULLIF(_payload->>'residual_minor', '')::BIGINT, 0);
    _opening := COALESCE(NULLIF(_payload->>'opening_accumulated_minor', '')::BIGINT, 0);
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'Cost, residual value and opening depreciation must be whole minor units';
  END;
  IF _purchase IS NULL THEN RAISE EXCEPTION 'Purchase date is required'; END IF;
  IF _start < _purchase THEN RAISE EXCEPTION 'Depreciation cannot start before the purchase date'; END IF;
  IF _cost IS NULL OR _cost <= 0 OR _cost > 900000000000000 THEN RAISE EXCEPTION 'Cost must be greater than zero'; END IF;
  IF _residual < 0 OR _opening < 0 THEN RAISE EXCEPTION 'Residual value and opening depreciation cannot be negative'; END IF;
  IF _residual + _opening > _cost THEN RAISE EXCEPTION 'Residual value plus opening depreciation cannot exceed cost'; END IF;
  IF _method NOT IN ('straight_line', 'reducing_balance', 'none') THEN RAISE EXCEPTION 'Unknown depreciation method'; END IF;
  IF _method = 'straight_line' AND (_life IS NULL OR _life < 1 OR _life > 1200) THEN
    RAISE EXCEPTION 'Straight line needs a useful life of 1 to 1200 months';
  END IF;
  IF _method = 'reducing_balance' AND (_rate IS NULL OR _rate < 1 OR _rate > 10000) THEN
    RAISE EXCEPTION 'Reducing balance needs an annual rate between 0.01%% and 100%%';
  END IF;
  PERFORM public.fa_assert_account(_company_id, _asset, ARRAY['asset']::public.account_type[], 'Asset account');
  PERFORM public.fa_assert_account(_company_id, _acc, ARRAY['asset']::public.account_type[], 'Accumulated depreciation account');
  PERFORM public.fa_assert_account(_company_id, _exp, ARRAY['expense']::public.account_type[], 'Depreciation expense account');
  IF _asset = _acc THEN RAISE EXCEPTION 'Asset and accumulated depreciation must be different accounts'; END IF;
  IF _type IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.asset_types WHERE id = _type AND company_id = _company_id) THEN
    RAISE EXCEPTION 'Asset type not found';
  END IF;

  -- Optional link to the purchase bill line this asset was capitalised from.
  IF _line IS NOT NULL THEN
    SELECT l.id, l.bill_id, l.net_minor, l.tax_minor, b.currency_code::TEXT AS cur INTO _bl
    FROM public.purchase_bill_lines l
    JOIN public.purchase_bills b ON b.id = l.bill_id
    WHERE l.id = _line AND l.company_id = _company_id AND b.company_id = _company_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'The bill line was not found in this organisation'; END IF;
    IF _bill IS NOT NULL AND _bill <> _bl.bill_id THEN RAISE EXCEPTION 'The bill line does not belong to that bill'; END IF;
    _bill := _bl.bill_id;
    IF _bl.cur = (SELECT base_currency FROM public.companies WHERE id = _company_id) THEN
      SELECT COALESCE(SUM(cost_minor), 0) INTO _linked
      FROM public.fixed_assets
      WHERE source_bill_line_id = _line AND (_asset_id IS NULL OR id <> _asset_id);
      IF _linked + _cost > _bl.net_minor + _bl.tax_minor THEN
        RAISE EXCEPTION 'Assets linked to this bill line would cost more than the line itself (% already registered)', _linked;
      END IF;
    END IF;
  ELSIF _bill IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.purchase_bills WHERE id = _bill AND company_id = _company_id) THEN
      RAISE EXCEPTION 'The bill was not found in this organisation';
    END IF;
  END IF;

  IF _asset_id IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('fa_number:' || _company_id::TEXT));
    SELECT 'FA-' || lpad((COALESCE(MAX(NULLIF(regexp_replace(asset_number, '\D', '', 'g'), '')::INT), 0) + 1)::TEXT, 4, '0')
    INTO _number FROM public.fixed_assets WHERE company_id = _company_id;
    INSERT INTO public.fixed_assets (
      company_id, asset_type_id, asset_number, name, description, notes, purchase_date, depreciation_start_date,
      cost_minor, residual_minor, opening_accumulated_minor, depreciation_method, useful_life_months, annual_rate_bps,
      asset_account_id, accumulated_account_id, expense_account_id, source_bill_id, source_bill_line_id, created_by
    ) VALUES (
      _company_id, _type, _number, _name, _desc, _notes, _purchase, _start,
      _cost, _residual, _opening, _method,
      CASE WHEN _method = 'straight_line' THEN _life END,
      CASE WHEN _method = 'reducing_balance' THEN _rate END,
      _asset, _acc, _exp, _bill, _line, _uid
    ) RETURNING id INTO _id;
    PERFORM public.record_audit_event(_company_id, 'fixed_asset.created', 'fixed_asset', _id,
      jsonb_build_object('asset_number', _number, 'name', _name, 'cost_minor', _cost));
  ELSE
    UPDATE public.fixed_assets SET
      asset_type_id = _type, name = _name, description = _desc, notes = _notes,
      purchase_date = _purchase, depreciation_start_date = _start,
      cost_minor = _cost, residual_minor = _residual, opening_accumulated_minor = _opening,
      depreciation_method = _method,
      useful_life_months = CASE WHEN _method = 'straight_line' THEN _life END,
      annual_rate_bps = CASE WHEN _method = 'reducing_balance' THEN _rate END,
      asset_account_id = _asset, accumulated_account_id = _acc, expense_account_id = _exp,
      source_bill_id = _bill, source_bill_line_id = _line, updated_at = now()
    WHERE id = _asset_id;
    _id := _asset_id;
    PERFORM public.record_audit_event(_company_id, 'fixed_asset.updated', 'fixed_asset', _id,
      jsonb_build_object('name', _name, 'cost_minor', _cost));
  END IF;
  RETURN _id;
END;
$$;

REVOKE ALL ON FUNCTION public.save_fixed_asset(UUID, UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_fixed_asset(UUID, UUID, JSONB) TO authenticated;

-- ---------------------------------------------------------------------------
-- delete_fixed_asset: only while nothing has been posted for it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_fixed_asset(_asset_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _a RECORD;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  SELECT * INTO _a FROM public.fixed_assets WHERE id = _asset_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Fixed asset not found'; END IF;
  IF NOT public.is_company_member(_a.company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT public.has_company_permission(_a.company_id, 'accounts.manage') THEN
    RAISE EXCEPTION 'You do not have permission to manage fixed assets';
  END IF;
  IF _a.status = 'disposed' OR _a.depreciated_through IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.asset_depreciation_entries WHERE asset_id = _asset_id) THEN
    RAISE EXCEPTION 'An asset with posted depreciation or a disposal cannot be deleted';
  END IF;
  DELETE FROM public.fixed_assets WHERE id = _asset_id;
  PERFORM public.record_audit_event(_a.company_id, 'fixed_asset.deleted', 'fixed_asset', _asset_id,
    jsonb_build_object('asset_number', _a.asset_number, 'name', _a.name));
END;
$$;

REVOKE ALL ON FUNCTION public.delete_fixed_asset(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_fixed_asset(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- run_depreciation: preview (default) or post one month of depreciation for every active asset.
--
-- Per asset the status is
--   due          next period for this asset; the amount is shown (and posted when not a preview)
--   not_started  the period ends before the depreciation start month
--   behind       an earlier period has not been run for this asset yet (run those first)
--   done         this period (or a later one) is already depreciated
--   nothing_left fully depreciated to residual (no amount)
-- Posting creates ONE journal (via post_journal) dated the period end, with a debit to the expense
-- account and a credit to the accumulated depreciation account for each asset, then records an entry
-- per asset. Period status, lock dates and account checks are enforced by post_journal; if it raises,
-- nothing is stored. Running the same period again changes nothing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.run_depreciation(
  _company_id UUID,
  _period_end DATE,
  _preview BOOLEAN DEFAULT TRUE
)
RETURNS TABLE (
  asset_id UUID,
  asset_number TEXT,
  asset_name TEXT,
  status TEXT,
  amount_minor BIGINT,
  accumulated_after_minor BIGINT,
  journal_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  _uid UUID := auth.uid();
  _a RECORD;
  _rows JSONB := '[]'::JSONB;
  _lines JSONB := '[]'::JSONB;
  _due JSONB := '[]'::JSONB;
  _posted BIGINT;
  _k INT;
  _amt BIGINT;
  _status TEXT;
  _expected DATE;
  _run UUID;
  _jid UUID;
  _total BIGINT := 0;
  _count INT := 0;
  _d JSONB;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT (
    public.has_company_permission(_company_id, 'accounting.post')
    OR public.has_company_permission(_company_id, 'journals.manual')
  ) THEN
    RAISE EXCEPTION 'You do not have permission to post journals';
  END IF;
  IF _period_end IS NULL THEN RAISE EXCEPTION 'A period end date is required'; END IF;
  IF _period_end <> public.fa_month_end(_period_end) THEN
    RAISE EXCEPTION 'Depreciation runs by calendar month: use the last day of the month';
  END IF;
  IF _period_end > public.fa_month_end(CURRENT_DATE) THEN
    RAISE EXCEPTION 'Depreciation cannot be run for a month that has not started';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('fa_dep:' || _company_id::TEXT));

  FOR _a IN
    SELECT * FROM public.fixed_assets f
    WHERE f.company_id = _company_id AND f.status = 'active' AND f.depreciation_method <> 'none'
    ORDER BY f.asset_number
    FOR UPDATE
  LOOP
    _amt := 0;
    _posted := COALESCE((SELECT SUM(e.amount_minor) FROM public.asset_depreciation_entries e WHERE e.asset_id = _a.id), 0);
    _expected := CASE WHEN _a.depreciated_through IS NULL
                      THEN public.fa_month_end(_a.depreciation_start_date)
                      ELSE public.fa_month_end(_a.depreciated_through + 1) END;
    IF _a.depreciated_through IS NOT NULL AND _a.depreciated_through >= _period_end THEN
      _status := 'done';
    ELSIF _a.depreciated_through IS NULL AND _period_end < public.fa_month_end(_a.depreciation_start_date) THEN
      _status := 'not_started';
    ELSIF _period_end > _expected THEN
      _status := 'behind';
    ELSE
      _k := (EXTRACT(YEAR FROM _period_end)::INT - EXTRACT(YEAR FROM _a.depreciation_start_date)::INT) * 12
          + (EXTRACT(MONTH FROM _period_end)::INT - EXTRACT(MONTH FROM _a.depreciation_start_date)::INT) + 1;
      _amt := public.fa_month_amount(
        _a.depreciation_method, _a.cost_minor, _a.residual_minor, _a.opening_accumulated_minor,
        _a.useful_life_months, _a.annual_rate_bps, _k, _posted);
      _status := CASE WHEN _amt > 0 THEN 'due' ELSE 'nothing_left' END;
    END IF;

    _rows := _rows || jsonb_build_array(jsonb_build_object(
      'asset_id', _a.id, 'asset_number', _a.asset_number, 'asset_name', _a.name,
      'status', _status, 'amount_minor', _amt,
      'accumulated_after_minor', _a.opening_accumulated_minor + _posted + _amt));

    IF _status IN ('due', 'nothing_left') THEN
      _due := _due || jsonb_build_array(jsonb_build_object('asset_id', _a.id, 'amount_minor', _amt));
      IF _amt > 0 THEN
        _lines := _lines || jsonb_build_array(
          jsonb_build_object('account_id', _a.expense_account_id, 'debit_minor', _amt,
            'description', 'Depreciation ' || _a.asset_number || ' ' || _a.name),
          jsonb_build_object('account_id', _a.accumulated_account_id, 'credit_minor', _amt,
            'description', 'Depreciation ' || _a.asset_number || ' ' || _a.name));
        _total := _total + _amt;
        _count := _count + 1;
      END IF;
    END IF;
  END LOOP;

  IF NOT _preview AND jsonb_array_length(_due) > 0 THEN
    IF _total > 0 THEN
      _run := gen_random_uuid();
      _jid := public.post_journal(jsonb_build_object(
        'company_id', _company_id,
        'journal_date', _period_end,
        'memo', 'Depreciation for ' || to_char(_period_end, 'FMMonth YYYY'),
        'source_type', 'depreciation',
        'source_id', _run,
        'idempotency_key', 'fa-dep-run:' || _run::TEXT,
        'lines', _lines));
      INSERT INTO public.asset_depreciation_runs (id, company_id, period_end, journal_id, total_minor, asset_count, created_by)
      VALUES (_run, _company_id, _period_end, _jid, _total, _count, _uid);
      FOR _d IN SELECT value FROM jsonb_array_elements(_due)
      LOOP
        IF (_d->>'amount_minor')::BIGINT > 0 THEN
          INSERT INTO public.asset_depreciation_entries (company_id, asset_id, run_id, period_end, amount_minor, journal_id)
          VALUES (_company_id, (_d->>'asset_id')::UUID, _run, _period_end, (_d->>'amount_minor')::BIGINT, _jid);
        END IF;
      END LOOP;
      PERFORM public.record_audit_event(_company_id, 'fixed_asset.depreciation_run', 'depreciation_run', _run,
        jsonb_build_object('period_end', _period_end, 'total_minor', _total, 'assets', _count, 'journal_id', _jid));
    END IF;
    UPDATE public.fixed_assets f SET depreciated_through = _period_end, updated_at = now()
    WHERE f.id IN (SELECT (x->>'asset_id')::UUID FROM jsonb_array_elements(_due) x);
    -- Report what happened.
    SELECT COALESCE(jsonb_agg(
      CASE WHEN r->>'status' IN ('due', 'nothing_left')
           THEN jsonb_set(r, '{status}', to_jsonb(CASE WHEN (r->>'amount_minor')::BIGINT > 0 THEN 'posted' ELSE 'nothing_left' END))
           ELSE r END), '[]'::JSONB)
    INTO _rows FROM jsonb_array_elements(_rows) r;
  END IF;

  RETURN QUERY
  SELECT (x.asset_id)::UUID, x.asset_number, x.asset_name, x.status, x.amount_minor, x.accumulated_after_minor,
         CASE WHEN x.status = 'posted' THEN _jid END
  FROM jsonb_to_recordset(_rows) AS x(
    asset_id TEXT, asset_number TEXT, asset_name TEXT, status TEXT, amount_minor BIGINT, accumulated_after_minor BIGINT);
END;
$$;

REVOKE ALL ON FUNCTION public.run_depreciation(UUID, DATE, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.run_depreciation(UUID, DATE, BOOLEAN) TO authenticated;

-- ---------------------------------------------------------------------------
-- dispose_fixed_asset: removes cost and accumulated depreciation, books proceeds and the gain or
-- loss, in one balanced journal through post_journal.
--   Depreciation must be up to date: posted through the end of the month BEFORE the disposal month
--   (a month's own charge may also be posted; later months may not). No depreciation is charged for
--   a month in which the asset is disposed of unless that month's run was already posted.
--   gain/loss = proceeds − net book value; the account is required when it is not zero.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispose_fixed_asset(
  _asset_id UUID,
  _disposal_date DATE,
  _proceeds_minor BIGINT DEFAULT 0,
  _proceeds_account_id UUID DEFAULT NULL,
  _gain_loss_account_id UUID DEFAULT NULL,
  _notes TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _a RECORD;
  _acc BIGINT;
  _nbv BIGINT;
  _gain BIGINT;
  _proceeds BIGINT := COALESCE(_proceeds_minor, 0);
  _required DATE;
  _lines JSONB := '[]'::JSONB;
  _desc TEXT;
  _jid UUID;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  SELECT * INTO _a FROM public.fixed_assets WHERE id = _asset_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Fixed asset not found'; END IF;
  IF NOT public.is_company_member(_a.company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT (
    public.has_company_permission(_a.company_id, 'accounting.post')
    OR public.has_company_permission(_a.company_id, 'journals.manual')
  ) THEN
    RAISE EXCEPTION 'You do not have permission to post journals';
  END IF;
  IF _a.status = 'disposed' THEN RAISE EXCEPTION 'This asset has already been disposed of'; END IF;
  IF _disposal_date IS NULL THEN RAISE EXCEPTION 'A disposal date is required'; END IF;
  IF _disposal_date < _a.purchase_date THEN RAISE EXCEPTION 'Disposal cannot be before the purchase date'; END IF;
  IF _disposal_date > CURRENT_DATE THEN RAISE EXCEPTION 'Disposal date cannot be in the future'; END IF;
  IF _proceeds < 0 OR _proceeds > 900000000000000 THEN RAISE EXCEPTION 'Proceeds must be zero or more'; END IF;

  PERFORM pg_advisory_xact_lock(hashtext('fa_dep:' || _a.company_id::TEXT));

  _required := public.fa_month_end((date_trunc('month', _disposal_date) - INTERVAL '1 day')::DATE);
  IF public.fa_month_end(_a.depreciation_start_date) > _required AND _a.depreciated_through IS NULL THEN
    NULL; -- depreciation had not started before the disposal month: nothing is owed
  ELSIF _a.depreciation_method <> 'none' AND (_a.depreciated_through IS NULL OR _a.depreciated_through < _required) THEN
    RAISE EXCEPTION 'Post depreciation through % before disposing of this asset', to_char(_required, 'YYYY-MM-DD');
  END IF;
  IF _a.depreciated_through IS NOT NULL AND _a.depreciated_through > public.fa_month_end(_disposal_date) THEN
    RAISE EXCEPTION 'Depreciation has been posted after the disposal date (through %)', _a.depreciated_through;
  END IF;

  _acc := _a.opening_accumulated_minor
        + COALESCE((SELECT SUM(amount_minor) FROM public.asset_depreciation_entries WHERE asset_id = _asset_id), 0);
  IF _acc > _a.cost_minor THEN RAISE EXCEPTION 'Accumulated depreciation exceeds cost; review this asset'; END IF;
  _nbv := _a.cost_minor - _acc;
  _gain := _proceeds - _nbv;
  _desc := 'Disposal ' || _a.asset_number || ' ' || _a.name;

  IF _acc > 0 THEN
    _lines := _lines || jsonb_build_array(jsonb_build_object(
      'account_id', _a.accumulated_account_id, 'debit_minor', _acc, 'description', _desc));
  END IF;
  IF _proceeds > 0 THEN
    PERFORM public.fa_assert_account(_a.company_id, _proceeds_account_id,
      ARRAY['asset', 'liability', 'equity']::public.account_type[], 'Proceeds account');
    _lines := _lines || jsonb_build_array(jsonb_build_object(
      'account_id', _proceeds_account_id, 'debit_minor', _proceeds, 'description', _desc));
  END IF;
  IF _gain <> 0 THEN
    PERFORM public.fa_assert_account(_a.company_id, _gain_loss_account_id,
      ARRAY['income', 'expense']::public.account_type[], 'Gain/loss account');
    IF _gain < 0 THEN
      _lines := _lines || jsonb_build_array(jsonb_build_object(
        'account_id', _gain_loss_account_id, 'debit_minor', -_gain, 'description', _desc));
    ELSE
      _lines := _lines || jsonb_build_array(jsonb_build_object(
        'account_id', _gain_loss_account_id, 'credit_minor', _gain, 'description', _desc));
    END IF;
  END IF;
  _lines := _lines || jsonb_build_array(jsonb_build_object(
    'account_id', _a.asset_account_id, 'credit_minor', _a.cost_minor, 'description', _desc));

  _jid := public.post_journal(jsonb_build_object(
    'company_id', _a.company_id,
    'journal_date', _disposal_date,
    'memo', _desc,
    'source_type', 'asset_disposal',
    'source_id', _asset_id,
    'idempotency_key', 'fa-dispose:' || _asset_id::TEXT,
    'lines', _lines));

  UPDATE public.fixed_assets SET
    status = 'disposed', disposal_date = _disposal_date, disposal_proceeds_minor = _proceeds,
    disposal_journal_id = _jid, notes = COALESCE(NULLIF(trim(COALESCE(_notes, '')), ''), notes),
    updated_at = now()
  WHERE id = _asset_id;

  PERFORM public.record_audit_event(_a.company_id, 'fixed_asset.disposed', 'fixed_asset', _asset_id,
    jsonb_build_object('asset_number', _a.asset_number, 'disposal_date', _disposal_date,
      'proceeds_minor', _proceeds, 'net_book_value_minor', _nbv, 'gain_loss_minor', _gain, 'journal_id', _jid));
  RETURN _jid;
END;
$$;

REVOKE ALL ON FUNCTION public.dispose_fixed_asset(UUID, DATE, BIGINT, UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dispose_fixed_asset(UUID, DATE, BIGINT, UUID, UUID, TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- Reports (read-only, membership checked)
--   report_fixed_asset_register: assets purchased on or before the date with depreciation to that date
--   report_depreciation_schedule: opening, charge and closing accumulated depreciation per asset
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.report_fixed_asset_register(_company_id UUID, _as_of DATE)
RETURNS TABLE (
  asset_id UUID,
  asset_number TEXT,
  asset_name TEXT,
  asset_type_name TEXT,
  asset_account_id UUID,
  purchase_date DATE,
  depreciation_method TEXT,
  useful_life_months INTEGER,
  annual_rate_bps INTEGER,
  cost_minor BIGINT,
  residual_minor BIGINT,
  accumulated_minor BIGINT,
  disposal_date DATE,
  disposal_proceeds_minor BIGINT,
  source_bill_id UUID
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF _as_of IS NULL THEN RAISE EXCEPTION 'An as-at date is required'; END IF;
  RETURN QUERY
  SELECT f.id, f.asset_number, f.name, t.name, f.asset_account_id, f.purchase_date,
    f.depreciation_method, f.useful_life_months, f.annual_rate_bps, f.cost_minor, f.residual_minor,
    (f.opening_accumulated_minor + COALESCE((
       SELECT SUM(e.amount_minor) FROM public.asset_depreciation_entries e
       WHERE e.asset_id = f.id AND e.period_end <= _as_of), 0))::BIGINT,
    CASE WHEN f.status = 'disposed' AND f.disposal_date <= _as_of THEN f.disposal_date END,
    CASE WHEN f.status = 'disposed' AND f.disposal_date <= _as_of THEN f.disposal_proceeds_minor END,
    f.source_bill_id
  FROM public.fixed_assets f
  LEFT JOIN public.asset_types t ON t.id = f.asset_type_id
  WHERE f.company_id = _company_id AND f.purchase_date <= _as_of
  ORDER BY f.asset_number;
END;
$$;

REVOKE ALL ON FUNCTION public.report_fixed_asset_register(UUID, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_fixed_asset_register(UUID, DATE) TO authenticated;

CREATE OR REPLACE FUNCTION public.report_depreciation_schedule(_company_id UUID, _from DATE, _to DATE)
RETURNS TABLE (
  asset_id UUID,
  asset_number TEXT,
  asset_name TEXT,
  cost_minor BIGINT,
  opening_accumulated_minor BIGINT,
  charge_minor BIGINT,
  closing_accumulated_minor BIGINT,
  disposal_date DATE
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF _from IS NULL OR _to IS NULL OR _to < _from THEN
    RAISE EXCEPTION 'A valid date range is required';
  END IF;
  RETURN QUERY
  SELECT f.id, f.asset_number, f.name, f.cost_minor,
    (f.opening_accumulated_minor + COALESCE(SUM(e.amount_minor) FILTER (WHERE e.period_end < _from), 0))::BIGINT,
    COALESCE(SUM(e.amount_minor) FILTER (WHERE e.period_end >= _from AND e.period_end <= _to), 0)::BIGINT,
    (f.opening_accumulated_minor + COALESCE(SUM(e.amount_minor) FILTER (WHERE e.period_end <= _to), 0))::BIGINT,
    CASE WHEN f.status = 'disposed' AND f.disposal_date <= _to THEN f.disposal_date END
  FROM public.fixed_assets f
  LEFT JOIN public.asset_depreciation_entries e ON e.asset_id = f.id
  WHERE f.company_id = _company_id AND f.purchase_date <= _to
    AND f.depreciation_method <> 'none'
  GROUP BY f.id, f.asset_number, f.name, f.cost_minor, f.opening_accumulated_minor, f.status, f.disposal_date
  HAVING NOT (f.status = 'disposed' AND f.disposal_date < _from)
  ORDER BY f.asset_number;
END;
$$;

REVOKE ALL ON FUNCTION public.report_depreciation_schedule(UUID, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_depreciation_schedule(UUID, DATE, DATE) TO authenticated;
