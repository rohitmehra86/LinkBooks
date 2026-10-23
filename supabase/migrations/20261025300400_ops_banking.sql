-- Wave 2 H (ops) — banking leftovers.
--
--   BK-05  bank_integrity_check(): honest, read-only findings about bank data that does not add up.
--   BK-10  create_bank_transfer_fx(): transfers between accounts in different currencies (two amounts);
--          the difference to the ledger value is posted to realised FX gain / loss. Same-currency foreign
--          transfers are now posted in their own currency at the looked-up rate.
--   BK-16  bank account number / sort code / IBAN / BIC with validation, masked display, opening statement balance.
--   (BK-04 chart-of-accounts balances: already SQL-aggregated by ledger_balances() — nothing to add.)
--
-- Single posting engine: transfers go through post_journal. Additive and idempotent.
-- Requires 20261025300100 (ops_fx_account, ops_minor_to_base).

-- ---------------------------------------------------------------------------
-- 1. BK-16: identifiers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_valid_iban(_iban TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  _s TEXT := upper(regexp_replace(COALESCE(_iban, ''), '\s', '', 'g'));
  _r TEXT;
  _digits TEXT := '';
  _ch TEXT;
  _i INT;
BEGIN
  IF _s !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$' THEN RETURN FALSE; END IF;
  _r := substr(_s, 5) || substr(_s, 1, 4);
  FOR _i IN 1..length(_r) LOOP
    _ch := substr(_r, _i, 1);
    IF _ch ~ '[0-9]' THEN
      _digits := _digits || _ch;
    ELSE
      _digits := _digits || (ascii(_ch) - 55)::TEXT;   -- A=10 ... Z=35
    END IF;
  END LOOP;
  RETURN mod(_digits::NUMERIC, 97) = 1;
END;
$$;

CREATE TABLE IF NOT EXISTS public.bank_account_details (
  bank_account_id UUID PRIMARY KEY REFERENCES public.bank_accounts(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  account_number TEXT,
  sort_code TEXT,
  iban TEXT,
  bic TEXT,
  opening_statement_balance_minor BIGINT,
  opening_statement_balance_date DATE,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bank_account_details_sort_code CHECK (sort_code IS NULL OR sort_code ~ '^[0-9]{2}-[0-9]{2}-[0-9]{2}$'),
  CONSTRAINT bank_account_details_account_number CHECK (account_number IS NULL OR account_number ~ '^[0-9A-Z]{4,34}$'),
  CONSTRAINT bank_account_details_bic CHECK (bic IS NULL OR bic ~ '^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$'),
  CONSTRAINT bank_account_details_iban CHECK (iban IS NULL OR public.is_valid_iban(iban))
);

ALTER TABLE public.bank_account_details ENABLE ROW LEVEL SECURITY;

-- Raw identifiers are readable only by people who maintain accounts. Everyone else gets masked values
-- through list_bank_account_details().
DROP POLICY IF EXISTS "Account managers read bank details" ON public.bank_account_details;
CREATE POLICY "Account managers read bank details"
  ON public.bank_account_details FOR SELECT TO authenticated
  USING (public.has_company_permission(company_id, 'accounts.manage')
         OR public.has_company_permission(company_id, 'banking.feeds.manage'));
-- No INSERT/UPDATE/DELETE policy: written only by save_bank_account_details().

CREATE OR REPLACE FUNCTION public.ops_mask_identifier(_value TEXT, _keep INT DEFAULT 4)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN _value IS NULL OR _value = '' THEN NULL
    WHEN length(_value) <= _keep THEN repeat('•', length(_value))
    ELSE repeat('•', length(_value) - _keep) || right(_value, _keep)
  END;
$$;

-- save_bank_account_details(payload): company_id, bank_account_id, [account_number], [sort_code], [iban], [bic],
--   [opening_statement_balance_minor], [opening_statement_balance_date], [clear: ['iban', ...]]
--   Fields that are absent or empty keep their stored value unless named in "clear".
CREATE OR REPLACE FUNCTION public.save_bank_account_details(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _company UUID := NULLIF(payload->>'company_id', '')::UUID;
  _ba UUID := NULLIF(payload->>'bank_account_id', '')::UUID;
  _cur public.bank_account_details%ROWTYPE;
  _num TEXT;
  _sort TEXT;
  _iban TEXT;
  _bic TEXT;
  _bal BIGINT;
  _bal_date DATE;
  _clear JSONB := COALESCE(payload->'clear', '[]'::JSONB);
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF _company IS NULL OR _ba IS NULL THEN RAISE EXCEPTION 'company_id and bank_account_id are required'; END IF;
  IF NOT public.is_company_member(_company) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT (public.has_company_permission(_company, 'accounts.manage')
          OR public.has_company_permission(_company, 'banking.feeds.manage')) THEN
    RAISE EXCEPTION 'You do not have permission to edit bank account details';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.bank_accounts WHERE id = _ba AND company_id = _company) THEN
    RAISE EXCEPTION 'Bank account not found';
  END IF;

  SELECT * INTO _cur FROM public.bank_account_details WHERE bank_account_id = _ba;

  _num := upper(regexp_replace(COALESCE(NULLIF(payload->>'account_number', ''), ''), '[\s-]', '', 'g'));
  _iban := upper(regexp_replace(COALESCE(NULLIF(payload->>'iban', ''), ''), '\s', '', 'g'));
  _bic := upper(regexp_replace(COALESCE(NULLIF(payload->>'bic', ''), ''), '\s', '', 'g'));
  _sort := COALESCE(NULLIF(payload->>'sort_code', ''), '');
  IF _sort <> '' THEN
    _sort := regexp_replace(_sort, '[\s-]', '', 'g');
    IF _sort !~ '^[0-9]{6}$' THEN RAISE EXCEPTION 'Sort code must be 6 digits (e.g. 12-34-56)'; END IF;
    _sort := substr(_sort, 1, 2) || '-' || substr(_sort, 3, 2) || '-' || substr(_sort, 5, 2);
  END IF;
  IF _num <> '' AND _num !~ '^[0-9A-Z]{4,34}$' THEN
    RAISE EXCEPTION 'Account number must be 4 to 34 letters or digits';
  END IF;
  IF _iban <> '' AND NOT public.is_valid_iban(_iban) THEN
    RAISE EXCEPTION 'That IBAN is not valid (check the digits)';
  END IF;
  IF _bic <> '' AND _bic !~ '^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$' THEN
    RAISE EXCEPTION 'BIC must be 8 or 11 characters';
  END IF;

  _bal := CASE WHEN payload ? 'opening_statement_balance_minor' AND NULLIF(payload->>'opening_statement_balance_minor', '') IS NOT NULL
               THEN (payload->>'opening_statement_balance_minor')::BIGINT ELSE _cur.opening_statement_balance_minor END;
  _bal_date := CASE WHEN NULLIF(payload->>'opening_statement_balance_date', '') IS NOT NULL
                    THEN (payload->>'opening_statement_balance_date')::DATE ELSE _cur.opening_statement_balance_date END;
  IF _bal IS NOT NULL AND _bal_date IS NULL THEN
    RAISE EXCEPTION 'Enter the date of the opening statement balance';
  END IF;

  INSERT INTO public.bank_account_details AS d (
    bank_account_id, company_id, account_number, sort_code, iban, bic,
    opening_statement_balance_minor, opening_statement_balance_date, updated_by, updated_at
  ) VALUES (
    _ba, _company,
    CASE WHEN _clear ? 'account_number' THEN NULL ELSE COALESCE(NULLIF(_num, ''), _cur.account_number) END,
    CASE WHEN _clear ? 'sort_code' THEN NULL ELSE COALESCE(NULLIF(_sort, ''), _cur.sort_code) END,
    CASE WHEN _clear ? 'iban' THEN NULL ELSE COALESCE(NULLIF(_iban, ''), _cur.iban) END,
    CASE WHEN _clear ? 'bic' THEN NULL ELSE COALESCE(NULLIF(_bic, ''), _cur.bic) END,
    _bal, _bal_date, _uid, now()
  )
  ON CONFLICT (bank_account_id) DO UPDATE SET
    account_number = EXCLUDED.account_number,
    sort_code = EXCLUDED.sort_code,
    iban = EXCLUDED.iban,
    bic = EXCLUDED.bic,
    opening_statement_balance_minor = EXCLUDED.opening_statement_balance_minor,
    opening_statement_balance_date = EXCLUDED.opening_statement_balance_date,
    updated_by = EXCLUDED.updated_by,
    updated_at = now();

  PERFORM public.record_audit_event(_company, 'bank_account.details_saved', 'bank_account', _ba,
    jsonb_build_object('fields', (SELECT jsonb_agg(k) FROM jsonb_object_keys(payload) k
                                  WHERE k IN ('account_number', 'sort_code', 'iban', 'bic', 'opening_statement_balance_minor'))));
  RETURN jsonb_build_object('bank_account_id', _ba);
END;
$$;

-- list_bank_account_details(company): masked identifiers for everyone who can view banking.
CREATE OR REPLACE FUNCTION public.list_bank_account_details(_company_id UUID)
RETURNS TABLE (
  bank_account_id UUID, account_number_masked TEXT, sort_code_masked TEXT, iban_masked TEXT, bic TEXT,
  has_account_number BOOLEAN, has_sort_code BOOLEAN, has_iban BOOLEAN,
  opening_statement_balance_minor BIGINT, opening_statement_balance_date DATE
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  RETURN QUERY
  SELECT d.bank_account_id,
         public.ops_mask_identifier(d.account_number, 4),
         CASE WHEN d.sort_code IS NULL THEN NULL ELSE '••-••-' || right(d.sort_code, 2) END,
         public.ops_mask_identifier(d.iban, 4),
         d.bic,
         d.account_number IS NOT NULL, d.sort_code IS NOT NULL, d.iban IS NOT NULL,
         d.opening_statement_balance_minor, d.opening_statement_balance_date
  FROM public.bank_account_details d
  WHERE d.company_id = _company_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. BK-10: FX / foreign-currency bank transfers
-- ---------------------------------------------------------------------------
ALTER TABLE public.bank_transfers
  ADD COLUMN IF NOT EXISTS to_amount_minor BIGINT,
  ADD COLUMN IF NOT EXISTS to_currency_code CHAR(3),
  ADD COLUMN IF NOT EXISTS fx_difference_minor BIGINT NOT NULL DEFAULT 0;

-- create_bank_transfer_fx(payload): company_id, from_bank_account_id, to_bank_account_id, transfer_date,
--   from_amount_minor, [to_amount_minor] (required when the currencies differ), [from_rate_to_base], [to_rate_to_base], [memo]
--   Rates default to lookup_fx_rate_to_base() on the transfer date (an error says so when none is stored).
--   returns {id, journal_id, fx_difference_minor}
CREATE OR REPLACE FUNCTION public.create_bank_transfer_fx(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _company UUID := NULLIF(payload->>'company_id', '')::UUID;
  _from RECORD;
  _to RECORD;
  _date DATE := NULLIF(payload->>'transfer_date', '')::DATE;
  _from_amt BIGINT := NULLIF(payload->>'from_amount_minor', '')::BIGINT;
  _to_amt BIGINT := NULLIF(payload->>'to_amount_minor', '')::BIGINT;
  _memo TEXT := NULLIF(left(trim(COALESCE(payload->>'memo', '')), 500), '');
  _base TEXT;
  _fr NUMERIC;
  _tr NUMERIC;
  _from_base BIGINT;
  _to_base BIGINT;
  _diff BIGINT := 0;
  _id UUID := gen_random_uuid();
  _journal UUID;
  _lines JSONB;
  _jccy TEXT;
  _jfx NUMERIC := 1;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF _company IS NULL THEN RAISE EXCEPTION 'company_id is required'; END IF;
  IF NOT public.is_company_member(_company) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT (public.has_company_permission(_company, 'banking.categorise')
          OR public.has_company_permission(_company, 'banking.reconcile')) THEN
    RAISE EXCEPTION 'You do not have permission to create transfers';
  END IF;
  IF _date IS NULL THEN RAISE EXCEPTION 'Transfer date is required'; END IF;
  IF _from_amt IS NULL OR _from_amt <= 0 THEN RAISE EXCEPTION 'Transfer amount must be positive'; END IF;

  SELECT * INTO _from FROM public.bank_accounts
  WHERE id = NULLIF(payload->>'from_bank_account_id', '')::UUID AND company_id = _company AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Source bank account not found or archived'; END IF;
  SELECT * INTO _to FROM public.bank_accounts
  WHERE id = NULLIF(payload->>'to_bank_account_id', '')::UUID AND company_id = _company AND is_active;
  IF NOT FOUND THEN RAISE EXCEPTION 'Destination bank account not found or archived'; END IF;
  IF _from.id = _to.id THEN RAISE EXCEPTION 'Source and destination accounts must differ'; END IF;
  SELECT base_currency INTO _base FROM public.companies WHERE id = _company;

  IF _from.currency_code = _to.currency_code THEN
    IF _to_amt IS NOT NULL AND _to_amt <> _from_amt THEN
      RAISE EXCEPTION 'Both accounts are in %: the amount received must equal the amount sent', _from.currency_code;
    END IF;
    _to_amt := _from_amt;
    _jccy := _from.currency_code::TEXT;
    IF upper(_jccy) <> upper(_base) THEN
      _jfx := COALESCE(NULLIF(payload->>'from_rate_to_base', '')::NUMERIC,
                       public.lookup_fx_rate_to_base(_company, _jccy::CHAR(3), _date));
    END IF;
    _lines := jsonb_build_array(
      jsonb_build_object('account_id', _to.gl_account_id, 'description', COALESCE(_memo, 'Transfer in'),
                         'debit_minor', _from_amt, 'credit_minor', 0),
      jsonb_build_object('account_id', _from.gl_account_id, 'description', COALESCE(_memo, 'Transfer out'),
                         'debit_minor', 0, 'credit_minor', _from_amt));
  ELSE
    IF _to_amt IS NULL OR _to_amt <= 0 THEN
      RAISE EXCEPTION 'Enter the amount received in %', _to.currency_code;
    END IF;
    _fr := COALESCE(NULLIF(payload->>'from_rate_to_base', '')::NUMERIC,
                    public.lookup_fx_rate_to_base(_company, _from.currency_code::CHAR(3), _date));
    _tr := COALESCE(NULLIF(payload->>'to_rate_to_base', '')::NUMERIC,
                    public.lookup_fx_rate_to_base(_company, _to.currency_code::CHAR(3), _date));
    IF _fr <= 0 OR _tr <= 0 THEN RAISE EXCEPTION 'Exchange rates must be positive'; END IF;
    _from_base := public.ops_minor_to_base(_company, _from_amt, _from.currency_code::TEXT, _fr);
    _to_base := public.ops_minor_to_base(_company, _to_amt, _to.currency_code::TEXT, _tr);
    _diff := _to_base - _from_base;     -- > 0: the money received is worth more than what left (gain)
    _jccy := upper(_base);
    _lines := jsonb_build_array(
      jsonb_build_object('account_id', _to.gl_account_id, 'description', COALESCE(_memo, 'Transfer in'),
                         'debit_minor', _to_base, 'credit_minor', 0),
      jsonb_build_object('account_id', _from.gl_account_id, 'description', COALESCE(_memo, 'Transfer out'),
                         'debit_minor', 0, 'credit_minor', _from_base));
    IF _diff > 0 THEN
      _lines := _lines || jsonb_build_array(jsonb_build_object(
        'account_id', public.ops_fx_account(_company, 'gain'), 'description', 'Realised FX gain',
        'debit_minor', 0, 'credit_minor', _diff));
    ELSIF _diff < 0 THEN
      _lines := _lines || jsonb_build_array(jsonb_build_object(
        'account_id', public.ops_fx_account(_company, 'loss'), 'description', 'Realised FX loss',
        'debit_minor', -_diff, 'credit_minor', 0));
    END IF;
  END IF;

  _journal := public.post_journal(jsonb_build_object(
    'company_id', _company,
    'journal_date', _date,
    'memo', COALESCE(_memo, 'Bank transfer')
            || CASE WHEN _from.currency_code <> _to.currency_code
                    THEN ' (' || _from.currency_code || ' ' || _from_amt::TEXT || ' → ' || _to.currency_code || ' ' || _to_amt::TEXT || ' minor units)'
                    ELSE '' END,
    'currency_code', _jccy,
    'fx_rate_to_base', _jfx,
    'source_type', 'bank_transfer',
    'source_id', _id,
    'idempotency_key', 'bank_transfer:' || _id::TEXT || ':post',
    'lines', _lines
  ));

  INSERT INTO public.bank_transfers (
    id, company_id, from_bank_account_id, to_bank_account_id, transfer_date, amount_minor, currency_code,
    to_amount_minor, to_currency_code, fx_difference_minor, memo, posted_journal_id, status, created_by
  ) VALUES (
    _id, _company, _from.id, _to.id, _date, _from_amt, _from.currency_code,
    _to_amt, _to.currency_code, _diff, _memo, _journal, 'posted', _uid
  );

  PERFORM public.record_audit_event(_company, 'bank_transfer.create', 'bank_transfer', _id,
    jsonb_build_object('from_bank_account_id', _from.id, 'to_bank_account_id', _to.id,
                       'from_amount_minor', _from_amt, 'to_amount_minor', _to_amt,
                       'fx_difference_minor', _diff, 'journal_id', _journal));
  RETURN jsonb_build_object('id', _id, 'journal_id', _journal, 'fx_difference_minor', _diff);
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. BK-05: bank data integrity check (read-only)
--    One row per kind of problem found. Empty result = nothing wrong was detected.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bank_integrity_check(_company_id UUID)
RETURNS TABLE (code TEXT, severity TEXT, message TEXT, finding_count BIGINT, sample_ids UUID[])
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;

  RETURN QUERY
  WITH linked AS (
    SELECT DISTINCT bank_transaction_id AS id FROM public.reconciliation_links WHERE company_id = _company_id
  ), in_session AS (
    SELECT DISTINCT bank_transaction_id AS id FROM public.reconciliation_session_lines
    WHERE company_id = _company_id AND bank_transaction_id IS NOT NULL
  ), problems AS (
    SELECT 'matched_without_link'::TEXT AS code, 'error'::TEXT AS severity,
           'Lines marked Matched that have no journal or ledger link'::TEXT AS message, t.id
    FROM public.bank_transactions t
    WHERE t.company_id = _company_id AND t.status = 'matched'
      AND NOT EXISTS (SELECT 1 FROM linked l WHERE l.id = t.id)
    UNION ALL
    SELECT 'reconciled_without_link', 'error',
           'Lines marked Reconciled that have no journal link and are not part of a saved reconciliation', t.id
    FROM public.bank_transactions t
    WHERE t.company_id = _company_id AND t.status = 'reconciled'
      AND NOT EXISTS (SELECT 1 FROM linked l WHERE l.id = t.id)
      AND NOT EXISTS (SELECT 1 FROM in_session s WHERE s.id = t.id)
    UNION ALL
    SELECT 'uncategorised_with_link', 'warning',
           'Lines still Uncategorised although a journal link exists', t.id
    FROM public.bank_transactions t
    WHERE t.company_id = _company_id AND t.status = 'uncategorised'
      AND EXISTS (SELECT 1 FROM linked l WHERE l.id = t.id)
    UNION ALL
    SELECT 'linked_to_void_journal', 'error',
           'Matched or reconciled lines whose journal has been voided or reversed', t.id
    FROM public.bank_transactions t
    WHERE t.company_id = _company_id AND t.status IN ('matched', 'reconciled')
      AND EXISTS (
        SELECT 1 FROM public.reconciliation_links rl
        JOIN public.journal_lines jl ON jl.id = rl.journal_line_id
        JOIN public.journals j ON j.id = jl.journal_id
        WHERE rl.bank_transaction_id = t.id AND j.status <> 'posted')
    UNION ALL
    SELECT 'amount_differs_from_ledger', 'warning',
           'Matched lines whose amount differs from the linked ledger entries (same currency only)', t.id
    FROM public.bank_transactions t
    JOIN public.bank_accounts ba ON ba.id = t.bank_account_id
    WHERE t.company_id = _company_id AND t.status IN ('matched', 'reconciled')
      AND EXISTS (SELECT 1 FROM linked l WHERE l.id = t.id)
      AND (SELECT COALESCE(SUM(jl.debit_minor - jl.credit_minor), 0)
           FROM public.reconciliation_links rl
           JOIN public.journal_lines jl ON jl.id = rl.journal_line_id
           JOIN public.journals j ON j.id = jl.journal_id
           WHERE rl.bank_transaction_id = t.id AND j.status = 'posted'
             AND jl.account_id = ba.gl_account_id AND j.currency_code = ba.currency_code)
          <> t.amount_minor
      AND (SELECT count(*) FROM public.reconciliation_links rl
           JOIN public.journal_lines jl ON jl.id = rl.journal_line_id
           JOIN public.journals j ON j.id = jl.journal_id
           WHERE rl.bank_transaction_id = t.id AND jl.account_id = ba.gl_account_id
             AND j.currency_code = ba.currency_code) > 0
    UNION ALL
    SELECT 'bank_ledger_account_inactive', 'warning',
           'Active bank accounts whose ledger account is inactive or archived', ba.id
    FROM public.bank_accounts ba
    JOIN public.accounts a ON a.id = ba.gl_account_id
    WHERE ba.company_id = _company_id AND ba.is_active AND (NOT a.is_active OR a.archived_at IS NOT NULL)
  )
  SELECT p.code, p.severity, p.message, count(*)::BIGINT, (array_agg(p.id))[1:5]
  FROM problems p
  GROUP BY p.code, p.severity, p.message
  ORDER BY CASE p.severity WHEN 'error' THEN 0 ELSE 1 END, p.code;
END;
$$;

REVOKE ALL ON FUNCTION public.is_valid_iban(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_valid_iban(TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.ops_mask_identifier(TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ops_mask_identifier(TEXT, INT) TO authenticated;
REVOKE ALL ON FUNCTION public.save_bank_account_details(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_bank_account_details(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_bank_transfer_fx(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bank_integrity_check(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_bank_account_details(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_bank_account_details(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_bank_transfer_fx(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bank_integrity_check(UUID) TO authenticated;
