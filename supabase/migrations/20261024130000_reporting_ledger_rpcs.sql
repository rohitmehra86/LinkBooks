-- Workstream D: ledger numbers computed in the database (RP-01 / BK-04 / U-03 / RP-07).
--
-- PostgREST caps responses at 1000 rows, so client-side summing of journal_lines silently
-- truncates. These read-only RPCs aggregate POSTED journals only and convert every line to the
-- company base currency with the journal's fx_rate_to_base, decimal-aware:
--     base_minor = round(minor * rate * 10 ^ (base_decimals - txn_decimals))   (half away from zero)
-- which matches convertMinorToBase() in src/lib/accounting/fx.ts. When the journal currency equals
-- the base currency the amount is used as-is (rate ignored), same as the TS converter.
--
-- Additive and idempotent. No data is written. Each function checks is_company_member().

-- ---------------------------------------------------------------------------
-- ledger_balances: per-account debit / credit sums (base currency) for a date range
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ledger_balances(
  _company_id UUID,
  _from DATE DEFAULT NULL,
  _to DATE DEFAULT NULL,
  _exclude_year_end_close BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (account_id UUID, debit_minor BIGINT, credit_minor BIGINT, line_count BIGINT)
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

  RETURN QUERY
  SELECT
    jl.account_id,
    COALESCE(SUM(
      CASE WHEN j.currency_code::TEXT = c.base_currency THEN jl.debit_minor
           ELSE round(jl.debit_minor::NUMERIC * j.fx_rate_to_base
                      * power(10::NUMERIC, COALESCE(bd.decimal_places, 2) - COALESCE(td.decimal_places, 2)))::BIGINT
      END), 0)::BIGINT AS debit_minor,
    COALESCE(SUM(
      CASE WHEN j.currency_code::TEXT = c.base_currency THEN jl.credit_minor
           ELSE round(jl.credit_minor::NUMERIC * j.fx_rate_to_base
                      * power(10::NUMERIC, COALESCE(bd.decimal_places, 2) - COALESCE(td.decimal_places, 2)))::BIGINT
      END), 0)::BIGINT AS credit_minor,
    COUNT(*)::BIGINT AS line_count
  FROM public.journal_lines jl
  JOIN public.journals j ON j.id = jl.journal_id
  JOIN public.companies c ON c.id = j.company_id
  LEFT JOIN public.currency_decimals bd ON bd.code::TEXT = c.base_currency
  LEFT JOIN public.currency_decimals td ON td.code = j.currency_code
  WHERE jl.company_id = _company_id
    AND j.company_id = _company_id
    AND j.status = 'posted'
    AND (_from IS NULL OR j.journal_date >= _from)
    AND (_to IS NULL OR j.journal_date <= _to)
    AND (NOT _exclude_year_end_close
         OR NOT (j.source_type = 'other' AND COALESCE(j.memo, '') LIKE 'Year-end close%'))
  GROUP BY jl.account_id;
END;
$$;

REVOKE ALL ON FUNCTION public.ledger_balances(UUID, DATE, DATE, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ledger_balances(UUID, DATE, DATE, BOOLEAN) TO authenticated;

-- ---------------------------------------------------------------------------
-- account_balance_as_of: net debit - credit (base currency) for one account
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.account_balance_as_of(
  _company_id UUID,
  _account_id UUID,
  _as_of DATE
)
RETURNS BIGINT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _net BIGINT;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;

  SELECT COALESCE(SUM(
      CASE WHEN j.currency_code::TEXT = c.base_currency THEN jl.debit_minor - jl.credit_minor
           ELSE round((jl.debit_minor - jl.credit_minor)::NUMERIC * j.fx_rate_to_base
                      * power(10::NUMERIC, COALESCE(bd.decimal_places, 2) - COALESCE(td.decimal_places, 2)))::BIGINT
      END), 0)::BIGINT
  INTO _net
  FROM public.journal_lines jl
  JOIN public.journals j ON j.id = jl.journal_id
  JOIN public.companies c ON c.id = j.company_id
  LEFT JOIN public.currency_decimals bd ON bd.code::TEXT = c.base_currency
  LEFT JOIN public.currency_decimals td ON td.code = j.currency_code
  WHERE jl.company_id = _company_id
    AND jl.account_id = _account_id
    AND j.status = 'posted'
    AND (_as_of IS NULL OR j.journal_date <= _as_of);
  RETURN _net;
END;
$$;

REVOKE ALL ON FUNCTION public.account_balance_as_of(UUID, UUID, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.account_balance_as_of(UUID, UUID, DATE) TO authenticated;

-- ---------------------------------------------------------------------------
-- account_transactions: a page of posted lines for one account with running balance
-- (signed debit - credit, base currency) and the opening balance before _from.
-- total_count is the number of lines in the whole range so the UI can page.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.account_transactions(
  _company_id UUID,
  _account_id UUID,
  _from DATE,
  _to DATE,
  _limit INT DEFAULT 200,
  _offset INT DEFAULT 0
)
RETURNS TABLE (
  line_id UUID,
  journal_id UUID,
  journal_number BIGINT,
  journal_date DATE,
  line_no INT,
  memo TEXT,
  description TEXT,
  source_type TEXT,
  source_id UUID,
  debit_minor BIGINT,
  credit_minor BIGINT,
  running_balance_minor BIGINT,
  opening_balance_minor BIGINT,
  total_count BIGINT
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
  IF _limit IS NULL OR _limit < 1 THEN _limit := 200; END IF;
  IF _limit > 1000 THEN _limit := 1000; END IF;
  IF _offset IS NULL OR _offset < 0 THEN _offset := 0; END IF;

  RETURN QUERY
  WITH base AS (
    SELECT
      jl.id AS line_id,
      j.id AS journal_id,
      j.journal_number,
      j.journal_date,
      jl.line_no,
      j.memo,
      jl.description,
      j.source_type::TEXT AS source_type,
      j.source_id,
      CASE WHEN j.currency_code::TEXT = c.base_currency THEN jl.debit_minor
           ELSE round(jl.debit_minor::NUMERIC * j.fx_rate_to_base
                      * power(10::NUMERIC, COALESCE(bd.decimal_places, 2) - COALESCE(td.decimal_places, 2)))::BIGINT
      END AS debit_minor,
      CASE WHEN j.currency_code::TEXT = c.base_currency THEN jl.credit_minor
           ELSE round(jl.credit_minor::NUMERIC * j.fx_rate_to_base
                      * power(10::NUMERIC, COALESCE(bd.decimal_places, 2) - COALESCE(td.decimal_places, 2)))::BIGINT
      END AS credit_minor
    FROM public.journal_lines jl
    JOIN public.journals j ON j.id = jl.journal_id
    JOIN public.companies c ON c.id = j.company_id
    LEFT JOIN public.currency_decimals bd ON bd.code::TEXT = c.base_currency
    LEFT JOIN public.currency_decimals td ON td.code = j.currency_code
    WHERE jl.company_id = _company_id
      AND jl.account_id = _account_id
      AND j.status = 'posted'
      AND (_to IS NULL OR j.journal_date <= _to)
  ),
  opening AS (
    SELECT COALESCE(SUM(b.debit_minor - b.credit_minor), 0)::BIGINT AS bal
    FROM base b
    WHERE _from IS NOT NULL AND b.journal_date < _from
  ),
  period AS (
    SELECT
      b.*,
      (SELECT bal FROM opening)
        + SUM(b.debit_minor - b.credit_minor) OVER (
            ORDER BY b.journal_date, b.journal_number, b.line_no, b.line_id
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS running_balance_minor,
      (SELECT bal FROM opening) AS opening_balance_minor,
      COUNT(*) OVER () AS total_count
    FROM base b
    WHERE _from IS NULL OR b.journal_date >= _from
  )
  SELECT p.line_id, p.journal_id, p.journal_number, p.journal_date, p.line_no, p.memo,
         p.description, p.source_type, p.source_id, p.debit_minor, p.credit_minor,
         p.running_balance_minor::BIGINT, p.opening_balance_minor::BIGINT, p.total_count::BIGINT
  FROM period p
  ORDER BY p.journal_date, p.journal_number, p.line_no, p.line_id
  LIMIT _limit OFFSET _offset;
END;
$$;

REVOKE ALL ON FUNCTION public.account_transactions(UUID, UUID, DATE, DATE, INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.account_transactions(UUID, UUID, DATE, DATE, INT, INT) TO authenticated;

-- ---------------------------------------------------------------------------
-- cash_movements_by_month: money in / out of bank GL accounts per month (base currency).
-- Own-account transfers (source_type bank_transfer) are excluded so they do not inflate both bars.
-- Bank GL = accounts of kind 'bank' or accounts linked from an active bank_accounts row.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cash_movements_by_month(
  _company_id UUID,
  _from DATE,
  _to DATE
)
RETURNS TABLE (month_start DATE, cash_in_minor BIGINT, cash_out_minor BIGINT)
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

  RETURN QUERY
  SELECT
    date_trunc('month', j.journal_date)::DATE AS month_start,
    COALESCE(SUM(
      CASE WHEN j.currency_code::TEXT = c.base_currency THEN jl.debit_minor
           ELSE round(jl.debit_minor::NUMERIC * j.fx_rate_to_base
                      * power(10::NUMERIC, COALESCE(bd.decimal_places, 2) - COALESCE(td.decimal_places, 2)))::BIGINT
      END), 0)::BIGINT AS cash_in_minor,
    COALESCE(SUM(
      CASE WHEN j.currency_code::TEXT = c.base_currency THEN jl.credit_minor
           ELSE round(jl.credit_minor::NUMERIC * j.fx_rate_to_base
                      * power(10::NUMERIC, COALESCE(bd.decimal_places, 2) - COALESCE(td.decimal_places, 2)))::BIGINT
      END), 0)::BIGINT AS cash_out_minor
  FROM public.journal_lines jl
  JOIN public.journals j ON j.id = jl.journal_id
  JOIN public.companies c ON c.id = j.company_id
  JOIN public.accounts a ON a.id = jl.account_id
  LEFT JOIN public.currency_decimals bd ON bd.code::TEXT = c.base_currency
  LEFT JOIN public.currency_decimals td ON td.code = j.currency_code
  WHERE jl.company_id = _company_id
    AND j.status = 'posted'
    AND j.source_type <> 'bank_transfer'
    AND j.journal_date >= _from
    AND j.journal_date <= _to
    AND (
      a.account_kind = 'bank'
      OR EXISTS (
        SELECT 1 FROM public.bank_accounts b
        WHERE b.gl_account_id = a.id AND b.company_id = _company_id AND b.is_active
      )
    )
  GROUP BY date_trunc('month', j.journal_date)
  ORDER BY 1;
END;
$$;

REVOKE ALL ON FUNCTION public.cash_movements_by_month(UUID, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cash_movements_by_month(UUID, DATE, DATE) TO authenticated;
