-- Workstream C (Banking) — tick-based statement reconciliation + SQL balance.
-- Requires 20261024120000_bank_matching_schema.sql.

-- ---------------------------------------------------------------------------
-- account_balance_as_of: SUM() in SQL (no PostgREST 1000-row cap). Posted journals only.
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
  _total BIGINT;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;

  SELECT COALESCE(SUM(jl.debit_minor - jl.credit_minor), 0)::BIGINT
  INTO _total
  FROM public.journal_lines jl
  JOIN public.journals j ON j.id = jl.journal_id
  WHERE jl.company_id = _company_id
    AND jl.account_id = _account_id
    AND j.status = 'posted'
    AND (_as_of IS NULL OR j.journal_date <= _as_of);

  RETURN _total;
END;
$$;

-- ---------------------------------------------------------------------------
-- complete_reconciliation_session
--   opening + cleared (ticked) = statement closing, difference must be exactly 0.
--   Ticks are either matched statement lines (their whole match group is cleared) or
--   ledger lines on the bank account that have no statement line (e.g. not imported).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.complete_reconciliation_session(
  _company_id UUID,
  _bank_account_id UUID,
  _statement_date DATE,
  _statement_balance_minor BIGINT,
  _opening_balance_minor BIGINT,
  _bank_transaction_ids UUID[] DEFAULT ARRAY[]::UUID[],
  _journal_line_ids UUID[] DEFAULT ARRAY[]::UUID[],
  _notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _gl UUID;
  _prev RECORD;
  _txn_ids UUID[];
  _gl_ids UUID[];
  _linked_lines UUID[];
  _group_txns UUID[];
  _n INT;
  _bad INT;
  _cleared BIGINT;
  _diff BIGINT;
  _uncat INT;
  _ledger BIGINT;
  _session_id UUID;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT public.has_company_permission(_company_id, 'banking.reconcile') THEN
    RAISE EXCEPTION 'You do not have permission to reconcile';
  END IF;
  IF _statement_date IS NULL THEN RAISE EXCEPTION 'Statement date is required'; END IF;
  IF _statement_balance_minor IS NULL THEN RAISE EXCEPTION 'Statement closing balance is required'; END IF;
  IF _opening_balance_minor IS NULL THEN RAISE EXCEPTION 'Opening balance is required'; END IF;

  SELECT gl_account_id INTO _gl
  FROM public.bank_accounts WHERE id = _bank_account_id AND company_id = _company_id;
  IF _gl IS NULL THEN RAISE EXCEPTION 'Bank account not found'; END IF;

  PERFORM pg_advisory_xact_lock(hashtext('bank_recon:' || _bank_account_id::TEXT));
  PERFORM pg_advisory_xact_lock(hashtext('bank_match:' || _gl::TEXT));

  -- Opening balance must continue from the last completed session (when there is one).
  SELECT * INTO _prev
  FROM public.reconciliation_sessions
  WHERE company_id = _company_id AND bank_account_id = _bank_account_id AND status = 'completed'
  ORDER BY statement_date DESC, created_at DESC
  LIMIT 1;
  IF FOUND THEN
    IF _statement_date < _prev.statement_date THEN
      RAISE EXCEPTION 'Statement date % is earlier than the last reconciliation (%). Reopen that session first.',
        _statement_date, _prev.statement_date;
    END IF;
    IF _opening_balance_minor <> _prev.statement_balance_minor THEN
      RAISE EXCEPTION 'Opening balance must equal the previous statement closing balance (% minor units)',
        _prev.statement_balance_minor;
    END IF;
  END IF;

  SELECT COALESCE(array_agg(DISTINCT x), ARRAY[]::UUID[]) INTO _txn_ids FROM unnest(_bank_transaction_ids) AS x;
  SELECT COALESCE(array_agg(DISTINCT x), ARRAY[]::UUID[]) INTO _gl_ids FROM unnest(_journal_line_ids) AS x;
  IF cardinality(_txn_ids) = 0 AND cardinality(_gl_ids) = 0 THEN
    RAISE EXCEPTION 'Tick at least one item to reconcile';
  END IF;

  -- Statement ticks: matched, this account, on or before the statement date.
  IF cardinality(_txn_ids) > 0 THEN
    SELECT COUNT(*),
           COUNT(*) FILTER (
             WHERE company_id <> _company_id
                OR bank_account_id <> _bank_account_id
                OR status <> 'matched'
                OR txn_date > _statement_date
           )
    INTO _n, _bad
    FROM public.bank_transactions WHERE id = ANY(_txn_ids);
    IF _n <> cardinality(_txn_ids) THEN RAISE EXCEPTION 'One or more statement lines were not found'; END IF;
    IF _bad > 0 THEN
      RAISE EXCEPTION 'Only matched statement lines on this account dated on or before the statement date can be ticked';
    END IF;
  END IF;

  SELECT COALESCE(array_agg(DISTINCT l.journal_line_id), ARRAY[]::UUID[]) INTO _linked_lines
  FROM public.reconciliation_links l
  WHERE l.company_id = _company_id AND l.bank_transaction_id = ANY(_txn_ids);

  -- Whole match groups must be ticked together.
  SELECT COALESCE(array_agg(DISTINCT l.bank_transaction_id), ARRAY[]::UUID[]) INTO _group_txns
  FROM public.reconciliation_links l
  WHERE l.company_id = _company_id AND l.journal_line_id = ANY(_linked_lines);
  IF EXISTS (SELECT 1 FROM unnest(_group_txns) g WHERE NOT (g = ANY(_txn_ids))) THEN
    RAISE EXCEPTION 'A ledger line is matched to several statement lines — tick all of them together';
  END IF;

  -- Ledger-only ticks: on this bank GL, posted, dated on or before the statement date, not linked, not already cleared.
  IF cardinality(_gl_ids) > 0 THEN
    SELECT COUNT(*),
           COUNT(*) FILTER (
             WHERE jl.company_id <> _company_id
                OR jl.account_id <> _gl
                OR j.status <> 'posted'
                OR j.journal_date > _statement_date
                OR jl.id = ANY(_linked_lines)
                OR EXISTS (SELECT 1 FROM public.reconciliation_links rl WHERE rl.journal_line_id = jl.id)
                OR EXISTS (
                  SELECT 1 FROM public.reconciliation_session_lines sl
                  JOIN public.reconciliation_sessions s ON s.id = sl.session_id
                  WHERE sl.journal_line_id = jl.id AND s.status = 'completed'
                )
           )
    INTO _n, _bad
    FROM public.journal_lines jl
    JOIN public.journals j ON j.id = jl.journal_id
    WHERE jl.id = ANY(_gl_ids);
    IF _n <> cardinality(_gl_ids) THEN RAISE EXCEPTION 'One or more ledger lines were not found'; END IF;
    IF _bad > 0 THEN
      RAISE EXCEPTION 'Only unmatched, not-yet-reconciled ledger lines on this bank account dated on or before the statement date can be ticked';
    END IF;
  END IF;

  -- Linked lines must not already be in a completed session.
  IF EXISTS (
    SELECT 1 FROM public.reconciliation_session_lines sl
    JOIN public.reconciliation_sessions s ON s.id = sl.session_id
    WHERE s.status = 'completed'
      AND (sl.journal_line_id = ANY(_linked_lines) OR sl.bank_transaction_id = ANY(_txn_ids))
  ) THEN
    RAISE EXCEPTION 'A ticked item is already part of a completed reconciliation';
  END IF;

  SELECT COUNT(*) INTO _uncat
  FROM public.bank_transactions
  WHERE company_id = _company_id AND bank_account_id = _bank_account_id
    AND status = 'uncategorised' AND txn_date <= _statement_date;
  IF _uncat > 0 THEN
    RAISE EXCEPTION '% statement line(s) on or before the statement date still need to be coded, matched or excluded', _uncat;
  END IF;

  SELECT COALESCE(SUM(jl.debit_minor - jl.credit_minor), 0)::BIGINT INTO _cleared
  FROM public.journal_lines jl
  WHERE jl.id = ANY(_linked_lines) OR jl.id = ANY(_gl_ids);

  _diff := _statement_balance_minor - _opening_balance_minor - _cleared;
  IF _diff <> 0 THEN
    RAISE EXCEPTION 'Difference is % minor units: opening % + ticked % does not equal statement closing %',
      _diff, _opening_balance_minor, _cleared, _statement_balance_minor;
  END IF;

  _ledger := public.account_balance_as_of(_company_id, _gl, _statement_date);

  INSERT INTO public.reconciliation_sessions (
    company_id, bank_account_id, statement_date, statement_balance_minor, reconciled_balance_minor,
    opening_balance_minor, cleared_total_minor, status, completed_at, completed_by, notes, created_by
  ) VALUES (
    _company_id, _bank_account_id, _statement_date, _statement_balance_minor, _ledger,
    _opening_balance_minor, _cleared, 'completed', now(), _uid,
    NULLIF(trim(COALESCE(_notes, '')), ''), _uid
  ) RETURNING id INTO _session_id;

  INSERT INTO public.reconciliation_session_lines (session_id, company_id, bank_transaction_id, journal_line_id, amount_minor)
  SELECT _session_id, _company_id, l.bank_transaction_id, l.journal_line_id, jl.debit_minor - jl.credit_minor
  FROM public.reconciliation_links l
  JOIN public.journal_lines jl ON jl.id = l.journal_line_id
  WHERE l.company_id = _company_id AND l.bank_transaction_id = ANY(_txn_ids);

  INSERT INTO public.reconciliation_session_lines (session_id, company_id, bank_transaction_id, journal_line_id, amount_minor)
  SELECT _session_id, _company_id, NULL, jl.id, jl.debit_minor - jl.credit_minor
  FROM public.journal_lines jl
  WHERE jl.id = ANY(_gl_ids);

  UPDATE public.bank_transactions
  SET status = 'reconciled'
  WHERE id = ANY(_txn_ids) AND company_id = _company_id AND status = 'matched';

  PERFORM public.record_audit_event(
    _company_id,
    'bank_reconciliation.complete',
    'reconciliation_session',
    _session_id,
    jsonb_build_object(
      'bank_account_id', _bank_account_id,
      'statement_date', _statement_date,
      'statement_balance_minor', _statement_balance_minor,
      'opening_balance_minor', _opening_balance_minor,
      'cleared_total_minor', _cleared,
      'statement_lines', cardinality(_txn_ids),
      'ledger_only_lines', cardinality(_gl_ids)
    )
  );

  RETURN jsonb_build_object(
    'session_id', _session_id,
    'cleared_total_minor', _cleared,
    'ledger_balance_minor', _ledger
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- void_reconciliation_session ("reopen"): only the LATEST completed session per bank account.
--   Statement lines go back to 'matched'. Tolerates legacy sessions that have no recorded lines:
--   in that case reconciled lines up to the statement date that are not in another session are reopened.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.void_reconciliation_session(
  _company_id UUID,
  _session_id UUID,
  _reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _s RECORD;
  _txn_ids UUID[];
  _reopened INT;
  _has_lines BOOLEAN;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT public.has_company_permission(_company_id, 'banking.reconcile') THEN
    RAISE EXCEPTION 'You do not have permission to reopen a reconciliation';
  END IF;

  SELECT * INTO _s
  FROM public.reconciliation_sessions
  WHERE id = _session_id AND company_id = _company_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reconciliation session not found'; END IF;
  IF _s.status <> 'completed' THEN RAISE EXCEPTION 'Only a completed session can be reopened'; END IF;

  PERFORM pg_advisory_xact_lock(hashtext('bank_recon:' || _s.bank_account_id::TEXT));

  IF EXISTS (
    SELECT 1 FROM public.reconciliation_sessions s2
    WHERE s2.company_id = _company_id
      AND s2.bank_account_id = _s.bank_account_id
      AND s2.status = 'completed'
      AND s2.id <> _s.id
      AND (s2.statement_date, s2.created_at) > (_s.statement_date, _s.created_at)
  ) THEN
    RAISE EXCEPTION 'Only the latest completed reconciliation for this bank account can be reopened';
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.reconciliation_session_lines WHERE session_id = _s.id) INTO _has_lines;

  IF _has_lines THEN
    SELECT COALESCE(array_agg(DISTINCT bank_transaction_id), ARRAY[]::UUID[]) INTO _txn_ids
    FROM public.reconciliation_session_lines
    WHERE session_id = _s.id AND bank_transaction_id IS NOT NULL;
  ELSE
    SELECT COALESCE(array_agg(t.id), ARRAY[]::UUID[]) INTO _txn_ids
    FROM public.bank_transactions t
    WHERE t.company_id = _company_id
      AND t.bank_account_id = _s.bank_account_id
      AND t.status = 'reconciled'
      AND t.txn_date <= _s.statement_date
      AND NOT EXISTS (
        SELECT 1 FROM public.reconciliation_session_lines sl
        JOIN public.reconciliation_sessions s3 ON s3.id = sl.session_id
        WHERE sl.bank_transaction_id = t.id AND s3.status = 'completed' AND s3.id <> _s.id
      );
  END IF;

  UPDATE public.bank_transactions
  SET status = 'matched'
  WHERE id = ANY(_txn_ids) AND company_id = _company_id AND status = 'reconciled';
  GET DIAGNOSTICS _reopened = ROW_COUNT;

  DELETE FROM public.reconciliation_session_lines WHERE session_id = _s.id;

  UPDATE public.reconciliation_sessions
  SET status = 'void', voided_at = now(), voided_by = _uid,
      void_reason = NULLIF(trim(COALESCE(_reason, '')), '')
  WHERE id = _s.id;

  PERFORM public.record_audit_event(
    _company_id,
    'bank_reconciliation.void',
    'reconciliation_session',
    _s.id,
    jsonb_build_object(
      'reason', NULLIF(trim(COALESCE(_reason, '')), ''),
      'bank_account_id', _s.bank_account_id,
      'statement_date', _s.statement_date,
      'statement_lines_reopened', _reopened,
      'legacy_session_without_lines', NOT _has_lines
    )
  );

  RETURN jsonb_build_object('session_id', _s.id, 'statement_lines_reopened', _reopened);
END;
$$;

REVOKE ALL ON FUNCTION public.account_balance_as_of(UUID, UUID, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.complete_reconciliation_session(UUID, UUID, DATE, BIGINT, BIGINT, UUID[], UUID[], TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.void_reconciliation_session(UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.account_balance_as_of(UUID, UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.complete_reconciliation_session(UUID, UUID, DATE, BIGINT, BIGINT, UUID[], UUID[], TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_reconciliation_session(UUID, UUID, TEXT) TO authenticated;
