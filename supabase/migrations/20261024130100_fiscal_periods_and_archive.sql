-- Workstream D: financial-year coverage (AC-01) and archiving of P&L accounts (AC-07).
-- Additive and idempotent. Apply in filename order after 20261024130000_reporting_ledger_rpcs.sql.

-- ---------------------------------------------------------------------------
-- Financial-year helpers
-- ---------------------------------------------------------------------------

-- Last day of the financial year that ends in calendar year _y (day clamped, e.g. 29 Feb).
CREATE OR REPLACE FUNCTION public.fiscal_year_end_in_year(_y int, _month int, _day int)
RETURNS date
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT make_date(
    _y,
    _month,
    LEAST(_day, EXTRACT(day FROM (make_date(_y, _month, 1) + INTERVAL '1 month - 1 day'))::int)
  );
$$;

-- Financial year containing _date for a company. SECURITY INVOKER: RLS on companies applies.
CREATE OR REPLACE FUNCTION public.fiscal_year_for_date(
  _company_id uuid,
  _date date,
  OUT fy_start date,
  OUT fy_end date
)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  _m int;
  _d int;
  _y int := EXTRACT(year FROM _date)::int;
  _end_this date;
BEGIN
  SELECT fiscal_year_end_month, COALESCE(fiscal_year_end_day, 31)
    INTO _m, _d
  FROM public.companies WHERE id = _company_id;
  IF _m IS NULL THEN
    RAISE EXCEPTION 'Company not found';
  END IF;
  _end_this := public.fiscal_year_end_in_year(_y, _m, _d);
  IF _date <= _end_this THEN
    fy_end := _end_this;
  ELSE
    fy_end := public.fiscal_year_end_in_year(_y + 1, _m, _d);
  END IF;
  fy_start := public.fiscal_year_end_in_year(EXTRACT(year FROM fy_end)::int - 1, _m, _d) + 1;
END;
$$;

-- ---------------------------------------------------------------------------
-- AC-01: create the period covering a posting date when none exists
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ensure_fiscal_period_for_date(_company_id uuid, _date date)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid uuid := auth.uid();
  _pid uuid;
  _fy_start date;
  _fy_end date;
  _gap_start date;
  _gap_end date;
  _name text;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF _company_id IS NULL OR _date IS NULL THEN
    RAISE EXCEPTION 'Company and date are required';
  END IF;
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT (
    public.has_company_permission(_company_id, 'accounting.post')
    OR public.has_company_permission(_company_id, 'journals.manual')
  ) THEN
    RAISE EXCEPTION 'You do not have permission to create accounting periods';
  END IF;

  -- Already covered (any status): return it; posting then reports a locked period itself.
  SELECT id INTO _pid
  FROM public.accounting_periods
  WHERE company_id = _company_id AND start_date <= _date AND end_date >= _date
  LIMIT 1;
  IF _pid IS NOT NULL THEN
    RETURN _pid;
  END IF;

  -- Sanity window: no periods more than 25 years back or 2 years ahead.
  IF _date < (CURRENT_DATE - INTERVAL '25 years')::date OR _date > (CURRENT_DATE + INTERVAL '2 years')::date THEN
    RAISE EXCEPTION 'Posting date % is outside the supported range', _date;
  END IF;

  -- Respect organisation lock dates: a locked date never gets a new open period.
  PERFORM public.assert_journal_date_unlocked(_company_id, _date);

  SELECT fy_start, fy_end INTO _fy_start, _fy_end FROM public.fiscal_year_for_date(_company_id, _date);

  -- Clip to the gap around _date so the no-overlap constraint cannot fire.
  SELECT GREATEST(_fy_start, COALESCE(MAX(end_date) + 1, _fy_start))
    INTO _gap_start
  FROM public.accounting_periods
  WHERE company_id = _company_id AND end_date < _date;
  SELECT LEAST(_fy_end, COALESCE(MIN(start_date) - 1, _fy_end))
    INTO _gap_end
  FROM public.accounting_periods
  WHERE company_id = _company_id AND start_date > _date;

  _name := 'FY ' || to_char(_fy_start, 'YYYY-MM-DD') || ' to ' || to_char(_fy_end, 'YYYY-MM-DD');

  PERFORM set_config('linkbooks.trusted', 'on', true);
  INSERT INTO public.accounting_periods (company_id, name, start_date, end_date, status)
  VALUES (_company_id, _name, _gap_start, _gap_end, 'open')
  RETURNING id INTO _pid;

  RETURN _pid;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_fiscal_period_for_date(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ensure_fiscal_period_for_date(uuid, date) TO authenticated;

REVOKE ALL ON FUNCTION public.fiscal_year_for_date(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fiscal_year_for_date(uuid, date) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fiscal_year_end_in_year(int, int, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fiscal_year_end_in_year(int, int, int) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- AC-07: income / expense accounts may be archived when they have no activity in the
-- current financial year (their all-time balance never returns to zero without a year-end
-- close). Balance-sheet accounts keep the zero-balance rule. Body is otherwise identical to
-- the previous definition of accounts_apply_kind().
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.accounts_apply_kind()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  mapped_type public.account_type;
  mapped_sub TEXT;
  mapped_fs TEXT;
  mapped_nb public.normal_balance;
  walk UUID;
  guard INT := 0;
  parent_type public.account_type;
  parent_company UUID;
  debit_sum BIGINT;
  credit_sum BIGINT;
  _fy_start DATE;
  _fy_end DATE;
BEGIN
  IF NEW.is_system AND TG_OP = 'INSERT'
     AND current_setting('linkbooks.trusted', true) IS DISTINCT FROM 'on'
     AND auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'A user account cannot be created as a system account';
  END IF;

  IF NEW.account_kind IS NULL THEN
    NEW.account_kind := CASE NEW.account_type
      WHEN 'asset' THEN 'current_asset'
      WHEN 'liability' THEN 'current_liability'
      WHEN 'equity' THEN 'equity'
      WHEN 'income' THEN 'revenue'
      ELSE 'expense'
    END;
  END IF;

  mapped_type := CASE NEW.account_kind
    WHEN 'bank' THEN 'asset'
    WHEN 'accounts_receivable' THEN 'asset'
    WHEN 'current_asset' THEN 'asset'
    WHEN 'inventory' THEN 'asset'
    WHEN 'prepayment' THEN 'asset'
    WHEN 'fixed_asset' THEN 'asset'
    WHEN 'non_current_asset' THEN 'asset'
    WHEN 'accounts_payable' THEN 'liability'
    WHEN 'credit_card' THEN 'liability'
    WHEN 'current_liability' THEN 'liability'
    WHEN 'non_current_liability' THEN 'liability'
    WHEN 'equity' THEN 'equity'
    WHEN 'retained_earnings' THEN 'equity'
    WHEN 'revenue' THEN 'income'
    WHEN 'other_income' THEN 'income'
    WHEN 'contra_revenue' THEN 'income'
    ELSE 'expense'
  END;
  mapped_sub := CASE NEW.account_kind
    WHEN 'bank' THEN 'bank'
    WHEN 'accounts_receivable' THEN 'receivable'
    WHEN 'inventory' THEN 'inventory'
    WHEN 'prepayment' THEN 'prepayment'
    WHEN 'fixed_asset' THEN 'fixed'
    WHEN 'non_current_asset' THEN 'non_current_asset'
    WHEN 'accounts_payable' THEN 'payable'
    WHEN 'credit_card' THEN 'credit_card'
    WHEN 'current_liability' THEN 'current_liability'
    WHEN 'non_current_liability' THEN 'non_current_liability'
    WHEN 'retained_earnings' THEN 'retained'
    WHEN 'equity' THEN 'equity'
    WHEN 'other_income' THEN 'other'
    WHEN 'contra_revenue' THEN 'contra_revenue'
    WHEN 'cost_of_sales' THEN 'cogs'
    WHEN 'depreciation' THEN 'depreciation'
    WHEN 'other_expense' THEN 'other_expense'
    WHEN 'overhead' THEN 'operating_expense'
    WHEN 'expense' THEN 'operating_expense'
    WHEN 'revenue' THEN 'income'
    ELSE 'current_asset'
  END;
  mapped_fs := CASE NEW.account_kind
    WHEN 'bank' THEN 'current_assets'
    WHEN 'accounts_receivable' THEN 'current_assets'
    WHEN 'current_asset' THEN 'current_assets'
    WHEN 'inventory' THEN 'current_assets'
    WHEN 'prepayment' THEN 'current_assets'
    WHEN 'fixed_asset' THEN 'non_current_assets'
    WHEN 'non_current_asset' THEN 'non_current_assets'
    WHEN 'accounts_payable' THEN 'current_liabilities'
    WHEN 'credit_card' THEN 'current_liabilities'
    WHEN 'current_liability' THEN 'current_liabilities'
    WHEN 'non_current_liability' THEN 'non_current_liabilities'
    WHEN 'equity' THEN 'equity'
    WHEN 'retained_earnings' THEN 'equity'
    WHEN 'revenue' THEN 'revenue'
    WHEN 'other_income' THEN 'other_income'
    WHEN 'contra_revenue' THEN 'contra_revenue'
    WHEN 'cost_of_sales' THEN 'cost_of_sales'
    WHEN 'overhead' THEN 'operating_expense'
    WHEN 'expense' THEN 'operating_expense'
    WHEN 'depreciation' THEN 'depreciation'
    ELSE 'other_expense'
  END;
  mapped_nb := CASE WHEN NEW.account_kind = 'contra_revenue' THEN 'debit'
    WHEN mapped_type IN ('asset', 'expense') THEN 'debit'
    ELSE 'credit' END;

  NEW.account_type := mapped_type;
  NEW.normal_balance := mapped_nb;
  IF NEW.subtype IS NULL OR btrim(NEW.subtype) = '' THEN
    NEW.subtype := mapped_sub;
  END IF;
  IF NEW.fs_line IS NULL OR btrim(NEW.fs_line) = '' THEN
    NEW.fs_line := mapped_fs;
  END IF;
  IF NEW.is_header THEN
    NEW.is_postable := false;
  END IF;
  IF NEW.account_kind NOT IN ('bank', 'credit_card') THEN
    NEW.is_payment_enabled := false;
    NEW.bank_name := NULL;
    NEW.account_number_masked := NULL;
  END IF;
  IF mapped_type <> 'expense' THEN
    NEW.show_in_expense_claims := false;
  END IF;

  IF NEW.parent_id IS NOT NULL THEN
    IF NEW.parent_id = NEW.id THEN
      RAISE EXCEPTION 'An account cannot be its own parent';
    END IF;
    SELECT account_type, company_id, parent_id INTO parent_type, parent_company, walk
    FROM public.accounts WHERE id = NEW.parent_id;
    IF parent_company IS NULL THEN
      RAISE EXCEPTION 'Parent account was not found';
    END IF;
    IF parent_company IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION 'Parent account must belong to the same organisation';
    END IF;
    IF parent_type IS DISTINCT FROM NEW.account_type THEN
      RAISE EXCEPTION 'A sub-account must use the same class as its parent';
    END IF;
    WHILE walk IS NOT NULL AND guard < 30 LOOP
      IF walk = NEW.id THEN
        RAISE EXCEPTION 'Account parent cycle is not allowed';
      END IF;
      SELECT parent_id INTO walk FROM public.accounts WHERE id = walk;
      guard := guard + 1;
    END LOOP;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF (OLD.is_system OR OLD.is_control OR OLD.is_locked) AND (
      NEW.account_kind IS DISTINCT FROM OLD.account_kind
      OR NEW.system_key IS DISTINCT FROM OLD.system_key
      OR NEW.is_system IS DISTINCT FROM OLD.is_system
      OR (OLD.is_active AND NOT NEW.is_active)
    ) THEN
      RAISE EXCEPTION 'System accounts cannot be re-typed or archived';
    END IF;
    IF NEW.account_type IS DISTINCT FROM OLD.account_type OR NEW.account_kind IS DISTINCT FROM OLD.account_kind THEN
      IF EXISTS (
        SELECT 1 FROM public.journal_lines jl
        JOIN public.journals j ON j.id = jl.journal_id
        WHERE jl.account_id = OLD.id AND j.status = 'posted'
      ) THEN
        RAISE EXCEPTION 'Type locked: this account has posted transactions. Merge it into another account instead.';
      END IF;
    END IF;
    IF OLD.is_active AND NOT NEW.is_active THEN
      IF EXISTS (SELECT 1 FROM public.accounts c WHERE c.parent_id = OLD.id AND c.is_active) THEN
        RAISE EXCEPTION 'Archive blocked: this account has active sub-accounts';
      END IF;
      IF OLD.account_type IN ('income', 'expense') THEN
        -- Income and expense accounts: blocked only by activity in the current financial year
        -- (year-end closing journals do not count as activity).
        SELECT fy_start, fy_end INTO _fy_start, _fy_end
        FROM public.fiscal_year_for_date(OLD.company_id, CURRENT_DATE);
        IF EXISTS (
          SELECT 1
          FROM public.journal_lines jl
          JOIN public.journals j ON j.id = jl.journal_id AND j.status = 'posted'
          WHERE jl.account_id = OLD.id
            AND j.journal_date BETWEEN _fy_start AND _fy_end
            AND NOT (j.source_type = 'other' AND COALESCE(j.memo, '') LIKE 'Year-end close%')
        ) THEN
          RAISE EXCEPTION 'Archive blocked: this account has activity in the current financial year';
        END IF;
      ELSE
        SELECT COALESCE(SUM(jl.debit_minor), 0), COALESCE(SUM(jl.credit_minor), 0)
          INTO debit_sum, credit_sum
        FROM public.journal_lines jl
        JOIN public.journals j ON j.id = jl.journal_id AND j.status = 'posted'
        WHERE jl.account_id = OLD.id;
        IF debit_sum <> credit_sum THEN
          RAISE EXCEPTION 'Archive blocked: the account balance is not zero';
        END IF;
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.sales_recurring_invoice_lines l
        JOIN public.sales_recurring_invoices r ON r.id = l.recurring_id
        WHERE l.account_id = OLD.id AND r.is_active
      ) THEN
        RAISE EXCEPTION 'Archive blocked: used on an active recurring invoice';
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.bank_rules br
        WHERE br.offset_account_id = OLD.id AND br.is_active
      ) THEN
        RAISE EXCEPTION 'Archive blocked: used on an active bank rule';
      END IF;
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;
