-- Workstream C (Banking) — atomic match / unmatch RPCs.
-- Requires 20261024120000_bank_matching_schema.sql (many-to-many reconciliation_links).
-- All ledger movement still goes through public.post_journal / public.reverse_journal.

-- ---------------------------------------------------------------------------
-- unmatch_bank_transaction: undo coding / matching of a statement line in ONE transaction.
--   * permission: banking.categorise
--   * refuses when the line (or its match group) is part of a completed reconciliation
--   * reverses the categorisation journal when it was posted from the bank (source_type = 'bank_transaction')
--   * journals created elsewhere (customer receipts, payments, transfers, manual) are NEVER reversed;
--     only the link is removed so the statement line can be matched/coded again
--   * works on a whole match group (one line <-> many journal lines, many lines <-> one journal line)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.unmatch_bank_transaction(
  _company_id UUID,
  _bank_transaction_id UUID,
  _reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _txn RECORD;
  _txn_ids UUID[];
  _line_ids UUID[] := ARRAY[]::UUID[];
  _more UUID[];
  _next UUID[];
  _j RECORD;
  _reversal UUID;
  _reversed UUID[] := ARRAY[]::UUID[];
  _links_deleted INT;
  _gl UUID;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT public.has_company_permission(_company_id, 'banking.categorise') THEN
    RAISE EXCEPTION 'You do not have permission to unmatch bank transactions';
  END IF;

  SELECT * INTO _txn
  FROM public.bank_transactions
  WHERE id = _bank_transaction_id AND company_id = _company_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bank transaction not found'; END IF;

  IF _txn.status = 'uncategorised' THEN
    RETURN jsonb_build_object('already', true, 'reversed_journal_ids', '[]'::jsonb, 'unmatched_transaction_ids', '[]'::jsonb);
  END IF;
  IF _txn.status = 'excluded' THEN
    RAISE EXCEPTION 'This line is excluded. Use Restore instead of Unmatch.';
  END IF;
  IF _txn.status = 'reconciled' THEN
    RAISE EXCEPTION 'This line is reconciled. Reopen the reconciliation that includes it before unmatching.';
  END IF;

  SELECT gl_account_id INTO _gl FROM public.bank_accounts WHERE id = _txn.bank_account_id;
  PERFORM pg_advisory_xact_lock(hashtext('bank_match:' || COALESCE(_gl::TEXT, '')));

  -- Expand to the whole match group (stable after at most a few passes: groups are 1:N or N:1).
  _txn_ids := ARRAY[_bank_transaction_id];
  LOOP
    SELECT COALESCE(array_agg(DISTINCT l.journal_line_id), ARRAY[]::UUID[]) INTO _line_ids
    FROM public.reconciliation_links l
    WHERE l.company_id = _company_id AND l.bank_transaction_id = ANY(_txn_ids);

    SELECT COALESCE(array_agg(DISTINCT l.bank_transaction_id), ARRAY[]::UUID[]) INTO _more
    FROM public.reconciliation_links l
    WHERE l.company_id = _company_id AND l.journal_line_id = ANY(_line_ids);

    SELECT array_agg(DISTINCT x) INTO _next FROM unnest(_txn_ids || _more) AS x;
    EXIT WHEN cardinality(_next) = cardinality(_txn_ids);
    _txn_ids := _next;
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM public.bank_transactions
    WHERE id = ANY(_txn_ids) AND company_id = _company_id AND status = 'reconciled'
  ) THEN
    RAISE EXCEPTION 'A line in this match group is reconciled. Reopen the reconciliation first.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.reconciliation_session_lines sl
    JOIN public.reconciliation_sessions s ON s.id = sl.session_id
    WHERE s.status = 'completed'
      AND s.company_id = _company_id
      AND (sl.bank_transaction_id = ANY(_txn_ids) OR sl.journal_line_id = ANY(_line_ids))
  ) THEN
    RAISE EXCEPTION 'This line is part of a completed reconciliation. Reopen that reconciliation first.';
  END IF;

  -- Reverse bank-originated categorisation journals (exactly once; skip when already reversed in Accounting).
  FOR _j IN
    SELECT DISTINCT j.id, j.reversed_by_journal_id
    FROM public.journals j
    JOIN public.journal_lines jl ON jl.journal_id = j.id
    WHERE jl.id = ANY(_line_ids)
      AND j.company_id = _company_id
      AND j.source_type = 'bank_transaction'
      AND j.source_id = ANY(_txn_ids)
      AND j.status = 'posted'
  LOOP
    IF _j.reversed_by_journal_id IS NULL THEN
      _reversal := public.reverse_journal(
        _j.id,
        'bank_transaction:' || _bank_transaction_id::TEXT || ':unmatch:' || _j.id::TEXT
      );
      _reversed := _reversed || _reversal;
    END IF;
  END LOOP;

  DELETE FROM public.reconciliation_links
  WHERE company_id = _company_id AND bank_transaction_id = ANY(_txn_ids);
  GET DIAGNOSTICS _links_deleted = ROW_COUNT;

  UPDATE public.bank_transactions
  SET status = 'uncategorised'
  WHERE id = ANY(_txn_ids) AND company_id = _company_id AND status = 'matched';

  PERFORM public.record_audit_event(
    _company_id,
    'bank_transaction.unmatch',
    'bank_transaction',
    _bank_transaction_id,
    jsonb_build_object(
      'reason', NULLIF(trim(COALESCE(_reason, '')), ''),
      'unmatched_transaction_ids', to_jsonb(_txn_ids),
      'journal_line_ids', to_jsonb(_line_ids),
      'reversal_journal_ids', to_jsonb(_reversed),
      'links_deleted', _links_deleted
    )
  );

  RETURN jsonb_build_object(
    'already', false,
    'reversed_journal_ids', to_jsonb(_reversed),
    'unmatched_transaction_ids', to_jsonb(_txn_ids),
    'links_deleted', _links_deleted
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- match_bank_transaction: link ONE statement line to ONE OR MORE existing bank-GL journal lines.
--   Validates: same company, lines on this bank account's GL, posted, not reversed, not already
--   matched anywhere, and the signed total equals the statement amount exactly.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.match_bank_transaction(
  _company_id UUID,
  _bank_transaction_id UUID,
  _journal_line_ids UUID[]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _txn RECORD;
  _gl UUID;
  _ids UUID[];
  _n INT;
  _sum BIGINT;
  _bad INT;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT (
    public.has_company_permission(_company_id, 'banking.reconcile')
    OR public.has_company_permission(_company_id, 'banking.categorise')
  ) THEN
    RAISE EXCEPTION 'You do not have permission to match bank transactions';
  END IF;

  SELECT * INTO _txn
  FROM public.bank_transactions
  WHERE id = _bank_transaction_id AND company_id = _company_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bank transaction not found'; END IF;
  IF _txn.status <> 'uncategorised' THEN
    RAISE EXCEPTION 'This statement line is already % — unmatch it first', _txn.status;
  END IF;

  SELECT gl_account_id INTO _gl
  FROM public.bank_accounts
  WHERE id = _txn.bank_account_id AND company_id = _company_id;
  IF _gl IS NULL THEN RAISE EXCEPTION 'Bank account not found'; END IF;

  PERFORM pg_advisory_xact_lock(hashtext('bank_match:' || _gl::TEXT));

  SELECT COALESCE(array_agg(DISTINCT x), ARRAY[]::UUID[]) INTO _ids FROM unnest(_journal_line_ids) AS x;
  IF cardinality(_ids) = 0 THEN RAISE EXCEPTION 'Select at least one ledger line to match'; END IF;
  IF cardinality(_ids) > 50 THEN RAISE EXCEPTION 'A statement line can be matched to at most 50 ledger lines'; END IF;

  SELECT
    COUNT(*),
    COALESCE(SUM(jl.debit_minor - jl.credit_minor), 0),
    COUNT(*) FILTER (
      WHERE jl.company_id <> _company_id
         OR jl.account_id <> _gl
         OR j.status <> 'posted'
         OR j.reversed_by_journal_id IS NOT NULL
         OR j.reverses_journal_id IS NOT NULL
    )
  INTO _n, _sum, _bad
  FROM public.journal_lines jl
  JOIN public.journals j ON j.id = jl.journal_id
  WHERE jl.id = ANY(_ids);

  IF _n <> cardinality(_ids) THEN RAISE EXCEPTION 'One or more ledger lines were not found'; END IF;
  IF _bad > 0 THEN
    RAISE EXCEPTION 'Every ledger line must be posted, not reversed, and on this bank account''s ledger account';
  END IF;
  IF EXISTS (SELECT 1 FROM public.reconciliation_links WHERE journal_line_id = ANY(_ids)) THEN
    RAISE EXCEPTION 'One or more ledger lines are already matched to a statement line';
  END IF;
  IF _sum <> _txn.amount_minor THEN
    RAISE EXCEPTION 'Ledger lines total % but the statement line is % (difference % minor units). They must be equal.',
      _sum, _txn.amount_minor, _txn.amount_minor - _sum;
  END IF;

  INSERT INTO public.reconciliation_links (company_id, bank_transaction_id, journal_line_id, created_by)
  SELECT _company_id, _bank_transaction_id, x, _uid FROM unnest(_ids) AS x;

  UPDATE public.bank_transactions SET status = 'matched' WHERE id = _bank_transaction_id;

  PERFORM public.record_audit_event(
    _company_id,
    'bank_transaction.match',
    'bank_transaction',
    _bank_transaction_id,
    jsonb_build_object('journal_line_ids', to_jsonb(_ids), 'amount_minor', _txn.amount_minor)
  );

  RETURN jsonb_build_object('linked', cardinality(_ids), 'bank_transaction_ids', jsonb_build_array(_bank_transaction_id));
END;
$$;

-- ---------------------------------------------------------------------------
-- match_bank_transactions_to_journal_line: MANY statement lines to ONE ledger line
-- (e.g. one bank deposit that banks several receipts).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.match_bank_transactions_to_journal_line(
  _company_id UUID,
  _bank_transaction_ids UUID[],
  _journal_line_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _ids UUID[];
  _n INT;
  _accounts INT;
  _bad INT;
  _sum BIGINT;
  _gl UUID;
  _account UUID;
  _line RECORD;
  _line_amount BIGINT;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT (
    public.has_company_permission(_company_id, 'banking.reconcile')
    OR public.has_company_permission(_company_id, 'banking.categorise')
  ) THEN
    RAISE EXCEPTION 'You do not have permission to match bank transactions';
  END IF;

  SELECT COALESCE(array_agg(DISTINCT x), ARRAY[]::UUID[]) INTO _ids FROM unnest(_bank_transaction_ids) AS x;
  IF cardinality(_ids) = 0 THEN RAISE EXCEPTION 'Select at least one statement line'; END IF;
  IF cardinality(_ids) > 50 THEN RAISE EXCEPTION 'At most 50 statement lines can be matched to one ledger line'; END IF;

  SELECT
    COUNT(*),
    COUNT(DISTINCT bank_account_id),
    COALESCE(SUM(amount_minor), 0),
    COUNT(*) FILTER (WHERE status <> 'uncategorised' OR company_id <> _company_id),
    MIN(bank_account_id::TEXT)::UUID
  INTO _n, _accounts, _sum, _bad, _account
  FROM public.bank_transactions
  WHERE id = ANY(_ids);

  IF _n <> cardinality(_ids) THEN RAISE EXCEPTION 'One or more statement lines were not found'; END IF;
  IF _accounts <> 1 THEN RAISE EXCEPTION 'All statement lines must belong to the same bank account'; END IF;
  IF _bad > 0 THEN RAISE EXCEPTION 'Every statement line must still be uncategorised in this organisation'; END IF;

  SELECT gl_account_id INTO _gl
  FROM public.bank_accounts WHERE id = _account AND company_id = _company_id;
  IF _gl IS NULL THEN RAISE EXCEPTION 'Bank account not found'; END IF;

  PERFORM pg_advisory_xact_lock(hashtext('bank_match:' || _gl::TEXT));

  -- Lock the statement lines so two sessions cannot match them concurrently.
  PERFORM 1 FROM public.bank_transactions WHERE id = ANY(_ids) FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM public.bank_transactions WHERE id = ANY(_ids) AND status <> 'uncategorised'
  ) THEN
    RAISE EXCEPTION 'A statement line was matched by someone else — refresh and retry';
  END IF;

  SELECT jl.*, j.status AS j_status, j.reversed_by_journal_id AS j_reversed, j.reverses_journal_id AS j_reverses
  INTO _line
  FROM public.journal_lines jl
  JOIN public.journals j ON j.id = jl.journal_id
  WHERE jl.id = _journal_line_id AND jl.company_id = _company_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Ledger line not found'; END IF;
  IF _line.account_id <> _gl OR _line.j_status <> 'posted'
     OR _line.j_reversed IS NOT NULL OR _line.j_reverses IS NOT NULL THEN
    RAISE EXCEPTION 'The ledger line must be posted, not reversed, and on this bank account''s ledger account';
  END IF;
  IF EXISTS (SELECT 1 FROM public.reconciliation_links WHERE journal_line_id = _journal_line_id) THEN
    RAISE EXCEPTION 'That ledger line is already matched';
  END IF;

  _line_amount := _line.debit_minor - _line.credit_minor;
  IF _sum <> _line_amount THEN
    RAISE EXCEPTION 'Statement lines total % but the ledger line is % (difference % minor units). They must be equal.',
      _sum, _line_amount, _line_amount - _sum;
  END IF;

  INSERT INTO public.reconciliation_links (company_id, bank_transaction_id, journal_line_id, created_by)
  SELECT _company_id, x, _journal_line_id, _uid FROM unnest(_ids) AS x;

  UPDATE public.bank_transactions SET status = 'matched' WHERE id = ANY(_ids);

  PERFORM public.record_audit_event(
    _company_id,
    'bank_transaction.match_many',
    'journal_line',
    _journal_line_id,
    jsonb_build_object('bank_transaction_ids', to_jsonb(_ids), 'amount_minor', _line_amount)
  );

  RETURN jsonb_build_object('linked', cardinality(_ids), 'bank_transaction_ids', to_jsonb(_ids));
END;
$$;

REVOKE ALL ON FUNCTION public.unmatch_bank_transaction(UUID, UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.match_bank_transaction(UUID, UUID, UUID[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.match_bank_transactions_to_journal_line(UUID, UUID[], UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unmatch_bank_transaction(UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.match_bank_transaction(UUID, UUID, UUID[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.match_bank_transactions_to_journal_line(UUID, UUID[], UUID) TO authenticated;
