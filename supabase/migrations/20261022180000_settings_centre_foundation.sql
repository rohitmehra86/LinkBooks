-- Settings Centre foundation: typed config docs, feature flags, two-tier lock dates,
-- conversion date, settings change log, secrets store, posting enforcement.

-- ---------------------------------------------------------------------------
-- Organisation config documents (validated in app; versioned concurrency)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.organisation_config (
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  document JSONB NOT NULL DEFAULT '{}'::jsonb,
  version INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  PRIMARY KEY (company_id, category),
  CONSTRAINT organisation_config_category_chk CHECK (char_length(category) BETWEEN 1 AND 64)
);

CREATE INDEX IF NOT EXISTS organisation_config_company_idx
  ON public.organisation_config (company_id);

ALTER TABLE public.organisation_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members read organisation config" ON public.organisation_config;
CREATE POLICY "Members read organisation config"
  ON public.organisation_config FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

-- Mutations only via SECURITY DEFINER RPCs (no direct client writes)
DROP POLICY IF EXISTS "No direct config writes" ON public.organisation_config;
CREATE POLICY "No direct config writes"
  ON public.organisation_config FOR INSERT TO authenticated
  WITH CHECK (false);

CREATE POLICY "No direct config updates"
  ON public.organisation_config FOR UPDATE TO authenticated
  USING (false);

CREATE POLICY "No direct config deletes"
  ON public.organisation_config FOR DELETE TO authenticated
  USING (false);

GRANT SELECT ON public.organisation_config TO authenticated;

-- ---------------------------------------------------------------------------
-- Feature flags (Universal Feature Manager persistence)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.organisation_features (
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  feature_key TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  PRIMARY KEY (company_id, feature_key),
  CONSTRAINT organisation_features_key_chk CHECK (char_length(feature_key) BETWEEN 1 AND 64)
);

ALTER TABLE public.organisation_features ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members read organisation features" ON public.organisation_features;
CREATE POLICY "Members read organisation features"
  ON public.organisation_features FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

CREATE POLICY "No direct feature inserts"
  ON public.organisation_features FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY "No direct feature updates"
  ON public.organisation_features FOR UPDATE TO authenticated USING (false);
CREATE POLICY "No direct feature deletes"
  ON public.organisation_features FOR DELETE TO authenticated USING (false);

GRANT SELECT ON public.organisation_features TO authenticated;

-- ---------------------------------------------------------------------------
-- Two-tier lock dates + conversion / books-start date
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.organisation_lock_policy (
  company_id UUID PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  lock_date_everyone DATE,
  lock_date_except_advisors DATE,
  conversion_date DATE,
  require_override_reason BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT lock_dates_order_chk CHECK (
    lock_date_everyone IS NULL
    OR lock_date_except_advisors IS NULL
    OR lock_date_everyone >= lock_date_except_advisors
  )
);

ALTER TABLE public.organisation_lock_policy ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members read lock policy" ON public.organisation_lock_policy;
CREATE POLICY "Members read lock policy"
  ON public.organisation_lock_policy FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

CREATE POLICY "No direct lock inserts"
  ON public.organisation_lock_policy FOR INSERT TO authenticated WITH CHECK (false);
CREATE POLICY "No direct lock updates"
  ON public.organisation_lock_policy FOR UPDATE TO authenticated USING (false);
CREATE POLICY "No direct lock deletes"
  ON public.organisation_lock_policy FOR DELETE TO authenticated USING (false);

GRANT SELECT ON public.organisation_lock_policy TO authenticated;

-- ---------------------------------------------------------------------------
-- Settings change log (per-key audit)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.settings_change_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  setting_key TEXT NOT NULL,
  old_value JSONB,
  new_value JSONB,
  reason TEXT,
  request_id TEXT,
  source TEXT NOT NULL DEFAULT 'ui',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS settings_change_log_company_idx
  ON public.settings_change_log (company_id, created_at DESC);

ALTER TABLE public.settings_change_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Audit viewers read settings log" ON public.settings_change_log;
CREATE POLICY "Audit viewers read settings log"
  ON public.settings_change_log FOR SELECT TO authenticated
  USING (public.has_company_permission(company_id, 'audit.view'));

CREATE POLICY "No direct settings log writes"
  ON public.settings_change_log FOR INSERT TO authenticated WITH CHECK (false);

GRANT SELECT ON public.settings_change_log TO authenticated;

-- ---------------------------------------------------------------------------
-- Secrets store (write-only from client; never returned)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.organisation_secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  secret_key TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  last4 TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  rotated_at TIMESTAMPTZ,
  UNIQUE (company_id, secret_key)
);

ALTER TABLE public.organisation_secrets ENABLE ROW LEVEL SECURITY;

-- Members may see metadata only via RPC; table itself not selectable for ciphertext
CREATE POLICY "No direct secret reads"
  ON public.organisation_secrets FOR SELECT TO authenticated USING (false);
CREATE POLICY "No direct secret writes"
  ON public.organisation_secrets FOR ALL TO authenticated USING (false) WITH CHECK (false);

-- ---------------------------------------------------------------------------
-- Advisor helper (owner / admin / accountant)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_company_advisor(_company_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.company_members m
    WHERE m.company_id = _company_id
      AND m.user_id = auth.uid()
      AND m.role IN ('owner', 'admin', 'accountant')
  );
$$;

REVOKE ALL ON FUNCTION public.is_company_advisor(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_company_advisor(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- Posting date guards: conversion + two-tier locks (in addition to period status)
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
    RAISE EXCEPTION 'Posting before conversion / books-start date % is not allowed', pol.conversion_date;
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
-- Upsert organisation config (optimistic concurrency)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.upsert_organisation_config(
  _company_id UUID,
  _category TEXT,
  _document JSONB,
  _expected_version INT DEFAULT NULL,
  _reason TEXT DEFAULT NULL,
  _source TEXT DEFAULT 'ui',
  _request_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _row public.organisation_config%ROWTYPE;
  _old JSONB;
  _new_version INT;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF NOT public.has_company_permission(_company_id, 'company.settings.edit') THEN
    RAISE EXCEPTION 'You do not have permission to edit settings';
  END IF;
  IF _category IS NULL OR length(trim(_category)) = 0 THEN
    RAISE EXCEPTION 'category is required';
  END IF;
  IF _document IS NULL OR jsonb_typeof(_document) <> 'object' THEN
    RAISE EXCEPTION 'document must be a JSON object';
  END IF;

  SELECT * INTO _row FROM public.organisation_config
  WHERE company_id = _company_id AND category = _category
  FOR UPDATE;

  IF FOUND THEN
    IF _expected_version IS NOT NULL AND _row.version IS DISTINCT FROM _expected_version THEN
      RAISE EXCEPTION 'Settings conflict: expected version %, found %', _expected_version, _row.version;
    END IF;
    _old := _row.document;
    _new_version := _row.version + 1;
    UPDATE public.organisation_config
    SET document = _document,
        version = _new_version,
        updated_at = now(),
        updated_by = _uid
    WHERE company_id = _company_id AND category = _category;
  ELSE
    _old := NULL;
    _new_version := 1;
    INSERT INTO public.organisation_config (company_id, category, document, version, updated_by)
    VALUES (_company_id, _category, _document, 1, _uid);
  END IF;

  INSERT INTO public.settings_change_log (
    company_id, actor_user_id, category, setting_key, old_value, new_value, reason, request_id, source
  ) VALUES (
    _company_id, _uid, _category, '*', _old, _document, NULLIF(trim(COALESCE(_reason, '')), ''),
    NULLIF(trim(COALESCE(_request_id, '')), ''), COALESCE(NULLIF(trim(_source), ''), 'ui')
  );

  PERFORM public.record_audit_event(
    _company_id, 'settings.config.updated', 'organisation_config', NULL,
    jsonb_build_object('category', _category, 'version', _new_version)
  );

  RETURN jsonb_build_object(
    'category', _category,
    'document', _document,
    'version', _new_version
  );
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_organisation_config(UUID, TEXT, JSONB, INT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_organisation_config(UUID, TEXT, JSONB, INT, TEXT, TEXT, TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- Set feature flag
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_organisation_feature(
  _company_id UUID,
  _feature_key TEXT,
  _enabled BOOLEAN,
  _config JSONB DEFAULT '{}'::jsonb,
  _reason TEXT DEFAULT NULL,
  _source TEXT DEFAULT 'ui'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _old BOOLEAN;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF NOT public.has_company_permission(_company_id, 'company.settings.edit') THEN
    RAISE EXCEPTION 'You do not have permission to edit settings';
  END IF;

  SELECT enabled INTO _old FROM public.organisation_features
  WHERE company_id = _company_id AND feature_key = _feature_key;

  INSERT INTO public.organisation_features (company_id, feature_key, enabled, config, updated_by)
  VALUES (_company_id, _feature_key, _enabled, COALESCE(_config, '{}'::jsonb), _uid)
  ON CONFLICT (company_id, feature_key) DO UPDATE
  SET enabled = EXCLUDED.enabled,
      config = EXCLUDED.config,
      updated_at = now(),
      updated_by = _uid;

  INSERT INTO public.settings_change_log (
    company_id, actor_user_id, category, setting_key, old_value, new_value, reason, source
  ) VALUES (
    _company_id, _uid, 'features', _feature_key,
    jsonb_build_object('enabled', _old),
    jsonb_build_object('enabled', _enabled, 'config', COALESCE(_config, '{}'::jsonb)),
    NULLIF(trim(COALESCE(_reason, '')), ''),
    COALESCE(NULLIF(trim(_source), ''), 'ui')
  );

  PERFORM public.record_audit_event(
    _company_id, 'settings.feature.updated', 'organisation_feature', NULL,
    jsonb_build_object('feature_key', _feature_key, 'enabled', _enabled)
  );

  RETURN jsonb_build_object('feature_key', _feature_key, 'enabled', _enabled, 'config', COALESCE(_config, '{}'::jsonb));
END;
$$;

REVOKE ALL ON FUNCTION public.set_organisation_feature(UUID, TEXT, BOOLEAN, JSONB, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_organisation_feature(UUID, TEXT, BOOLEAN, JSONB, TEXT, TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- Set lock policy (elevated: periods.lock)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_organisation_lock_policy(
  _company_id UUID,
  _lock_date_everyone DATE DEFAULT NULL,
  _lock_date_except_advisors DATE DEFAULT NULL,
  _conversion_date DATE DEFAULT NULL,
  _require_override_reason BOOLEAN DEFAULT true,
  _reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _old JSONB;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF NOT public.has_company_permission(_company_id, 'periods.lock') THEN
    RAISE EXCEPTION 'You do not have permission to change lock dates';
  END IF;
  IF _lock_date_everyone IS NOT NULL
     AND _lock_date_except_advisors IS NOT NULL
     AND _lock_date_everyone < _lock_date_except_advisors THEN
    RAISE EXCEPTION 'Lock for everyone must be on or after the adviser-exception lock date';
  END IF;
  IF COALESCE(trim(_reason), '') = '' THEN
    RAISE EXCEPTION 'A reason is required to change lock dates';
  END IF;

  SELECT to_jsonb(t) INTO _old FROM public.organisation_lock_policy t WHERE company_id = _company_id;

  INSERT INTO public.organisation_lock_policy (
    company_id, lock_date_everyone, lock_date_except_advisors, conversion_date,
    require_override_reason, updated_by
  ) VALUES (
    _company_id, _lock_date_everyone, _lock_date_except_advisors, _conversion_date,
    COALESCE(_require_override_reason, true), _uid
  )
  ON CONFLICT (company_id) DO UPDATE SET
    lock_date_everyone = EXCLUDED.lock_date_everyone,
    lock_date_except_advisors = EXCLUDED.lock_date_except_advisors,
    conversion_date = EXCLUDED.conversion_date,
    require_override_reason = EXCLUDED.require_override_reason,
    updated_at = now(),
    updated_by = _uid;

  INSERT INTO public.settings_change_log (
    company_id, actor_user_id, category, setting_key, old_value, new_value, reason, source
  ) VALUES (
    _company_id, _uid, 'accounting', 'lock_policy', _old,
    jsonb_build_object(
      'lock_date_everyone', _lock_date_everyone,
      'lock_date_except_advisors', _lock_date_except_advisors,
      'conversion_date', _conversion_date,
      'require_override_reason', COALESCE(_require_override_reason, true)
    ),
    trim(_reason),
    'ui'
  );

  PERFORM public.record_audit_event(
    _company_id, 'settings.lock_policy.updated', 'organisation_lock_policy', _company_id,
    jsonb_build_object('reason', trim(_reason))
  );

  RETURN jsonb_build_object(
    'lock_date_everyone', _lock_date_everyone,
    'lock_date_except_advisors', _lock_date_except_advisors,
    'conversion_date', _conversion_date,
    'require_override_reason', COALESCE(_require_override_reason, true)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.set_organisation_lock_policy(UUID, DATE, DATE, DATE, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_organisation_lock_policy(UUID, DATE, DATE, DATE, BOOLEAN, TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- Write secret (returns metadata only — never ciphertext)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.write_organisation_secret(
  _company_id UUID,
  _secret_key TEXT,
  _plaintext TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _last4 TEXT;
  _cipher TEXT;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF NOT public.has_company_permission(_company_id, 'company.settings.edit') THEN
    RAISE EXCEPTION 'You do not have permission to manage secrets';
  END IF;
  IF _plaintext IS NULL OR length(_plaintext) < 8 THEN
    RAISE EXCEPTION 'Secret value is too short';
  END IF;
  _last4 := right(_plaintext, 4);
  -- Opaque digest only — never recoverable via API. Live integration vault is Stage 5+.
  _cipher := encode(sha256(convert_to(_plaintext || ':' || _company_id::text || ':' || _secret_key, 'UTF8')), 'hex');

  INSERT INTO public.organisation_secrets (company_id, secret_key, ciphertext, last4, created_by, rotated_at)
  VALUES (_company_id, _secret_key, _cipher, _last4, _uid, now())
  ON CONFLICT (company_id, secret_key) DO UPDATE
  SET ciphertext = EXCLUDED.ciphertext,
      last4 = EXCLUDED.last4,
      rotated_at = now(),
      created_by = _uid;

  INSERT INTO public.settings_change_log (
    company_id, actor_user_id, category, setting_key, old_value, new_value, source
  ) VALUES (
    _company_id, _uid, 'integrations', _secret_key,
    NULL,
    jsonb_build_object('rotated', true, 'last4', _last4),
    'ui'
  );

  RETURN jsonb_build_object('secret_key', _secret_key, 'last4', _last4, 'rotated', true);
END;
$$;

REVOKE ALL ON FUNCTION public.write_organisation_secret(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.write_organisation_secret(UUID, TEXT, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.list_organisation_secret_meta(_company_id UUID)
RETURNS TABLE (secret_key TEXT, last4 TEXT, rotated_at TIMESTAMPTZ, created_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF NOT public.has_company_permission(_company_id, 'company.settings.edit') THEN
    RAISE EXCEPTION 'You do not have permission to view secret metadata';
  END IF;
  RETURN QUERY
  SELECT s.secret_key, s.last4, s.rotated_at, s.created_at
  FROM public.organisation_secrets s
  WHERE s.company_id = _company_id
  ORDER BY s.secret_key;
END;
$$;

REVOKE ALL ON FUNCTION public.list_organisation_secret_meta(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_organisation_secret_meta(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- Patch post_journal: call assert_journal_date_unlocked after period status
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_journal(payload JSONB)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _uid UUID := auth.uid();
  _company_id UUID;
  _journal_date DATE;
  _memo TEXT;
  _currency CHAR(3);
  _fx NUMERIC(18,8);
  _source_type public.journal_source_type;
  _source_id UUID;
  _idem TEXT;
  _reverses UUID;
  _period_id UUID;
  _period_status public.period_status;
  _journal_id UUID;
  _existing UUID;
  _line JSONB;
  _line_no INT := 0;
  _account_id UUID;
  _debit BIGINT;
  _credit BIGINT;
  _sum_debit BIGINT := 0;
  _sum_credit BIGINT := 0;
  _acct RECORD;
  _base_currency CHAR(3);
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;

  _company_id := (payload->>'company_id')::UUID;
  IF _company_id IS NULL THEN RAISE EXCEPTION 'company_id is required'; END IF;

  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT (
    public.has_company_permission(_company_id, 'accounting.post')
    OR public.has_company_permission(_company_id, 'journals.manual')
  ) THEN
    RAISE EXCEPTION 'You do not have permission to post journals';
  END IF;

  _journal_date := (payload->>'journal_date')::DATE;
  IF _journal_date IS NULL THEN RAISE EXCEPTION 'journal_date is required'; END IF;
  _memo := NULLIF(trim(COALESCE(payload->>'memo', '')), '');
  _currency := upper(COALESCE(payload->>'currency_code', ''));
  _fx := COALESCE((payload->>'fx_rate_to_base')::NUMERIC, 1);
  IF _fx <= 0 THEN RAISE EXCEPTION 'fx_rate_to_base must be positive'; END IF;
  _source_type := COALESCE((payload->>'source_type')::public.journal_source_type, 'manual');
  _source_id := NULLIF(payload->>'source_id', '')::UUID;
  _idem := NULLIF(trim(COALESCE(payload->>'idempotency_key', '')), '');
  _reverses := NULLIF(payload->>'reverses_journal_id', '')::UUID;

  SELECT base_currency INTO _base_currency FROM public.companies WHERE id = _company_id;
  IF _currency = '' THEN _currency := _base_currency; END IF;
  IF length(_currency) <> 3 THEN RAISE EXCEPTION 'Invalid currency_code'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.currency_decimals WHERE code = _currency) THEN
    RAISE EXCEPTION 'Unsupported currency %', _currency;
  END IF;

  IF _idem IS NOT NULL THEN
    SELECT id INTO _existing FROM public.journals
    WHERE company_id = _company_id AND idempotency_key = _idem;
    IF _existing IS NOT NULL THEN
      RETURN _existing;
    END IF;
  END IF;

  SELECT id, status INTO _period_id, _period_status
  FROM public.accounting_periods
  WHERE company_id = _company_id
    AND start_date <= _journal_date
    AND end_date >= _journal_date
  LIMIT 1;

  IF _period_id IS NULL THEN
    RAISE EXCEPTION 'No accounting period covers posting date %', _journal_date;
  END IF;
  IF _period_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'Accounting period is %; posting is not allowed', _period_status;
  END IF;

  -- Two-tier lock dates + conversion date (Settings Centre)
  PERFORM public.assert_journal_date_unlocked(_company_id, _journal_date);

  IF jsonb_typeof(payload->'lines') <> 'array' OR jsonb_array_length(payload->'lines') < 2 THEN
    RAISE EXCEPTION 'Journal requires at least two lines';
  END IF;

  PERFORM set_config('linkbooks.trusted', 'on', true);

  INSERT INTO public.journals (
    company_id, journal_number, journal_date, period_id, status,
    source_type, source_id, idempotency_key, memo, currency_code, fx_rate_to_base,
    reverses_journal_id, created_by, posted_at, posted_by
  ) VALUES (
    _company_id, public.next_journal_number(_company_id), _journal_date, _period_id, 'posted',
    _source_type, _source_id, _idem, _memo, _currency, _fx,
    _reverses, _uid, now(), _uid
  ) RETURNING id INTO _journal_id;

  FOR _line IN SELECT value FROM jsonb_array_elements(payload->'lines')
  LOOP
    _line_no := _line_no + 1;
    _account_id := (_line->>'account_id')::UUID;
    _debit := COALESCE((_line->>'debit_minor')::BIGINT, 0);
    _credit := COALESCE((_line->>'credit_minor')::BIGINT, 0);

    IF _account_id IS NULL THEN
      RAISE EXCEPTION 'Line % missing account_id', _line_no;
    END IF;
    IF (_debit > 0 AND _credit > 0) OR (_debit = 0 AND _credit = 0) THEN
      RAISE EXCEPTION 'Line % must have either debit_minor or credit_minor > 0, not both', _line_no;
    END IF;
    IF _debit < 0 OR _credit < 0 THEN
      RAISE EXCEPTION 'Line % amounts must be non-negative minor units', _line_no;
    END IF;

    SELECT * INTO _acct FROM public.accounts WHERE id = _account_id AND company_id = _company_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Account % not found in organisation', _account_id;
    END IF;
    IF NOT _acct.is_active OR _acct.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'Account % is inactive', _acct.code;
    END IF;
    IF NOT _acct.is_postable THEN
      RAISE EXCEPTION 'Account % is not postable', _acct.code;
    END IF;

    INSERT INTO public.journal_lines (
      journal_id, company_id, line_no, account_id, description, debit_minor, credit_minor
    ) VALUES (
      _journal_id, _company_id, _line_no, _account_id,
      NULLIF(trim(COALESCE(_line->>'description', '')), ''),
      _debit, _credit
    );

    _sum_debit := _sum_debit + _debit;
    _sum_credit := _sum_credit + _credit;
  END LOOP;

  IF _sum_debit <> _sum_credit THEN
    RAISE EXCEPTION 'Journal does not balance: debits % <> credits % (minor units)', _sum_debit, _sum_credit;
  END IF;
  IF _sum_debit = 0 THEN
    RAISE EXCEPTION 'Journal total cannot be zero';
  END IF;

  IF _reverses IS NOT NULL THEN
    UPDATE public.journals
    SET reversed_by_journal_id = _journal_id, updated_at = now()
    WHERE id = _reverses AND company_id = _company_id AND status = 'posted';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Journal to reverse not found or not posted';
    END IF;
  END IF;

  INSERT INTO public.audit_events (company_id, actor_user_id, action, entity_type, entity_id, details)
  VALUES (
    _company_id, _uid, 'journal.posted', 'journal', _journal_id,
    jsonb_build_object(
      'debit_minor', _sum_debit,
      'credit_minor', _sum_credit,
      'source_type', _source_type,
      'idempotency_key', _idem,
      'reverses_journal_id', _reverses
    )
  );

  PERFORM set_config('linkbooks.trusted', 'off', true);
  RETURN _journal_id;

EXCEPTION WHEN unique_violation THEN
  IF _idem IS NOT NULL THEN
    SELECT id INTO _existing FROM public.journals
    WHERE company_id = _company_id AND idempotency_key = _idem;
    IF _existing IS NOT NULL THEN
      PERFORM set_config('linkbooks.trusted', 'off', true);
      RETURN _existing;
    END IF;
  END IF;
  RAISE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.post_journal(JSONB) TO authenticated;

-- Belt-and-braces: enforce lock dates on every journal insert path
CREATE OR REPLACE FUNCTION public.journals_assert_lock_dates()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.assert_journal_date_unlocked(NEW.company_id, NEW.journal_date);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS journals_lock_dates_trg ON public.journals;
CREATE TRIGGER journals_lock_dates_trg
BEFORE INSERT ON public.journals
FOR EACH ROW
EXECUTE FUNCTION public.journals_assert_lock_dates();

-- Seed default feature rows for existing companies (disabled unless already operational)
INSERT INTO public.organisation_features (company_id, feature_key, enabled)
SELECT c.id, f.key, f.enabled
FROM public.companies c
CROSS JOIN (VALUES
  ('classes', true),
  ('locations', true),
  ('projects', true),
  ('departments', false),
  ('cost_centres', false),
  ('branches', false),
  ('custom_dimensions', false),
  ('purchase_orders', true),
  ('sales_orders', false),
  ('billable_expenses', true),
  ('discounts', true),
  ('inventory', false),
  ('recurring_transactions', true),
  ('multicurrency', true),
  ('voice_commands', false),
  ('ai_assistant', false),
  ('advanced_approvals', true),
  ('time_tracking', false),
  ('fixed_assets', false),
  ('portals', false),
  ('late_fees', false),
  ('retainers', false),
  ('price_lists', false)
) AS f(key, enabled)
ON CONFLICT (company_id, feature_key) DO NOTHING;
