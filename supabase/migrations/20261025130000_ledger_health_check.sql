-- Wave 2 / E: ledger health check.
--
-- ledger_health_check(payload) runs read-only integrity checks on one company's ledger and returns
-- a JSON report with an honest pass / warn / fail per check. It changes nothing.
--
--   trial_balance      posted journals sum to zero in the base currency (rounding tolerance reported as warn)
--   unbalanced         every posted journal balances in its own currency
--   orphans            lines without a journal / account in the same company; posted journals without lines
--   document_journals  every issued document has a live posted journal; voided documents do not
--   subledger_ar / _ap open documents equal the control account, per currency, in that currency.
--                      FX adjustment journals (realised FX, revaluation and their reversals) are left out
--                      because they move base-currency value only.
--   period_locks       journals posted after their period or lock date was set, and journals dated
--                      outside their accounting period
--   automation         auto-reversals that failed or are overdue
--
-- Additive and idempotent. No is_demo logic: the Demo Company is checked like any other company.

CREATE OR REPLACE FUNCTION public.ledger_health_check(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _company UUID := NULLIF(payload->>'company_id', '')::UUID;
  _base CHAR(3);
  _checks JSONB := '[]'::jsonb;
  _status TEXT;
  _overall TEXT := 'pass';
  _count BIGINT;
  _items JSONB;
  _debit BIGINT;
  _credit BIGINT;
  _diff BIGINT;
  _foreign BIGINT;
  _ar_ids UUID[];
  _ap_ids UUID[];
  _role TEXT;
  _ids UUID[];
  _label TEXT;
  _bad INTEGER;
  _journals BIGINT;
  _lines BIGINT;
BEGIN
  IF _company IS NULL THEN RAISE EXCEPTION 'company_id is required'; END IF;
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.is_company_member(_company) THEN RAISE EXCEPTION 'You do not have access to that organisation'; END IF;
  IF NOT public.has_company_permission(_company, 'accounting.view') THEN
    RAISE EXCEPTION 'You do not have permission to view accounting';
  END IF;
  SELECT base_currency INTO _base FROM public.companies WHERE id = _company;
  IF _base IS NULL THEN RAISE EXCEPTION 'Organisation not found'; END IF;

  SELECT count(*) INTO _journals FROM public.journals WHERE company_id = _company AND status = 'posted';
  SELECT count(*) INTO _lines
  FROM public.journal_lines jl JOIN public.journals j ON j.id = jl.journal_id
  WHERE j.company_id = _company AND j.status = 'posted';

  -- 1. Trial balance ---------------------------------------------------------------------------
  SELECT COALESCE(SUM(public.fx_to_base_minor(jl.debit_minor, j.fx_rate_to_base, j.currency_code, _base)), 0),
         COALESCE(SUM(public.fx_to_base_minor(jl.credit_minor, j.fx_rate_to_base, j.currency_code, _base)), 0)
    INTO _debit, _credit
  FROM public.journal_lines jl JOIN public.journals j ON j.id = jl.journal_id
  WHERE j.company_id = _company AND j.status = 'posted';
  _diff := _debit - _credit;
  SELECT count(*) INTO _foreign
  FROM public.journals j
  WHERE j.company_id = _company AND j.status = 'posted' AND upper(j.currency_code::TEXT) <> upper(_base::TEXT);
  _status := CASE WHEN _diff = 0 THEN 'pass' WHEN abs(_diff) <= _foreign THEN 'warn' ELSE 'fail' END;
  _checks := _checks || jsonb_build_array(jsonb_build_object(
    'key', 'trial_balance', 'label', 'Trial balance is zero', 'status', _status, 'count', CASE WHEN _diff = 0 THEN 0 ELSE 1 END,
    'summary', CASE _status
      WHEN 'pass' THEN 'Debits and credits agree in the base currency.'
      WHEN 'warn' THEN 'Debits and credits differ by ' || _diff || ' minor units, within the rounding tolerance of ' || _foreign
                       || ' foreign-currency journal(s) (each converts at one rate).'
      ELSE 'Debits and credits differ by ' || _diff || ' minor units in the base currency. This is more than rounding.' END,
    'items', jsonb_build_array(jsonb_build_object('debit_minor', _debit, 'credit_minor', _credit, 'difference_minor', _diff))));

  -- 2. Unbalanced journals ---------------------------------------------------------------------
  WITH u AS (
    SELECT j.id, j.journal_number, j.journal_date, j.currency_code::TEXT AS currency,
           SUM(jl.debit_minor) AS d, SUM(jl.credit_minor) AS c
    FROM public.journals j JOIN public.journal_lines jl ON jl.journal_id = j.id
    WHERE j.company_id = _company AND j.status = 'posted'
    GROUP BY j.id, j.journal_number, j.journal_date, j.currency_code
    HAVING SUM(jl.debit_minor) <> SUM(jl.credit_minor)
  )
  SELECT (SELECT count(*) FROM u),
         COALESCE((SELECT jsonb_agg(jsonb_build_object('journal_id', id, 'journal_number', journal_number,
                   'journal_date', journal_date, 'currency', currency, 'debit_minor', d, 'credit_minor', c)
                   ORDER BY journal_date, journal_number) FROM (SELECT * FROM u ORDER BY journal_date, journal_number LIMIT 25) x), '[]'::jsonb)
    INTO _count, _items;
  _checks := _checks || jsonb_build_array(jsonb_build_object(
    'key', 'unbalanced', 'label', 'Every journal balances', 'status', CASE WHEN _count = 0 THEN 'pass' ELSE 'fail' END,
    'count', _count,
    'summary', CASE WHEN _count = 0 THEN _journals || ' posted journal(s) checked; all balance.'
                    ELSE _count || ' posted journal(s) do not balance in their own currency.' END,
    'items', _items));

  -- 3. Orphans ---------------------------------------------------------------------------------
  WITH o AS (
    SELECT 'line_without_journal' AS problem, jl.id AS ref, NULL::BIGINT AS journal_number
    FROM public.journal_lines jl
    WHERE jl.company_id = _company AND NOT EXISTS (SELECT 1 FROM public.journals j WHERE j.id = jl.journal_id)
    UNION ALL
    SELECT 'line_company_differs_from_journal', jl.id, j.journal_number
    FROM public.journal_lines jl JOIN public.journals j ON j.id = jl.journal_id
    WHERE jl.company_id = _company AND j.company_id <> jl.company_id
    UNION ALL
    SELECT 'line_account_missing_or_other_company', jl.id, j.journal_number
    FROM public.journal_lines jl LEFT JOIN public.journals j ON j.id = jl.journal_id
    WHERE jl.company_id = _company
      AND NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = jl.account_id AND a.company_id = jl.company_id)
    UNION ALL
    SELECT 'posted_journal_without_lines', j.id, j.journal_number
    FROM public.journals j
    WHERE j.company_id = _company AND j.status = 'posted'
      AND NOT EXISTS (SELECT 1 FROM public.journal_lines jl WHERE jl.journal_id = j.id)
  )
  SELECT (SELECT count(*) FROM o),
         COALESCE((SELECT jsonb_agg(jsonb_build_object('problem', problem, 'id', ref, 'journal_number', journal_number))
                   FROM (SELECT * FROM o ORDER BY problem, ref LIMIT 25) x), '[]'::jsonb)
    INTO _count, _items;
  _checks := _checks || jsonb_build_array(jsonb_build_object(
    'key', 'orphans', 'label', 'No orphan journal lines', 'status', CASE WHEN _count = 0 THEN 'pass' ELSE 'fail' END,
    'count', _count,
    'summary', CASE WHEN _count = 0 THEN _lines || ' posted line(s) checked; all belong to a journal and account of this organisation.'
                    ELSE _count || ' journal line(s) or journals are orphaned or point outside this organisation.' END,
    'items', _items));

  -- 4. Documents and their journals ------------------------------------------------------------
  WITH d AS (
    SELECT 'Sales invoice' AS doc_type, t.id, t.invoice_number AS ref, t.invoice_date AS doc_date, t.status::TEXT AS status, t.posted_journal_id AS jid
    FROM public.sales_invoices t WHERE t.company_id = _company AND t.status::TEXT <> 'draft'
    UNION ALL
    SELECT 'Sales credit note', t.id, t.credit_number, t.credit_date, t.status::TEXT, t.posted_journal_id
    FROM public.sales_credit_notes t WHERE t.company_id = _company AND t.status::TEXT <> 'draft'
    UNION ALL
    SELECT 'Supplier bill', t.id, t.bill_number, t.bill_date, t.status::TEXT, t.posted_journal_id
    FROM public.purchase_bills t WHERE t.company_id = _company AND t.status::TEXT NOT IN ('draft', 'awaiting_approval')
    UNION ALL
    SELECT 'Supplier credit note', t.id, t.credit_number, t.credit_date, t.status::TEXT, t.posted_journal_id
    FROM public.purchase_credit_notes t WHERE t.company_id = _company AND t.status::TEXT NOT IN ('draft', 'awaiting_approval')
    UNION ALL
    SELECT 'Expense', t.id, NULL, t.expense_date, t.status::TEXT, t.posted_journal_id
    FROM public.purchase_expenses t WHERE t.company_id = _company AND t.status::TEXT NOT IN ('draft', 'awaiting_approval')
    UNION ALL
    SELECT 'Customer receipt', t.id, NULL, t.receipt_date, t.status, t.posted_journal_id
    FROM public.sales_receipts t WHERE t.company_id = _company
    UNION ALL
    SELECT 'Supplier payment', t.id, NULL, t.payment_date, t.status::TEXT, t.posted_journal_id
    FROM public.supplier_payments t WHERE t.company_id = _company AND t.status::TEXT IN ('paid', 'void')
  ), p AS (
    SELECT d.doc_type, d.id, d.ref, d.doc_date, d.status,
           CASE
             WHEN d.status IN ('void', 'voided') THEN
               CASE WHEN j.id IS NOT NULL AND j.status = 'posted' AND j.reversed_by_journal_id IS NULL
                    THEN 'voided_but_journal_still_live' END
             WHEN d.jid IS NULL THEN 'no_journal'
             WHEN j.id IS NULL THEN 'journal_missing'
             WHEN j.status <> 'posted' THEN 'journal_not_posted'
             WHEN j.reversed_by_journal_id IS NOT NULL THEN 'journal_reversed_but_document_live'
           END AS problem
    FROM d LEFT JOIN public.journals j ON j.id = d.jid AND j.company_id = _company
  )
  SELECT (SELECT count(*) FROM p WHERE problem IS NOT NULL),
         COALESCE((SELECT jsonb_agg(jsonb_build_object('document_type', doc_type, 'id', id, 'reference', ref,
                   'document_date', doc_date, 'status', status, 'problem', problem))
                   FROM (SELECT * FROM p WHERE problem IS NOT NULL ORDER BY doc_date, doc_type LIMIT 25) x), '[]'::jsonb),
         (SELECT count(*) FROM p)
    INTO _count, _items, _lines;
  _checks := _checks || jsonb_build_array(jsonb_build_object(
    'key', 'document_journals', 'label', 'Every document has its journal', 'status', CASE WHEN _count = 0 THEN 'pass' ELSE 'fail' END,
    'count', _count,
    'summary', CASE WHEN _count = 0 THEN _lines || ' issued or voided document(s) checked; each matches its journal.'
                    ELSE _count || ' document(s) are missing a live posted journal, or are voided with a journal still in the ledger.' END,
    'items', _items));

  -- 5. AR / AP subledger against the control account, per currency -----------------------------
  FOREACH _role IN ARRAY ARRAY['ar', 'ap'] LOOP
    SELECT array_agg(a.id) INTO _ids
    FROM public.accounts a
    WHERE a.company_id = _company
      AND ((_role = 'ar' AND (a.system_key = 'ar' OR a.code = '1100'))
        OR (_role = 'ap' AND (a.system_key = 'ap' OR a.code = '2000')));
    _label := CASE WHEN _role = 'ar' THEN 'Receivables' ELSE 'Payables' END;
    IF _ids IS NULL THEN
      _checks := _checks || jsonb_build_array(jsonb_build_object(
        'key', 'subledger_' || _role, 'label', _label || ' agree to the ledger', 'status', 'na', 'count', 0,
        'summary', 'No ' || lower(_label) || ' control account is set up, so there is nothing to compare.', 'items', '[]'::jsonb));
      CONTINUE;
    END IF;

    WITH gl AS (
      SELECT j.currency_code::TEXT AS cur,
             SUM(CASE WHEN _role = 'ar' THEN jl.debit_minor - jl.credit_minor ELSE jl.credit_minor - jl.debit_minor END)::BIGINT AS amt
      FROM public.journal_lines jl JOIN public.journals j ON j.id = jl.journal_id
      WHERE j.company_id = _company AND j.status = 'posted' AND jl.account_id = ANY (_ids)
        AND j.source_type::TEXT NOT IN ('fx_realised', 'fx_revaluation')
        AND NOT EXISTS (SELECT 1 FROM public.journals o
                        WHERE o.id = j.reverses_journal_id AND o.source_type::TEXT IN ('fx_realised', 'fx_revaluation'))
      GROUP BY j.currency_code
    ), s AS (
      SELECT cur, SUM(amt)::BIGINT AS amt FROM (
        SELECT t.currency_code::TEXT AS cur, (t.total_minor - t.amount_paid_minor - t.amount_credited_minor) AS amt
          FROM public.sales_invoices t
          WHERE _role = 'ar' AND t.company_id = _company AND t.status::TEXT IN ('authorised', 'partly_paid', 'paid') AND t.posted_journal_id IS NOT NULL
        UNION ALL
        SELECT t.currency_code::TEXT, -(t.total_minor - t.amount_allocated_minor)
          FROM public.sales_credit_notes t
          WHERE _role = 'ar' AND t.company_id = _company AND t.status::TEXT IN ('authorised', 'partly_paid', 'paid') AND t.posted_journal_id IS NOT NULL
        UNION ALL
        SELECT t.currency_code::TEXT, -t.unallocated_minor
          FROM public.sales_receipts t
          WHERE _role = 'ar' AND t.company_id = _company AND t.status = 'posted' AND t.posted_journal_id IS NOT NULL
        UNION ALL
        SELECT t.currency_code::TEXT, (t.total_minor - t.amount_paid_minor - t.amount_credited_minor)
          FROM public.purchase_bills t
          WHERE _role = 'ap' AND t.company_id = _company AND t.status::TEXT IN ('authorised', 'partly_paid', 'paid') AND t.posted_journal_id IS NOT NULL
        UNION ALL
        SELECT t.currency_code::TEXT, -(t.total_minor - t.amount_allocated_minor)
          FROM public.purchase_credit_notes t
          WHERE _role = 'ap' AND t.company_id = _company AND t.status::TEXT IN ('authorised', 'partly_paid', 'paid') AND t.posted_journal_id IS NOT NULL
        UNION ALL
        SELECT t.currency_code::TEXT, -t.unallocated_minor
          FROM public.supplier_payments t
          WHERE _role = 'ap' AND t.company_id = _company AND t.status::TEXT = 'paid' AND t.posted_journal_id IS NOT NULL
      ) u GROUP BY cur
    ), cmp AS (
      SELECT COALESCE(gl.cur, s.cur) AS cur, COALESCE(gl.amt, 0) AS ledger, COALESCE(s.amt, 0) AS sub,
             COALESCE(gl.amt, 0) - COALESCE(s.amt, 0) AS variance
      FROM gl FULL OUTER JOIN s ON s.cur = gl.cur
    )
    SELECT (SELECT count(*) FROM cmp WHERE variance <> 0),
           COALESCE((SELECT jsonb_agg(jsonb_build_object('currency', cur, 'ledger_minor', ledger, 'documents_minor', sub, 'variance_minor', variance) ORDER BY cur)
                     FROM cmp WHERE variance <> 0 OR ledger <> 0 OR sub <> 0), '[]'::jsonb)
      INTO _count, _items;
    _checks := _checks || jsonb_build_array(jsonb_build_object(
      'key', 'subledger_' || _role, 'label', _label || ' agree to the ledger', 'status', CASE WHEN _count = 0 THEN 'pass' ELSE 'fail' END,
      'count', _count,
      'summary', CASE WHEN _count = 0
                      THEN 'Open documents, unapplied credits and unallocated payments equal the control account in every currency.'
                      ELSE 'In ' || _count || ' currency(ies) the open documents differ from the control account.' END,
      'items', _items));
  END LOOP;

  -- 6. Period locks ----------------------------------------------------------------------------
  WITH v AS (
    SELECT 'posted_after_period_lock' AS problem, j.id, j.journal_number, j.journal_date, j.posted_at
    FROM public.journals j JOIN public.accounting_periods ap ON ap.id = j.period_id
    WHERE j.company_id = _company AND j.status = 'posted'
      AND ap.status::TEXT IN ('locked', 'closed') AND ap.locked_at IS NOT NULL
      AND j.posted_at IS NOT NULL AND j.posted_at > ap.locked_at + interval '1 second'
    UNION ALL
    SELECT 'posted_after_lock_date', j.id, j.journal_number, j.journal_date, j.posted_at
    FROM public.journals j JOIN public.organisation_lock_policy pol ON pol.company_id = j.company_id
    WHERE j.company_id = _company AND j.status = 'posted'
      AND pol.lock_date_everyone IS NOT NULL AND j.journal_date <= pol.lock_date_everyone
      AND j.posted_at IS NOT NULL AND j.posted_at > pol.updated_at + interval '1 second'
    UNION ALL
    SELECT 'dated_outside_its_period', j.id, j.journal_number, j.journal_date, j.posted_at
    FROM public.journals j JOIN public.accounting_periods ap ON ap.id = j.period_id
    WHERE j.company_id = _company AND j.status = 'posted'
      AND (j.journal_date < ap.start_date OR j.journal_date > ap.end_date)
  )
  SELECT (SELECT count(*) FROM v),
         COALESCE((SELECT jsonb_agg(jsonb_build_object('problem', problem, 'journal_id', id, 'journal_number', journal_number,
                   'journal_date', journal_date, 'posted_at', posted_at))
                   FROM (SELECT * FROM v ORDER BY journal_date, journal_number LIMIT 25) x), '[]'::jsonb)
    INTO _count, _items;
  _checks := _checks || jsonb_build_array(jsonb_build_object(
    'key', 'period_locks', 'label', 'No period-lock violations', 'status', CASE WHEN _count = 0 THEN 'pass' ELSE 'fail' END,
    'count', _count,
    'summary', CASE WHEN _count = 0 THEN 'No journal was posted into a locked period after it was locked, and none sits outside its period.'
                    ELSE _count || ' journal(s) were posted after their period or lock date was set, or sit outside their period. An adviser override can explain the first kind; review each one.' END,
    'items', _items));

  -- 7. Automation: auto-reversals ---------------------------------------------------------------
  WITH a AS (
    SELECT CASE WHEN r.status = 'failed' THEN 'failed' ELSE 'overdue' END AS problem,
           r.id, r.journal_id, r.reverse_on, r.attempts, r.last_error
    FROM public.journal_auto_reversals r
    WHERE r.company_id = _company
      AND (r.status = 'failed' OR (r.status = 'pending' AND r.reverse_on < CURRENT_DATE))
  )
  SELECT (SELECT count(*) FROM a),
         COALESCE((SELECT jsonb_agg(jsonb_build_object('problem', problem, 'id', id, 'journal_id', journal_id,
                   'reverse_on', reverse_on, 'attempts', attempts, 'error', last_error))
                   FROM (SELECT * FROM a ORDER BY reverse_on LIMIT 25) x), '[]'::jsonb),
         (SELECT count(*) FROM a WHERE problem = 'failed')
    INTO _count, _items, _bad;
  _checks := _checks || jsonb_build_array(jsonb_build_object(
    'key', 'automation', 'label', 'Auto-reversals are up to date',
    'status', CASE WHEN _bad > 0 THEN 'fail' WHEN _count > 0 THEN 'warn' ELSE 'pass' END,
    'count', _count,
    'summary', CASE WHEN _count = 0 THEN 'No auto-reversal has failed or is overdue.'
                    WHEN _bad > 0 THEN _bad || ' auto-reversal(s) failed. Fix the cause and run due reversals again.'
                    ELSE _count || ' auto-reversal(s) are overdue. Run due reversals from Accounting > FX & reversals, or set up the scheduler.' END,
    'items', _items));

  SELECT CASE WHEN bool_or(c->>'status' = 'fail') THEN 'fail'
              WHEN bool_or(c->>'status' = 'warn') THEN 'warn' ELSE 'pass' END
    INTO _overall
  FROM jsonb_array_elements(_checks) c;

  RETURN jsonb_build_object(
    'company_id', _company,
    'base_currency', _base,
    'generated_at', now(),
    'overall', _overall,
    'journals_checked', _journals,
    'lines_checked', (SELECT count(*) FROM public.journal_lines jl JOIN public.journals j ON j.id = jl.journal_id
                      WHERE j.company_id = _company AND j.status = 'posted'),
    'checks', _checks);
END;
$$;

REVOKE ALL ON FUNCTION public.ledger_health_check(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ledger_health_check(JSONB) TO authenticated;
