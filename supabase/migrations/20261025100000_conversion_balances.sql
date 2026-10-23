-- AC-02: conversion date + opening balances (trial balance, opening AR / AP documents).
-- Requires 20261025090000_ac_foundation.sql. Additive and idempotent. Posted journals are never edited.
--
-- Model (same as Xero / QBO / Sage conversion balances):
--   * The conversion date is the first day the books are kept in LinkBooks. Balances are entered "as at the
--     day before", so the opening journal is dated conversion_date - 1.
--   * ONE batch per company (conversion_balance_batches). It posts through public.post_journal as
--     source_type 'opening_balance':
--       - one base-currency journal: trial balance lines + base-currency AR / AP + the offsets of any
--         foreign-currency AR / AP,
--       - plus, per foreign currency, one journal for AR and one for AP (a journal has a single currency
--         and rate). Their offset sits on Opening Balance Equity and nets to zero with the base journal.
--   * AR and AP control accounts are NOT entered in the trial balance: they come from opening invoices and
--     bills per contact, which are created as real authorised documents (is_opening_balance = true).
--   * The journal must balance. A difference is rejected unless the caller explicitly asks for it to be
--     posted to Opening Balance Equity (the amount is stored on the batch and audited).
--   * Opening documents cannot be voided one by one; "Reverse conversion balances" reverses the whole batch
--     and is refused while any opening document has a payment or credit applied.
--   * Posting before the conversion date is blocked (see assert_journal_date_unlocked) unless the user holds
--     accounting.conversion.override.

-- ---------------------------------------------------------------------------
-- Columns on documents
-- ---------------------------------------------------------------------------
ALTER TABLE public.sales_invoices
  ADD COLUMN IF NOT EXISTS is_opening_balance BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS conversion_batch_id UUID;
ALTER TABLE public.purchase_bills
  ADD COLUMN IF NOT EXISTS is_opening_balance BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS conversion_batch_id UUID;

-- ---------------------------------------------------------------------------
-- Batches
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.conversion_balance_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  conversion_date DATE NOT NULL,
  opening_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'reversed')),
  journal_ids UUID[] NOT NULL DEFAULT '{}',
  total_debit_minor BIGINT NOT NULL DEFAULT 0,
  total_credit_minor BIGINT NOT NULL DEFAULT 0,
  plug_to_opening_equity_minor BIGINT NOT NULL DEFAULT 0,
  tb_line_count INTEGER NOT NULL DEFAULT 0,
  invoice_count INTEGER NOT NULL DEFAULT 0,
  bill_count INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reversed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reversed_at TIMESTAMPTZ,
  reverse_reason TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS conversion_balance_batches_one_active_uidx
  ON public.conversion_balance_batches (company_id) WHERE status = 'posted';
CREATE INDEX IF NOT EXISTS conversion_balance_batches_company_idx
  ON public.conversion_balance_batches (company_id, created_at DESC);

ALTER TABLE public.conversion_balance_batches ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members view conversion batches" ON public.conversion_balance_batches;
CREATE POLICY "Members view conversion batches" ON public.conversion_balance_batches
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));
REVOKE ALL ON public.conversion_balance_batches FROM PUBLIC, anon;
GRANT SELECT ON public.conversion_balance_batches TO authenticated;

-- ---------------------------------------------------------------------------
-- Guards: opening documents / the opening journal are only undone as a batch
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_opening_balance_documents()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.is_opening_balance
     AND NEW.status::TEXT = 'void' AND OLD.status::TEXT <> 'void'
     AND current_setting('linkbooks.opening_reverse', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Opening balance documents cannot be voided one by one. Use Accounting > Conversion balances > Reverse conversion balances.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sales_invoices_guard_opening ON public.sales_invoices;
CREATE TRIGGER sales_invoices_guard_opening
  BEFORE UPDATE ON public.sales_invoices
  FOR EACH ROW EXECUTE FUNCTION public.guard_opening_balance_documents();
DROP TRIGGER IF EXISTS purchase_bills_guard_opening ON public.purchase_bills;
CREATE TRIGGER purchase_bills_guard_opening
  BEFORE UPDATE ON public.purchase_bills
  FOR EACH ROW EXECUTE FUNCTION public.guard_opening_balance_documents();

CREATE OR REPLACE FUNCTION public.guard_opening_balance_journal()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.reversed_by_journal_id IS NOT NULL AND OLD.reversed_by_journal_id IS NULL
     AND OLD.source_type::TEXT = 'opening_balance'
     AND current_setting('linkbooks.opening_reverse', true) IS DISTINCT FROM 'on'
     AND EXISTS (
       SELECT 1 FROM public.conversion_balance_batches b
       WHERE b.company_id = OLD.company_id AND b.status = 'posted' AND OLD.id = ANY (b.journal_ids)
     ) THEN
    RAISE EXCEPTION 'This journal belongs to the posted conversion balances. Use Accounting > Conversion balances > Reverse conversion balances.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS journals_guard_opening ON public.journals;
CREATE TRIGGER journals_guard_opening
  BEFORE UPDATE ON public.journals
  FOR EACH ROW EXECUTE FUNCTION public.guard_opening_balance_journal();

-- ---------------------------------------------------------------------------
-- post_conversion_balances(payload jsonb)
--   payload: company_id, conversion_date, [post_difference_to_opening_equity], [note],
--            tb_lines:  [{account_id, debit_minor, credit_minor}]            (base currency)
--            invoices:  [{contact_id, reference, document_date, due_date, currency_code,
--                         fx_rate_to_base, amount_minor}]                    (outstanding gross)
--            bills:     same shape (reference = supplier invoice number)
--   returns: {batch_id, journal_ids, opening_date, total_debit_minor, total_credit_minor,
--             plug_minor, invoice_count, bill_count}
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_conversion_balances(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _company_id UUID;
  _conv DATE;
  _open DATE;
  _plug BOOLEAN;
  _note TEXT;
  _base CHAR(3);
  _ar UUID;
  _ap UUID;
  _obe UUID;
  _batch_id UUID := gen_random_uuid();
  _row JSONB;
  _acct RECORD;
  _acct_id UUID;
  _debit BIGINT;
  _credit BIGINT;
  _seen UUID[] := '{}';
  _tb_lines JSONB := '[]'::JSONB;
  _tb_d BIGINT := 0;
  _tb_c BIGINT := 0;
  _tb_count INT := 0;
  -- documents
  _doc JSONB;
  _kind TEXT;
  _contact UUID;
  _ref TEXT;
  _ddate DATE;
  _due DATE;
  _ccy CHAR(3);
  _rate NUMERIC(18, 8);
  _amt BIGINT;
  _crow RECORD;
  _refs TEXT[];
  _ar_base_ccy BIGINT := 0;
  _ap_base_ccy BIGINT := 0;
  _inv_n INT := 0;
  _bill_n INT := 0;
  _ccy_rates JSONB := '{}'::JSONB;      -- currency -> rate (one rate per currency)
  _ccy_ar JSONB := '{}'::JSONB;         -- currency -> total AR minor
  _ccy_ap JSONB := '{}'::JSONB;         -- currency -> total AP minor
  _c TEXT;
  _tot BIGINT;
  _b BIGINT;
  _ar_foreign_base BIGINT := 0;
  _ap_foreign_base BIGINT := 0;
  _debits BIGINT;
  _credits BIGINT;
  _diff BIGINT;
  _plug_minor BIGINT := 0;
  _base_lines JSONB;
  _base_journal UUID;
  _journal_ids UUID[] := '{}';
  _jid UUID;
  _ccy_journal JSONB := '{}'::JSONB;    -- 'ar:EUR' / 'ap:EUR' -> journal id
  _key TEXT;
  _existing_before BIGINT;
  _old_conv DATE;
  _doc_journal UUID;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  _company_id := NULLIF(payload->>'company_id', '')::UUID;
  IF _company_id IS NULL THEN RAISE EXCEPTION 'company_id is required'; END IF;
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT public.has_company_permission(_company_id, 'accounting.conversion.manage') THEN
    RAISE EXCEPTION 'You do not have permission to post conversion balances';
  END IF;

  _conv := NULLIF(payload->>'conversion_date', '')::DATE;
  IF _conv IS NULL THEN RAISE EXCEPTION 'Conversion date is required'; END IF;
  IF _conv > CURRENT_DATE + 366 THEN RAISE EXCEPTION 'Conversion date is too far in the future'; END IF;
  _open := _conv - 1;
  _plug := COALESCE((payload->>'post_difference_to_opening_equity')::BOOLEAN, false);
  _note := NULLIF(left(trim(COALESCE(payload->>'note', '')), 500), '');

  -- Serialise per company
  SELECT base_currency INTO _base FROM public.companies WHERE id = _company_id FOR UPDATE;
  IF _base IS NULL THEN RAISE EXCEPTION 'Organisation not found'; END IF;

  IF EXISTS (SELECT 1 FROM public.conversion_balance_batches WHERE company_id = _company_id AND status = 'posted') THEN
    RAISE EXCEPTION 'Conversion balances are already posted. Reverse them first to enter them again.';
  END IF;

  SELECT count(*) INTO _existing_before
  FROM public.journals j
  WHERE j.company_id = _company_id AND j.status = 'posted' AND j.journal_date < _conv
    AND NOT (j.source_type::TEXT = 'opening_balance' AND j.reversed_by_journal_id IS NOT NULL)
    AND NOT (j.source_type::TEXT = 'reversal' AND EXISTS (
      SELECT 1 FROM public.journals o WHERE o.id = j.reverses_journal_id AND o.source_type::TEXT = 'opening_balance'));
  IF _existing_before > 0 THEN
    RAISE EXCEPTION '% journal(s) are already posted before the conversion date %. Choose an earlier conversion date.',
      _existing_before, _conv;
  END IF;

  _ar := public.ledger_control_account(_company_id, 'ar');
  _ap := public.ledger_control_account(_company_id, 'ap');
  _obe := public.ledger_control_account(_company_id, 'opening_equity');

  IF jsonb_typeof(COALESCE(payload->'tb_lines', '[]'::JSONB)) <> 'array'
     OR jsonb_typeof(COALESCE(payload->'invoices', '[]'::JSONB)) <> 'array'
     OR jsonb_typeof(COALESCE(payload->'bills', '[]'::JSONB)) <> 'array' THEN
    RAISE EXCEPTION 'tb_lines, invoices and bills must be arrays';
  END IF;

  -- ---- Trial balance lines (no writes yet) ----
  FOR _row IN SELECT value FROM jsonb_array_elements(COALESCE(payload->'tb_lines', '[]'::JSONB))
  LOOP
    _acct_id := NULLIF(_row->>'account_id', '')::UUID;
    _debit := COALESCE(NULLIF(_row->>'debit_minor', '')::BIGINT, 0);
    _credit := COALESCE(NULLIF(_row->>'credit_minor', '')::BIGINT, 0);
    IF _acct_id IS NULL THEN RAISE EXCEPTION 'A trial balance line is missing its account'; END IF;
    IF _debit < 0 OR _credit < 0 THEN RAISE EXCEPTION 'Trial balance amounts cannot be negative'; END IF;
    IF _debit > 0 AND _credit > 0 THEN
      RAISE EXCEPTION 'A trial balance line cannot have both a debit and a credit';
    END IF;
    IF _debit = 0 AND _credit = 0 THEN CONTINUE; END IF;
    IF _acct_id = ANY (_seen) THEN RAISE EXCEPTION 'An account appears twice in the trial balance'; END IF;
    _seen := _seen || _acct_id;
    SELECT * INTO _acct FROM public.accounts WHERE id = _acct_id AND company_id = _company_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Account % not found in this organisation', _acct_id; END IF;
    IF NOT _acct.is_active OR _acct.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'Account % is inactive', _acct.code;
    END IF;
    IF NOT _acct.is_postable THEN RAISE EXCEPTION 'Account % is not postable', _acct.code; END IF;
    IF (_ar IS NOT NULL AND _acct_id = _ar)
       OR (_ap IS NOT NULL AND _acct_id = _ap)
       OR _acct.account_kind IN ('accounts_receivable', 'accounts_payable') THEN
      RAISE EXCEPTION 'Account % is a receivables / payables control account. Enter opening invoices and bills per contact instead.', _acct.code;
    END IF;
    _tb_lines := _tb_lines || jsonb_build_array(jsonb_build_object(
      'account_id', _acct_id, 'description', 'Conversion balance',
      'debit_minor', _debit, 'credit_minor', _credit));
    _tb_d := _tb_d + _debit;
    _tb_c := _tb_c + _credit;
    _tb_count := _tb_count + 1;
  END LOOP;

  -- ---- Opening invoices and bills (validate, accumulate) ----
  IF (jsonb_array_length(COALESCE(payload->'invoices', '[]'::JSONB)) > 0 AND _ar IS NULL) THEN
    RAISE EXCEPTION 'Accounts receivable control account is missing. Seed the chart of accounts first.';
  END IF;
  IF (jsonb_array_length(COALESCE(payload->'bills', '[]'::JSONB)) > 0 AND _ap IS NULL) THEN
    RAISE EXCEPTION 'Accounts payable control account is missing. Seed the chart of accounts first.';
  END IF;

  FOR _kind IN SELECT unnest(ARRAY['invoices', 'bills'])
  LOOP
    _refs := '{}';
    FOR _doc IN SELECT value FROM jsonb_array_elements(COALESCE(payload->_kind, '[]'::JSONB))
    LOOP
      _contact := NULLIF(_doc->>'contact_id', '')::UUID;
      _ref := NULLIF(left(trim(COALESCE(_doc->>'reference', '')), 80), '');
      _ddate := NULLIF(_doc->>'document_date', '')::DATE;
      _due := COALESCE(NULLIF(_doc->>'due_date', '')::DATE, _ddate);
      _ccy := upper(COALESCE(NULLIF(_doc->>'currency_code', ''), _base));
      _amt := NULLIF(_doc->>'amount_minor', '')::BIGINT;
      _rate := CASE WHEN _ccy::TEXT = _base::TEXT THEN 1
                    ELSE NULLIF(_doc->>'fx_rate_to_base', '')::NUMERIC END;
      IF _contact IS NULL THEN RAISE EXCEPTION 'Every opening % needs a contact', rtrim(_kind, 's'); END IF;
      IF _ref IS NULL THEN RAISE EXCEPTION 'Every opening % needs a reference number', rtrim(_kind, 's'); END IF;
      IF _ddate IS NULL THEN RAISE EXCEPTION 'Opening % % needs a document date', rtrim(_kind, 's'), _ref; END IF;
      IF _ddate >= _conv THEN
        RAISE EXCEPTION 'Opening % % must be dated before the conversion date %', rtrim(_kind, 's'), _ref, _conv;
      END IF;
      IF _due < _ddate THEN RAISE EXCEPTION 'Opening % % has a due date before its document date', rtrim(_kind, 's'), _ref; END IF;
      IF _amt IS NULL OR _amt <= 0 THEN
        RAISE EXCEPTION 'Opening % % needs an outstanding amount above zero', rtrim(_kind, 's'), _ref;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.currency_decimals WHERE code::TEXT = _ccy::TEXT) THEN
        RAISE EXCEPTION 'Unsupported currency %', _ccy;
      END IF;
      IF _rate IS NULL OR _rate <= 0 THEN
        RAISE EXCEPTION 'Enter the conversion-date exchange rate for % (opening % %)', _ccy, rtrim(_kind, 's'), _ref;
      END IF;
      IF _ccy::TEXT <> _base::TEXT THEN
        IF _ccy_rates ? _ccy::TEXT AND (_ccy_rates->>_ccy::TEXT)::NUMERIC <> _rate THEN
          RAISE EXCEPTION 'Use one conversion-date exchange rate per currency (% has more than one)', _ccy;
        END IF;
        _ccy_rates := _ccy_rates || jsonb_build_object(_ccy::TEXT, _rate);
      END IF;

      SELECT c.kind::TEXT AS kind, c.is_active INTO _crow
      FROM public.contacts c WHERE c.id = _contact AND c.company_id = _company_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Contact for opening % % not found in this organisation', rtrim(_kind, 's'), _ref; END IF;
      IF NOT _crow.is_active THEN RAISE EXCEPTION 'Contact for opening % % is inactive', rtrim(_kind, 's'), _ref; END IF;
      IF _kind = 'invoices' AND _crow.kind NOT IN ('customer', 'both') THEN
        RAISE EXCEPTION 'Opening invoice % needs a customer contact', _ref;
      END IF;
      IF _kind = 'bills' AND _crow.kind NOT IN ('supplier', 'both') THEN
        RAISE EXCEPTION 'Opening bill % needs a supplier contact', _ref;
      END IF;

      IF (_contact::TEXT || '|' || lower(_ref)) = ANY (_refs) THEN
        RAISE EXCEPTION 'Reference % is used twice for the same contact', _ref;
      END IF;
      _refs := _refs || (_contact::TEXT || '|' || lower(_ref));

      IF _kind = 'invoices' THEN
        IF EXISTS (SELECT 1 FROM public.sales_invoices
                   WHERE company_id = _company_id AND lower(invoice_number) = lower(_ref) AND status::TEXT <> 'void') THEN
          RAISE EXCEPTION 'Invoice number % already exists', _ref;
        END IF;
        _inv_n := _inv_n + 1;
        IF _ccy::TEXT = _base::TEXT THEN
          _ar_base_ccy := _ar_base_ccy + _amt;
        ELSE
          _ccy_ar := _ccy_ar || jsonb_build_object(_ccy::TEXT, COALESCE((_ccy_ar->>_ccy::TEXT)::BIGINT, 0) + _amt);
        END IF;
      ELSE
        IF EXISTS (SELECT 1 FROM public.purchase_bills
                   WHERE company_id = _company_id AND contact_id = _contact
                     AND lower(supplier_invoice_number) = lower(_ref) AND status::TEXT <> 'void') THEN
          RAISE EXCEPTION 'Supplier invoice number % already exists for that supplier', _ref;
        END IF;
        _bill_n := _bill_n + 1;
        IF _ccy::TEXT = _base::TEXT THEN
          _ap_base_ccy := _ap_base_ccy + _amt;
        ELSE
          _ccy_ap := _ccy_ap || jsonb_build_object(_ccy::TEXT, COALESCE((_ccy_ap->>_ccy::TEXT)::BIGINT, 0) + _amt);
        END IF;
      END IF;
    END LOOP;
  END LOOP;

  -- Foreign totals in base currency (same rounding the ledger applies to a single-line journal).
  FOR _c, _tot IN SELECT key, value::TEXT::BIGINT FROM jsonb_each(_ccy_ar)
  LOOP
    _ar_foreign_base := _ar_foreign_base
      + public.fx_to_base_minor(_tot, (_ccy_rates->>_c)::NUMERIC, _c, _base);
  END LOOP;
  FOR _c, _tot IN SELECT key, value::TEXT::BIGINT FROM jsonb_each(_ccy_ap)
  LOOP
    _ap_foreign_base := _ap_foreign_base
      + public.fx_to_base_minor(_tot, (_ccy_rates->>_c)::NUMERIC, _c, _base);
  END LOOP;

  -- ---- Balance check (base equivalents) ----
  _debits := _tb_d + _ar_base_ccy + _ar_foreign_base;
  _credits := _tb_c + _ap_base_ccy + _ap_foreign_base;
  _diff := _debits - _credits;
  IF _debits = 0 AND _credits = 0 THEN
    RAISE EXCEPTION 'Enter at least one opening balance';
  END IF;
  IF _diff <> 0 THEN
    IF NOT _plug THEN
      RAISE EXCEPTION 'Opening balances do not balance: debits % <> credits % (difference % minor units)',
        _debits, _credits, _diff;
    END IF;
    IF _obe IS NULL THEN
      RAISE EXCEPTION 'Opening Balance Equity account is missing, so the difference cannot be posted';
    END IF;
    _plug_minor := abs(_diff);
  END IF;

  -- ---- Writes ----
  -- Conversion date on the lock policy (the guard itself is relaxed for this transaction below).
  SELECT conversion_date INTO _old_conv FROM public.organisation_lock_policy WHERE company_id = _company_id;
  INSERT INTO public.organisation_lock_policy (company_id, conversion_date, updated_by)
  VALUES (_company_id, _conv, _uid)
  ON CONFLICT (company_id) DO UPDATE SET conversion_date = EXCLUDED.conversion_date,
    updated_at = now(), updated_by = _uid;
  INSERT INTO public.settings_change_log (
    company_id, actor_user_id, category, setting_key, old_value, new_value, reason, source
  ) VALUES (
    _company_id, _uid, 'accounting', 'conversion_date',
    to_jsonb(_old_conv), to_jsonb(_conv), COALESCE(_note, 'Conversion balances posted'), 'ui'
  );

  PERFORM set_config('linkbooks.conversion_post', 'on', true);
  PERFORM public.ensure_fiscal_period_for_date(_company_id, _open);

  -- Base-currency journal
  _base_lines := _tb_lines;
  IF _ar_base_ccy > 0 THEN
    _base_lines := _base_lines || jsonb_build_array(jsonb_build_object(
      'account_id', _ar, 'description', 'Opening receivables',
      'debit_minor', _ar_base_ccy, 'credit_minor', 0));
  END IF;
  IF _ap_base_ccy > 0 THEN
    _base_lines := _base_lines || jsonb_build_array(jsonb_build_object(
      'account_id', _ap, 'description', 'Opening payables',
      'debit_minor', 0, 'credit_minor', _ap_base_ccy));
  END IF;
  IF _ar_foreign_base > 0 THEN
    _base_lines := _base_lines || jsonb_build_array(jsonb_build_object(
      'account_id', _obe, 'description', 'Foreign-currency receivables (offset in currency journals)',
      'debit_minor', _ar_foreign_base, 'credit_minor', 0));
  END IF;
  IF _ap_foreign_base > 0 THEN
    _base_lines := _base_lines || jsonb_build_array(jsonb_build_object(
      'account_id', _obe, 'description', 'Foreign-currency payables (offset in currency journals)',
      'debit_minor', 0, 'credit_minor', _ap_foreign_base));
  END IF;
  IF _plug_minor > 0 THEN
    _base_lines := _base_lines || jsonb_build_array(jsonb_build_object(
      'account_id', _obe, 'description', 'Opening balance difference (explicitly accepted)',
      'debit_minor', CASE WHEN _diff < 0 THEN _plug_minor ELSE 0 END,
      'credit_minor', CASE WHEN _diff > 0 THEN _plug_minor ELSE 0 END));
  END IF;

  -- A journal needs two lines; the base journal always has them when anything base-side exists.
  IF jsonb_array_length(_base_lines) >= 2 THEN
    _base_journal := public.post_journal(jsonb_build_object(
      'company_id', _company_id,
      'journal_date', _open,
      'memo', 'Conversion balances as at ' || _open::TEXT,
      'currency_code', _base,
      'fx_rate_to_base', 1,
      'source_type', 'opening_balance',
      'source_id', _batch_id,
      'idempotency_key', 'conversion:' || _batch_id::TEXT || ':base',
      'lines', _base_lines));
    _journal_ids := _journal_ids || _base_journal;
  ELSIF jsonb_array_length(_base_lines) > 0 THEN
    RAISE EXCEPTION 'The base-currency opening journal needs at least two lines';
  END IF;

  -- Foreign-currency journals: one for AR and one for AP per currency
  FOR _c, _tot IN SELECT key, value::TEXT::BIGINT FROM jsonb_each(_ccy_ar)
  LOOP
    _jid := public.post_journal(jsonb_build_object(
      'company_id', _company_id, 'journal_date', _open,
      'memo', 'Conversion balances: receivables in ' || _c,
      'currency_code', _c, 'fx_rate_to_base', (_ccy_rates->>_c)::NUMERIC,
      'source_type', 'opening_balance', 'source_id', _batch_id,
      'idempotency_key', 'conversion:' || _batch_id::TEXT || ':ar:' || _c,
      'lines', jsonb_build_array(
        jsonb_build_object('account_id', _ar, 'description', 'Opening receivables ' || _c,
                           'debit_minor', _tot, 'credit_minor', 0),
        jsonb_build_object('account_id', _obe, 'description', 'Offset to base-currency journal',
                           'debit_minor', 0, 'credit_minor', _tot))));
    _journal_ids := _journal_ids || _jid;
    _ccy_journal := _ccy_journal || jsonb_build_object('ar:' || _c, _jid);
  END LOOP;
  FOR _c, _tot IN SELECT key, value::TEXT::BIGINT FROM jsonb_each(_ccy_ap)
  LOOP
    _jid := public.post_journal(jsonb_build_object(
      'company_id', _company_id, 'journal_date', _open,
      'memo', 'Conversion balances: payables in ' || _c,
      'currency_code', _c, 'fx_rate_to_base', (_ccy_rates->>_c)::NUMERIC,
      'source_type', 'opening_balance', 'source_id', _batch_id,
      'idempotency_key', 'conversion:' || _batch_id::TEXT || ':ap:' || _c,
      'lines', jsonb_build_array(
        jsonb_build_object('account_id', _obe, 'description', 'Offset to base-currency journal',
                           'debit_minor', _tot, 'credit_minor', 0),
        jsonb_build_object('account_id', _ap, 'description', 'Opening payables ' || _c,
                           'debit_minor', 0, 'credit_minor', _tot))));
    _journal_ids := _journal_ids || _jid;
    _ccy_journal := _ccy_journal || jsonb_build_object('ap:' || _c, _jid);
  END LOOP;

  INSERT INTO public.conversion_balance_batches (
    id, company_id, conversion_date, opening_date, status, journal_ids,
    total_debit_minor, total_credit_minor, plug_to_opening_equity_minor,
    tb_line_count, invoice_count, bill_count, note, created_by
  ) VALUES (
    _batch_id, _company_id, _conv, _open, 'posted', _journal_ids,
    _debits + CASE WHEN _diff < 0 THEN _plug_minor ELSE 0 END,
    _credits + CASE WHEN _diff > 0 THEN _plug_minor ELSE 0 END,
    _plug_minor, _tb_count, _inv_n, _bill_n, _note, _uid
  );

  -- Opening documents (authorised, linked to the journal that carries their control-account line)
  FOR _doc IN SELECT value FROM jsonb_array_elements(COALESCE(payload->'invoices', '[]'::JSONB))
  LOOP
    _ccy := upper(COALESCE(NULLIF(_doc->>'currency_code', ''), _base));
    _doc_journal := CASE WHEN _ccy::TEXT = _base::TEXT THEN _base_journal
                         ELSE (_ccy_journal->>('ar:' || _ccy::TEXT))::UUID END;
    _ddate := (_doc->>'document_date')::DATE;
    _amt := (_doc->>'amount_minor')::BIGINT;
    INSERT INTO public.sales_invoices (
      company_id, contact_id, invoice_number, invoice_date, due_date, currency_code, status,
      subtotal_minor, tax_minor, total_minor, memo, posted_journal_id, created_by,
      authorised_at, authorised_by, fx_rate_to_base, is_opening_balance, conversion_batch_id
    ) VALUES (
      _company_id, (_doc->>'contact_id')::UUID, left(trim(_doc->>'reference'), 80), _ddate,
      COALESCE(NULLIF(_doc->>'due_date', '')::DATE, _ddate), _ccy, 'authorised',
      _amt, 0, _amt, 'Opening balance', _doc_journal, _uid,
      now(), _uid,
      CASE WHEN _ccy::TEXT = _base::TEXT THEN 1 ELSE (_ccy_rates->>_ccy::TEXT)::NUMERIC END,
      true, _batch_id
    );
  END LOOP;
  FOR _doc IN SELECT value FROM jsonb_array_elements(COALESCE(payload->'bills', '[]'::JSONB))
  LOOP
    _ccy := upper(COALESCE(NULLIF(_doc->>'currency_code', ''), _base));
    _doc_journal := CASE WHEN _ccy::TEXT = _base::TEXT THEN _base_journal
                         ELSE (_ccy_journal->>('ap:' || _ccy::TEXT))::UUID END;
    _ddate := (_doc->>'document_date')::DATE;
    _amt := (_doc->>'amount_minor')::BIGINT;
    INSERT INTO public.purchase_bills (
      company_id, contact_id, bill_number, supplier_invoice_number, bill_date, due_date, currency_code,
      status, subtotal_minor, tax_minor, total_minor, memo, posted_journal_id, created_by,
      authorised_at, authorised_by, tax_calculation, fx_rate_to_base, is_opening_balance, conversion_batch_id
    ) VALUES (
      _company_id, (_doc->>'contact_id')::UUID, 'OB-' || left(trim(_doc->>'reference'), 70),
      left(trim(_doc->>'reference'), 80), _ddate,
      COALESCE(NULLIF(_doc->>'due_date', '')::DATE, _ddate), _ccy,
      'authorised', _amt, 0, _amt, 'Opening balance', _doc_journal, _uid,
      now(), _uid, 'none',
      CASE WHEN _ccy::TEXT = _base::TEXT THEN NULL ELSE (_ccy_rates->>_ccy::TEXT)::NUMERIC END,
      true, _batch_id
    );
  END LOOP;

  PERFORM set_config('linkbooks.conversion_post', 'off', true);

  PERFORM public.record_audit_event(
    _company_id, 'accounting.conversion.posted', 'conversion_balance_batch', _batch_id,
    jsonb_build_object('conversion_date', _conv, 'opening_date', _open,
      'debit_minor', _debits, 'credit_minor', _credits, 'plug_minor', _plug_minor,
      'invoices', _inv_n, 'bills', _bill_n, 'tb_lines', _tb_count, 'journals', to_jsonb(_journal_ids))
  );

  RETURN jsonb_build_object(
    'batch_id', _batch_id,
    'journal_ids', to_jsonb(_journal_ids),
    'opening_date', _open,
    'total_debit_minor', _debits + CASE WHEN _diff < 0 THEN _plug_minor ELSE 0 END,
    'total_credit_minor', _credits + CASE WHEN _diff > 0 THEN _plug_minor ELSE 0 END,
    'plug_minor', _plug_minor,
    'invoice_count', _inv_n,
    'bill_count', _bill_n
  );
END;
$$;

REVOKE ALL ON FUNCTION public.post_conversion_balances(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_conversion_balances(JSONB) TO authenticated;

-- ---------------------------------------------------------------------------
-- reverse_conversion_balances(payload jsonb)
--   payload: company_id, reason
--   Reverses every journal of the active batch and voids the opening documents. Refused while any
--   opening document has a payment, credit or allocation applied.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reverse_conversion_balances(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _company_id UUID;
  _reason TEXT;
  _b RECORD;
  _jid UUID;
  _n_used INT;
  _rev UUID;
  _revs UUID[] := '{}';
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  _company_id := NULLIF(payload->>'company_id', '')::UUID;
  _reason := NULLIF(trim(COALESCE(payload->>'reason', '')), '');
  IF _company_id IS NULL THEN RAISE EXCEPTION 'company_id is required'; END IF;
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT public.has_company_permission(_company_id, 'accounting.conversion.manage') THEN
    RAISE EXCEPTION 'You do not have permission to reverse conversion balances';
  END IF;
  IF _reason IS NULL THEN RAISE EXCEPTION 'A reason is required'; END IF;

  SELECT * INTO _b FROM public.conversion_balance_batches
  WHERE company_id = _company_id AND status = 'posted' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'There are no posted conversion balances to reverse'; END IF;

  SELECT
    (SELECT count(*) FROM public.sales_invoices i
      WHERE i.conversion_batch_id = _b.id AND (i.amount_paid_minor > 0 OR i.amount_credited_minor > 0 OR i.status::TEXT <> 'authorised'))
    + (SELECT count(*) FROM public.purchase_bills p
      WHERE p.conversion_batch_id = _b.id AND (p.amount_paid_minor > 0 OR p.amount_credited_minor > 0 OR p.status::TEXT <> 'authorised'))
  INTO _n_used;
  IF _n_used > 0 THEN
    RAISE EXCEPTION '% opening document(s) already have a payment, credit or status change. Undo those first.', _n_used;
  END IF;

  PERFORM 1 FROM public.sales_invoices WHERE conversion_batch_id = _b.id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.purchase_bills WHERE conversion_batch_id = _b.id ORDER BY id FOR UPDATE;

  PERFORM set_config('linkbooks.opening_reverse', 'on', true);
  PERFORM set_config('linkbooks.conversion_post', 'on', true);
  FOREACH _jid IN ARRAY _b.journal_ids
  LOOP
    _rev := public.reverse_journal_on(_jid, _b.opening_date, 'conversion:' || _b.id::TEXT || ':reverse:' || _jid::TEXT);
    _revs := _revs || _rev;
  END LOOP;

  UPDATE public.sales_invoices
  SET status = 'void', voided_at = now(), voided_by = _uid, void_date = _b.opening_date,
      void_reason = 'Conversion balances reversed: ' || _reason, updated_at = now()
  WHERE conversion_batch_id = _b.id;
  UPDATE public.purchase_bills
  SET status = 'void', updated_at = now(), memo = COALESCE(memo, '') || ' (conversion balances reversed)'
  WHERE conversion_batch_id = _b.id;

  UPDATE public.conversion_balance_batches
  SET status = 'reversed', reversed_by = _uid, reversed_at = now(), reverse_reason = _reason
  WHERE id = _b.id;
  PERFORM set_config('linkbooks.opening_reverse', 'off', true);
  PERFORM set_config('linkbooks.conversion_post', 'off', true);

  PERFORM public.record_audit_event(
    _company_id, 'accounting.conversion.reversed', 'conversion_balance_batch', _b.id,
    jsonb_build_object('reason', _reason, 'reversal_journals', to_jsonb(_revs))
  );
  RETURN jsonb_build_object('batch_id', _b.id, 'reversal_journal_ids', to_jsonb(_revs));
END;
$$;

REVOKE ALL ON FUNCTION public.reverse_conversion_balances(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_conversion_balances(JSONB) TO authenticated;
