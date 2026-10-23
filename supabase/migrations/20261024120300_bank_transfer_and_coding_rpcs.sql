-- Workstream C (Banking) — atomic transfers and coding-history counter.

-- ---------------------------------------------------------------------------
-- create_bank_transfer: post the journal AND create the transfer row in one transaction.
-- A failed post (locked date, no period, …) leaves no phantom 'posted' transfer behind.
-- The ledger entry still goes through public.post_journal.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_bank_transfer(
  _company_id UUID,
  _from_bank_account_id UUID,
  _to_bank_account_id UUID,
  _transfer_date DATE,
  _amount_minor BIGINT,
  _currency_code TEXT,
  _memo TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _from RECORD;
  _to RECORD;
  _transfer_id UUID := gen_random_uuid();
  _journal_id UUID;
  _memo_clean TEXT := NULLIF(trim(COALESCE(_memo, '')), '');
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT (
    public.has_company_permission(_company_id, 'banking.categorise')
    OR public.has_company_permission(_company_id, 'banking.reconcile')
  ) THEN
    RAISE EXCEPTION 'You do not have permission to create transfers';
  END IF;
  IF _from_bank_account_id = _to_bank_account_id THEN
    RAISE EXCEPTION 'Source and destination accounts must differ';
  END IF;
  IF _amount_minor IS NULL OR _amount_minor <= 0 THEN
    RAISE EXCEPTION 'Transfer amount must be positive';
  END IF;
  IF _transfer_date IS NULL THEN RAISE EXCEPTION 'Transfer date is required'; END IF;

  SELECT * INTO _from FROM public.bank_accounts
  WHERE id = _from_bank_account_id AND company_id = _company_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Source bank account not found or archived'; END IF;
  SELECT * INTO _to FROM public.bank_accounts
  WHERE id = _to_bank_account_id AND company_id = _company_id AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Destination bank account not found or archived'; END IF;

  IF _from.currency_code <> _to.currency_code OR _from.currency_code <> upper(_currency_code) THEN
    RAISE EXCEPTION 'Currency mismatch between accounts and transfer';
  END IF;

  _journal_id := public.post_journal(jsonb_build_object(
    'company_id', _company_id,
    'journal_date', _transfer_date,
    'memo', COALESCE(_memo_clean, 'Bank transfer'),
    'currency_code', upper(_currency_code),
    'source_type', 'bank_transfer',
    'source_id', _transfer_id,
    'idempotency_key', 'bank_transfer:' || _transfer_id::TEXT || ':post',
    'lines', jsonb_build_array(
      jsonb_build_object(
        'account_id', _to.gl_account_id,
        'description', COALESCE(_memo_clean, 'Transfer in'),
        'debit_minor', _amount_minor,
        'credit_minor', 0
      ),
      jsonb_build_object(
        'account_id', _from.gl_account_id,
        'description', COALESCE(_memo_clean, 'Transfer out'),
        'debit_minor', 0,
        'credit_minor', _amount_minor
      )
    )
  ));

  INSERT INTO public.bank_transfers (
    id, company_id, from_bank_account_id, to_bank_account_id, transfer_date, amount_minor,
    currency_code, memo, posted_journal_id, status, created_by
  ) VALUES (
    _transfer_id, _company_id, _from_bank_account_id, _to_bank_account_id, _transfer_date, _amount_minor,
    upper(_currency_code), _memo_clean, _journal_id, 'posted', _uid
  );

  PERFORM public.record_audit_event(
    _company_id,
    'bank_transfer.create',
    'bank_transfer',
    _transfer_id,
    jsonb_build_object(
      'from_bank_account_id', _from_bank_account_id,
      'to_bank_account_id', _to_bank_account_id,
      'amount_minor', _amount_minor,
      'journal_id', _journal_id
    )
  );

  RETURN jsonb_build_object('id', _transfer_id, 'journal_id', _journal_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- bump_bank_coding_history: times_used = times_used + 1 on conflict (never overwrite the count).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bump_bank_coding_history(
  _company_id UUID,
  _payee_normalized TEXT,
  _description_sample TEXT,
  _offset_account_id UUID,
  _direction TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT public.has_company_permission(_company_id, 'banking.categorise') THEN
    RAISE EXCEPTION 'You do not have permission to code bank transactions';
  END IF;
  IF _direction NOT IN ('in', 'out') THEN RAISE EXCEPTION 'Invalid direction'; END IF;
  IF COALESCE(trim(_payee_normalized), '') = '' THEN RETURN; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.accounts WHERE id = _offset_account_id AND company_id = _company_id
  ) THEN
    RAISE EXCEPTION 'Account not found in organisation';
  END IF;

  INSERT INTO public.bank_coding_history (
    company_id, payee_normalized, description_sample, offset_account_id, direction, times_used, last_used_at
  ) VALUES (
    _company_id, left(_payee_normalized, 120), left(_description_sample, 500), _offset_account_id, _direction, 1, now()
  )
  ON CONFLICT (company_id, payee_normalized, offset_account_id, direction)
  DO UPDATE SET
    times_used = public.bank_coding_history.times_used + 1,
    last_used_at = now(),
    description_sample = EXCLUDED.description_sample;
END;
$$;

REVOKE ALL ON FUNCTION public.create_bank_transfer(UUID, UUID, UUID, DATE, BIGINT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bump_bank_coding_history(UUID, TEXT, TEXT, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_bank_transfer(UUID, UUID, UUID, DATE, BIGINT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bump_bank_coding_history(UUID, TEXT, TEXT, UUID, TEXT) TO authenticated;
