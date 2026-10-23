-- Wave 2 / I (reporting & planning): report RPCs computed in the database (no PostgREST 1000-row cap).
--
-- All functions are read-only, SECURITY DEFINER, `set search_path = public`, check auth.uid() and
-- is_company_member(), read POSTED data only, and convert to the company base currency with the
-- journal's fx_rate_to_base, decimal-aware, rounding half away from zero (same rule as
-- public.ledger_balances and src/lib/accounting/fx.ts). is_demo plays no part in any of them.
--
--   ledger_monthly_activity          per account per month debit/credit (budget actuals, trends)
--   report_cash_summary              per bank account: opening, received, spent, transfers, closing
--   report_gl_summary                per account: opening, debits, credits, closing
--   report_sales_by_contact          invoices less credit notes per customer
--   report_sales_by_item             invoice and credit-note lines per product
--   report_purchases_by_supplier     bills less credit notes per supplier
--   report_bank_reconciliation_summary  book balance vs last reconciliation and uncleared items
--
-- Additive and idempotent. Requires 20261024130000_reporting_ledger_rpcs.sql (currency_decimals etc).

-- ---------------------------------------------------------------------------
-- Helper: one decimal-aware converter for document amounts (journals use the same expression inline)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.report_to_base_minor(
  _minor BIGINT,
  _txn_currency TEXT,
  _rate NUMERIC,
  _base_currency TEXT
)
RETURNS BIGINT
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN _minor IS NULL THEN 0
    WHEN _txn_currency = _base_currency THEN _minor
    ELSE round(
      _minor::NUMERIC * COALESCE(_rate, 1)
      * power(
          10::NUMERIC,
          COALESCE((SELECT decimal_places FROM public.currency_decimals WHERE code::TEXT = _base_currency), 2)
          - COALESCE((SELECT decimal_places FROM public.currency_decimals WHERE code::TEXT = _txn_currency), 2)
        )
    )::BIGINT
  END;
$$;

REVOKE ALL ON FUNCTION public.report_to_base_minor(BIGINT, TEXT, NUMERIC, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_to_base_minor(BIGINT, TEXT, NUMERIC, TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- ledger_monthly_activity
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ledger_monthly_activity(
  _company_id UUID,
  _from DATE,
  _to DATE,
  _exclude_year_end_close BOOLEAN DEFAULT TRUE
)
RETURNS TABLE (account_id UUID, month DATE, debit_minor BIGINT, credit_minor BIGINT)
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
  SELECT
    jl.account_id,
    date_trunc('month', j.journal_date)::DATE AS month,
    COALESCE(SUM(public.report_to_base_minor(jl.debit_minor, j.currency_code::TEXT, j.fx_rate_to_base, c.base_currency)), 0)::BIGINT,
    COALESCE(SUM(public.report_to_base_minor(jl.credit_minor, j.currency_code::TEXT, j.fx_rate_to_base, c.base_currency)), 0)::BIGINT
  FROM public.journal_lines jl
  JOIN public.journals j ON j.id = jl.journal_id
  JOIN public.companies c ON c.id = j.company_id
  WHERE jl.company_id = _company_id
    AND j.company_id = _company_id
    AND j.status = 'posted'
    AND j.journal_date >= _from
    AND j.journal_date <= _to
    AND (NOT _exclude_year_end_close
         OR NOT (j.source_type = 'other' AND COALESCE(j.memo, '') LIKE 'Year-end close%'))
  GROUP BY jl.account_id, date_trunc('month', j.journal_date)
  ORDER BY 1, 2;
END;
$$;

REVOKE ALL ON FUNCTION public.ledger_monthly_activity(UUID, DATE, DATE, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ledger_monthly_activity(UUID, DATE, DATE, BOOLEAN) TO authenticated;

-- ---------------------------------------------------------------------------
-- report_cash_summary: movements on each bank account's ledger account.
-- Transfers between the company's own bank accounts (source_type bank_transfer) are shown on their
-- own columns so they do not inflate cash received / spent.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.report_cash_summary(
  _company_id UUID,
  _from DATE,
  _to DATE
)
RETURNS TABLE (
  bank_account_id UUID,
  bank_account_name TEXT,
  gl_account_id UUID,
  gl_account_code TEXT,
  opening_minor BIGINT,
  received_minor BIGINT,
  spent_minor BIGINT,
  transfers_in_minor BIGINT,
  transfers_out_minor BIGINT,
  closing_minor BIGINT
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
  WITH lines AS (
    SELECT
      ba.id AS bank_account_id,
      j.journal_date,
      (j.source_type = 'bank_transfer') AS is_transfer,
      public.report_to_base_minor(jl.debit_minor, j.currency_code::TEXT, j.fx_rate_to_base, c.base_currency) AS debit,
      public.report_to_base_minor(jl.credit_minor, j.currency_code::TEXT, j.fx_rate_to_base, c.base_currency) AS credit
    FROM public.bank_accounts ba
    JOIN public.journal_lines jl ON jl.account_id = ba.gl_account_id AND jl.company_id = ba.company_id
    JOIN public.journals j ON j.id = jl.journal_id AND j.status = 'posted'
    JOIN public.companies c ON c.id = ba.company_id
    WHERE ba.company_id = _company_id
      AND j.journal_date <= _to
  )
  SELECT
    ba.id,
    ba.name,
    ba.gl_account_id,
    a.code,
    COALESCE(SUM(l.debit - l.credit) FILTER (WHERE l.journal_date < _from), 0)::BIGINT,
    COALESCE(SUM(l.debit) FILTER (WHERE l.journal_date >= _from AND NOT l.is_transfer), 0)::BIGINT,
    COALESCE(SUM(l.credit) FILTER (WHERE l.journal_date >= _from AND NOT l.is_transfer), 0)::BIGINT,
    COALESCE(SUM(l.debit) FILTER (WHERE l.journal_date >= _from AND l.is_transfer), 0)::BIGINT,
    COALESCE(SUM(l.credit) FILTER (WHERE l.journal_date >= _from AND l.is_transfer), 0)::BIGINT,
    COALESCE(SUM(l.debit - l.credit), 0)::BIGINT
  FROM public.bank_accounts ba
  JOIN public.accounts a ON a.id = ba.gl_account_id
  LEFT JOIN lines l ON l.bank_account_id = ba.id
  WHERE ba.company_id = _company_id
  GROUP BY ba.id, ba.name, ba.gl_account_id, a.code, ba.is_active
  HAVING ba.is_active OR COUNT(l.bank_account_id) > 0
  ORDER BY a.code, ba.name;
END;
$$;

REVOKE ALL ON FUNCTION public.report_cash_summary(UUID, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_cash_summary(UUID, DATE, DATE) TO authenticated;

-- ---------------------------------------------------------------------------
-- report_gl_summary: one row per account with opening, period debits / credits and closing.
-- Year-end closing journals are INCLUDED: this is the ledger exactly as posted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.report_gl_summary(
  _company_id UUID,
  _from DATE,
  _to DATE
)
RETURNS TABLE (
  account_id UUID,
  account_code TEXT,
  account_name TEXT,
  account_type TEXT,
  opening_minor BIGINT,
  debit_minor BIGINT,
  credit_minor BIGINT,
  closing_minor BIGINT,
  line_count BIGINT
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
  WITH lines AS (
    SELECT
      jl.account_id,
      j.journal_date,
      public.report_to_base_minor(jl.debit_minor, j.currency_code::TEXT, j.fx_rate_to_base, c.base_currency) AS debit,
      public.report_to_base_minor(jl.credit_minor, j.currency_code::TEXT, j.fx_rate_to_base, c.base_currency) AS credit
    FROM public.journal_lines jl
    JOIN public.journals j ON j.id = jl.journal_id AND j.status = 'posted'
    JOIN public.companies c ON c.id = j.company_id
    WHERE jl.company_id = _company_id
      AND j.company_id = _company_id
      AND j.journal_date <= _to
  )
  SELECT
    a.id,
    a.code,
    a.name,
    a.account_type::TEXT,
    COALESCE(SUM(l.debit - l.credit) FILTER (WHERE l.journal_date < _from), 0)::BIGINT,
    COALESCE(SUM(l.debit) FILTER (WHERE l.journal_date >= _from), 0)::BIGINT,
    COALESCE(SUM(l.credit) FILTER (WHERE l.journal_date >= _from), 0)::BIGINT,
    COALESCE(SUM(l.debit - l.credit), 0)::BIGINT,
    (COUNT(*) FILTER (WHERE l.journal_date >= _from))::BIGINT
  FROM lines l
  JOIN public.accounts a ON a.id = l.account_id
  GROUP BY a.id, a.code, a.name, a.account_type
  HAVING COALESCE(SUM(l.debit - l.credit), 0) <> 0
      OR COUNT(*) FILTER (WHERE l.journal_date >= _from) > 0
  ORDER BY a.code;
END;
$$;

REVOKE ALL ON FUNCTION public.report_gl_summary(UUID, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_gl_summary(UUID, DATE, DATE) TO authenticated;

-- ---------------------------------------------------------------------------
-- report_sales_by_contact: authorised / part-paid / paid invoices less credit notes in the period.
-- Voided and draft documents are excluded. Each document is converted at its posted journal's rate.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.report_sales_by_contact(
  _company_id UUID,
  _from DATE,
  _to DATE
)
RETURNS TABLE (
  contact_id UUID,
  contact_name TEXT,
  invoice_count BIGINT,
  credit_note_count BIGINT,
  net_minor BIGINT,
  tax_minor BIGINT,
  gross_minor BIGINT
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
  WITH docs AS (
    SELECT i.contact_id, 1 AS inv, 0 AS cn,
      public.report_to_base_minor(i.subtotal_minor, pj.currency_code::TEXT, pj.fx_rate_to_base, c.base_currency) AS net,
      public.report_to_base_minor(i.tax_minor, pj.currency_code::TEXT, pj.fx_rate_to_base, c.base_currency) AS tax
    FROM public.sales_invoices i
    JOIN public.journals pj ON pj.id = i.posted_journal_id
    JOIN public.companies c ON c.id = i.company_id
    WHERE i.company_id = _company_id
      AND i.status IN ('authorised', 'partly_paid', 'paid')
      AND i.invoice_date BETWEEN _from AND _to
    UNION ALL
    SELECT n.contact_id, 0, 1,
      -public.report_to_base_minor(n.subtotal_minor, pj.currency_code::TEXT, pj.fx_rate_to_base, c.base_currency),
      -public.report_to_base_minor(n.tax_minor, pj.currency_code::TEXT, pj.fx_rate_to_base, c.base_currency)
    FROM public.sales_credit_notes n
    JOIN public.journals pj ON pj.id = n.posted_journal_id
    JOIN public.companies c ON c.id = n.company_id
    WHERE n.company_id = _company_id
      AND n.status IN ('authorised', 'partly_paid', 'paid')
      AND n.credit_date BETWEEN _from AND _to
  )
  SELECT d.contact_id, ct.name, SUM(d.inv)::BIGINT, SUM(d.cn)::BIGINT,
         SUM(d.net)::BIGINT, SUM(d.tax)::BIGINT, SUM(d.net + d.tax)::BIGINT
  FROM docs d
  JOIN public.contacts ct ON ct.id = d.contact_id
  GROUP BY d.contact_id, ct.name
  ORDER BY SUM(d.net) DESC, ct.name;
END;
$$;

REVOKE ALL ON FUNCTION public.report_sales_by_contact(UUID, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_sales_by_contact(UUID, DATE, DATE) TO authenticated;

-- ---------------------------------------------------------------------------
-- report_sales_by_item: invoice lines less credit-note lines per product. Lines with no product are
-- grouped together with a NULL product_id (the UI labels them "No item").
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.report_sales_by_item(
  _company_id UUID,
  _from DATE,
  _to DATE
)
RETURNS TABLE (
  product_id UUID,
  item_code TEXT,
  item_name TEXT,
  quantity NUMERIC,
  line_count BIGINT,
  net_minor BIGINT,
  tax_minor BIGINT
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
  WITH ls AS (
    SELECT l.product_id, l.quantity AS qty,
      public.report_to_base_minor(l.net_minor, pj.currency_code::TEXT, pj.fx_rate_to_base, c.base_currency) AS net,
      public.report_to_base_minor(l.tax_minor, pj.currency_code::TEXT, pj.fx_rate_to_base, c.base_currency) AS tax
    FROM public.sales_invoice_lines l
    JOIN public.sales_invoices i ON i.id = l.invoice_id
    JOIN public.journals pj ON pj.id = i.posted_journal_id
    JOIN public.companies c ON c.id = i.company_id
    WHERE i.company_id = _company_id
      AND i.status IN ('authorised', 'partly_paid', 'paid')
      AND i.invoice_date BETWEEN _from AND _to
    UNION ALL
    SELECT l.product_id, -l.quantity,
      -public.report_to_base_minor(l.net_minor, pj.currency_code::TEXT, pj.fx_rate_to_base, c.base_currency),
      -public.report_to_base_minor(l.tax_minor, pj.currency_code::TEXT, pj.fx_rate_to_base, c.base_currency)
    FROM public.sales_credit_note_lines l
    JOIN public.sales_credit_notes n ON n.id = l.credit_note_id
    JOIN public.journals pj ON pj.id = n.posted_journal_id
    JOIN public.companies c ON c.id = n.company_id
    WHERE n.company_id = _company_id
      AND n.status IN ('authorised', 'partly_paid', 'paid')
      AND n.credit_date BETWEEN _from AND _to
  )
  SELECT ls.product_id, p.code, p.name, SUM(ls.qty), COUNT(*)::BIGINT,
         SUM(ls.net)::BIGINT, SUM(ls.tax)::BIGINT
  FROM ls
  LEFT JOIN public.products p ON p.id = ls.product_id
  GROUP BY ls.product_id, p.code, p.name
  ORDER BY SUM(ls.net) DESC, p.name NULLS LAST;
END;
$$;

REVOKE ALL ON FUNCTION public.report_sales_by_item(UUID, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_sales_by_item(UUID, DATE, DATE) TO authenticated;

-- ---------------------------------------------------------------------------
-- report_purchases_by_supplier: bills less supplier credit notes in the period.
-- Direct expenses (purchase_expenses) are not included.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.report_purchases_by_supplier(
  _company_id UUID,
  _from DATE,
  _to DATE
)
RETURNS TABLE (
  contact_id UUID,
  contact_name TEXT,
  bill_count BIGINT,
  credit_note_count BIGINT,
  net_minor BIGINT,
  tax_minor BIGINT,
  gross_minor BIGINT
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
  WITH docs AS (
    SELECT b.contact_id, 1 AS bills, 0 AS cn,
      public.report_to_base_minor(b.subtotal_minor, pj.currency_code::TEXT, pj.fx_rate_to_base, c.base_currency) AS net,
      public.report_to_base_minor(b.tax_minor, pj.currency_code::TEXT, pj.fx_rate_to_base, c.base_currency) AS tax
    FROM public.purchase_bills b
    JOIN public.journals pj ON pj.id = b.posted_journal_id
    JOIN public.companies c ON c.id = b.company_id
    WHERE b.company_id = _company_id
      AND b.status IN ('authorised', 'partly_paid', 'paid')
      AND b.bill_date BETWEEN _from AND _to
    UNION ALL
    SELECT n.contact_id, 0, 1,
      -public.report_to_base_minor(n.subtotal_minor, pj.currency_code::TEXT, pj.fx_rate_to_base, c.base_currency),
      -public.report_to_base_minor(n.tax_minor, pj.currency_code::TEXT, pj.fx_rate_to_base, c.base_currency)
    FROM public.purchase_credit_notes n
    JOIN public.journals pj ON pj.id = n.posted_journal_id
    JOIN public.companies c ON c.id = n.company_id
    WHERE n.company_id = _company_id
      AND n.status IN ('authorised', 'partly_paid', 'paid')
      AND n.credit_date BETWEEN _from AND _to
  )
  SELECT d.contact_id, ct.name, SUM(d.bills)::BIGINT, SUM(d.cn)::BIGINT,
         SUM(d.net)::BIGINT, SUM(d.tax)::BIGINT, SUM(d.net + d.tax)::BIGINT
  FROM docs d
  JOIN public.contacts ct ON ct.id = d.contact_id
  GROUP BY d.contact_id, ct.name
  ORDER BY SUM(d.net) DESC, ct.name;
END;
$$;

REVOKE ALL ON FUNCTION public.report_purchases_by_supplier(UUID, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_purchases_by_supplier(UUID, DATE, DATE) TO authenticated;

-- ---------------------------------------------------------------------------
-- report_bank_reconciliation_summary (as at a date), per active bank account:
--   book balance (ledger, raw journal amounts like the reconciliation screen)
--   last completed reconciliation on or before the date (statement date and closing balance)
--   uncleared ledger items: posted lines on or before the date not in a completed reconciliation
--   uncoded statement lines: imported lines still 'uncategorised'
--   difference = book − (last statement balance + uncleared ledger net). Non-zero means the ledger
--   and the reconciled history disagree (for example sessions completed before ticked-line history
--   was recorded) and needs investigation. It is NULL when no reconciliation exists yet.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.report_bank_reconciliation_summary(
  _company_id UUID,
  _as_of DATE
)
RETURNS TABLE (
  bank_account_id UUID,
  bank_account_name TEXT,
  currency_code TEXT,
  gl_account_id UUID,
  book_balance_minor BIGINT,
  last_reconciled_date DATE,
  last_statement_balance_minor BIGINT,
  uncleared_line_count BIGINT,
  uncleared_net_minor BIGINT,
  uncoded_statement_count BIGINT,
  uncoded_statement_minor BIGINT,
  difference_minor BIGINT
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
  WITH acct AS (
    SELECT ba.id, ba.name, ba.currency_code::TEXT AS cur, ba.gl_account_id
    FROM public.bank_accounts ba
    WHERE ba.company_id = _company_id AND ba.is_active
  ),
  gl AS (
    SELECT a.id AS bank_id, jl.id AS line_id, (jl.debit_minor - jl.credit_minor) AS net,
      (
        EXISTS (
          SELECT 1 FROM public.reconciliation_session_lines sl
          JOIN public.reconciliation_sessions s ON s.id = sl.session_id AND s.status = 'completed'
          WHERE sl.journal_line_id = jl.id
        )
        OR EXISTS (
          SELECT 1 FROM public.reconciliation_links rl
          JOIN public.bank_transactions bt ON bt.id = rl.bank_transaction_id AND bt.status = 'reconciled'
          WHERE rl.journal_line_id = jl.id
        )
      ) AS cleared
    FROM acct a
    JOIN public.journal_lines jl ON jl.account_id = a.gl_account_id AND jl.company_id = _company_id
    JOIN public.journals j ON j.id = jl.journal_id AND j.status = 'posted'
    WHERE j.journal_date <= _as_of
  ),
  gl_totals AS (
    SELECT g.bank_id,
      COALESCE(SUM(g.net), 0)::BIGINT AS book,
      COUNT(*) FILTER (WHERE NOT g.cleared)::BIGINT AS unc_n,
      COALESCE(SUM(g.net) FILTER (WHERE NOT g.cleared), 0)::BIGINT AS unc_net
    FROM gl g GROUP BY g.bank_id
  ),
  last_rec AS (
    SELECT DISTINCT ON (s.bank_account_id)
      s.bank_account_id, s.statement_date, s.statement_balance_minor
    FROM public.reconciliation_sessions s
    WHERE s.company_id = _company_id AND s.status = 'completed' AND s.statement_date <= _as_of
    ORDER BY s.bank_account_id, s.statement_date DESC, s.created_at DESC
  ),
  stmt AS (
    SELECT bt.bank_account_id AS bank_id, COUNT(*)::BIGINT AS n, COALESCE(SUM(bt.amount_minor), 0)::BIGINT AS total
    FROM public.bank_transactions bt
    WHERE bt.company_id = _company_id AND bt.status = 'uncategorised' AND bt.txn_date <= _as_of
    GROUP BY bt.bank_account_id
  )
  SELECT
    a.id,
    a.name,
    a.cur,
    a.gl_account_id,
    COALESCE(t.book, 0)::BIGINT,
    lr.statement_date,
    lr.statement_balance_minor,
    COALESCE(t.unc_n, 0)::BIGINT,
    COALESCE(t.unc_net, 0)::BIGINT,
    COALESCE(s.n, 0)::BIGINT,
    COALESCE(s.total, 0)::BIGINT,
    CASE WHEN lr.statement_date IS NULL THEN NULL
         ELSE (COALESCE(t.book, 0) - (lr.statement_balance_minor + COALESCE(t.unc_net, 0)))::BIGINT END
  FROM acct a
  LEFT JOIN gl_totals t ON t.bank_id = a.id
  LEFT JOIN last_rec lr ON lr.bank_account_id = a.id
  LEFT JOIN stmt s ON s.bank_id = a.id
  ORDER BY a.name;
END;
$$;

REVOKE ALL ON FUNCTION public.report_bank_reconciliation_summary(UUID, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_bank_reconciliation_summary(UUID, DATE) TO authenticated;
