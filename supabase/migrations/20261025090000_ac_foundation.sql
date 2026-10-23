-- Wave 2 E (accounting core) foundation. Additive and idempotent. Never edits posted journals.
--
--  * journal_source_type gains 'fx_realised' (realised FX gain/loss on settlement).
--    NOTE: the new value is NOT used in this file (an enum value cannot be used in the transaction
--    that adds it); later migrations use it.
--  * Permissions: accounting.conversion.manage (post / reverse conversion balances) and
--    accounting.conversion.override (post before the conversion date).
--  * assert_journal_date_unlocked: conversion-date rule now has two exceptions,
--      1. the opening-balance RPC (transaction-local setting linkbooks.conversion_post) may post on
--         the day BEFORE the conversion date, and
--      2. users holding accounting.conversion.override.
--    Lock dates (everyone / except advisers) are unchanged.
--  * Small shared helpers: fx_to_base_minor, ledger_control_account, ensure_fx_account.

ALTER TYPE public.journal_source_type ADD VALUE IF NOT EXISTS 'fx_realised';

-- ---------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------
INSERT INTO public.role_permissions (role, permission) VALUES
  ('owner', 'accounting.conversion.manage'),
  ('admin', 'accounting.conversion.manage'),
  ('accountant', 'accounting.conversion.manage'),
  ('owner', 'accounting.conversion.override')
ON CONFLICT (role, permission) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Conversion-date rule with override
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assert_journal_date_unlocked(_company_id UUID, _journal_date DATE)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  pol RECORD;
BEGIN
  SELECT * INTO pol FROM public.organisation_lock_policy WHERE company_id = _company_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  IF pol.conversion_date IS NOT NULL AND _journal_date < pol.conversion_date THEN
    IF current_setting('linkbooks.conversion_post', true) = 'on'
       AND _journal_date = pol.conversion_date - 1 THEN
      NULL; -- the opening-balance journal itself
    ELSIF auth.uid() IS NOT NULL
          AND public.has_company_permission(_company_id, 'accounting.conversion.override') THEN
      NULL; -- explicit override permission
    ELSE
      RAISE EXCEPTION 'Posting before conversion / books-start date % is not allowed', pol.conversion_date;
    END IF;
  END IF;

  IF pol.lock_date_everyone IS NOT NULL AND _journal_date <= pol.lock_date_everyone THEN
    RAISE EXCEPTION 'Period is locked for everyone through %', pol.lock_date_everyone;
  END IF;

  IF pol.lock_date_except_advisors IS NOT NULL
     AND _journal_date <= pol.lock_date_except_advisors
     AND NOT public.is_company_advisor(_company_id) THEN
    RAISE EXCEPTION 'Period is locked through % except for advisers', pol.lock_date_except_advisors;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_journal_date_unlocked(UUID, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assert_journal_date_unlocked(UUID, DATE) TO authenticated;

-- ---------------------------------------------------------------------------
-- fx_to_base_minor: same arithmetic as ledger_balances / convertMinorToBase (TS).
--   base_minor = round(minor * rate * 10 ^ (base_decimals - txn_decimals)), half away from zero.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fx_to_base_minor(
  _minor BIGINT,
  _rate NUMERIC,
  _txn_currency CHAR,
  _base_currency CHAR
)
RETURNS BIGINT
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN upper(_txn_currency::TEXT) = upper(_base_currency::TEXT) THEN _minor
    ELSE round(
      _minor::NUMERIC * _rate
      * power(
          10::NUMERIC,
          COALESCE((SELECT decimal_places FROM public.currency_decimals WHERE code::TEXT = upper(_base_currency::TEXT)), 2)
          - COALESCE((SELECT decimal_places FROM public.currency_decimals WHERE code::TEXT = upper(_txn_currency::TEXT)), 2)
        )
    )::BIGINT
  END;
$$;

REVOKE ALL ON FUNCTION public.fx_to_base_minor(BIGINT, NUMERIC, CHAR, CHAR) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fx_to_base_minor(BIGINT, NUMERIC, CHAR, CHAR) TO authenticated;

-- ---------------------------------------------------------------------------
-- ledger_control_account: the AR / AP control account used by the document modules.
--   AR: system_key 'ar' or code 1100.  AP: system_key 'ap' or code 2000.
-- Internal helper (not callable by clients).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ledger_control_account(_company_id UUID, _role TEXT)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a.id
  FROM public.accounts a
  WHERE a.company_id = _company_id
    AND a.is_active
    AND a.archived_at IS NULL
    AND (
      (_role = 'ar' AND (a.system_key = 'ar' OR a.code = '1100'))
      OR (_role = 'ap' AND (a.system_key = 'ap' OR a.code = '2000'))
      OR (_role = 'opening_equity' AND (a.system_key = 'opening_balance' OR a.code = '3100'))
    )
  ORDER BY (a.system_key IS NOT NULL) DESC, a.created_at
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.ledger_control_account(UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- ensure_fx_account: realised / unrealised FX gain and loss accounts (system accounts).
--   _kind: realised_gain 7700, realised_loss 7710, unrealised_gain 7720, unrealised_loss 7730.
-- Returns the existing account with that code, or creates the system account. Internal helper.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ensure_fx_account(_company_id UUID, _kind TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _code TEXT;
  _name TEXT;
  _type public.account_type;
  _acct_kind TEXT;
  _id UUID;
  _was_trusted TEXT := current_setting('linkbooks.trusted', true);
BEGIN
  _code := CASE _kind
    WHEN 'realised_gain' THEN '7700' WHEN 'realised_loss' THEN '7710'
    WHEN 'unrealised_gain' THEN '7720' WHEN 'unrealised_loss' THEN '7730'
    ELSE NULL END;
  IF _code IS NULL THEN RAISE EXCEPTION 'Unknown FX account kind %', _kind; END IF;
  _name := CASE _kind
    WHEN 'realised_gain' THEN 'Realised FX gains' WHEN 'realised_loss' THEN 'Realised FX losses'
    WHEN 'unrealised_gain' THEN 'Unrealised FX gains' ELSE 'Unrealised FX losses' END;
  _type := CASE WHEN _kind LIKE '%gain' THEN 'income'::public.account_type ELSE 'expense'::public.account_type END;
  _acct_kind := CASE WHEN _kind LIKE '%gain' THEN 'other_income' ELSE 'other_expense' END;

  SELECT id INTO _id FROM public.accounts
  WHERE company_id = _company_id AND code = _code AND is_active AND archived_at IS NULL;
  IF _id IS NOT NULL THEN RETURN _id; END IF;

  -- A same-named account on another code is reused rather than duplicated (names are unique).
  SELECT id INTO _id FROM public.accounts
  WHERE company_id = _company_id AND lower(name) = lower(_name)
    AND is_active AND archived_at IS NULL AND account_type = _type;
  IF _id IS NOT NULL THEN RETURN _id; END IF;

  PERFORM set_config('linkbooks.trusted', 'on', true);
  INSERT INTO public.accounts (
    company_id, code, name, account_type, normal_balance, account_kind, is_system, is_postable
  ) VALUES (
    _company_id, _code, _name, _type,
    CASE WHEN _type = 'income' THEN 'credit'::public.normal_balance ELSE 'debit'::public.normal_balance END,
    _acct_kind, true, true
  )
  ON CONFLICT (company_id, code) DO NOTHING
  RETURNING id INTO _id;
  PERFORM set_config('linkbooks.trusted', COALESCE(_was_trusted, 'off'), true);

  IF _id IS NULL THEN
    SELECT id INTO _id FROM public.accounts WHERE company_id = _company_id AND code = _code;
  END IF;
  RETURN _id;
END;
$$;

REVOKE ALL ON FUNCTION public.ensure_fx_account(UUID, TEXT) FROM PUBLIC, anon, authenticated;
