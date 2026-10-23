-- Ledger write-path hardening (from independent review docs/audit/SONNET_INDEPENDENT_REVIEW.md)
-- Additive / tightening only. Never edits posted journals. post_journal and
-- reverse_journal are SECURITY DEFINER and are unaffected by RLS changes below.

-- ---------------------------------------------------------------------------
-- S1/S2: direct INSERT into journals / journal_lines must be draft + same company
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Posters can insert draft journals" ON public.journals;
CREATE POLICY "Posters can insert draft journals" ON public.journals
  FOR INSERT TO authenticated
  WITH CHECK (
    status = 'draft'
    AND (
      public.has_company_permission(company_id, 'accounting.post')
      OR public.has_company_permission(company_id, 'journals.manual')
    )
  );

DROP POLICY IF EXISTS "Posters can insert journal lines" ON public.journal_lines;
CREATE POLICY "Posters can insert journal lines" ON public.journal_lines
  FOR INSERT TO authenticated
  WITH CHECK (
    (
      public.has_company_permission(company_id, 'accounting.post')
      OR public.has_company_permission(company_id, 'journals.manual')
    )
    AND EXISTS (
      SELECT 1 FROM public.journals j
      WHERE j.id = journal_lines.journal_id
        AND j.company_id = journal_lines.company_id
        AND j.status = 'draft'
    )
    AND EXISTS (
      SELECT 1 FROM public.accounts a
      WHERE a.id = journal_lines.account_id
        AND a.company_id = journal_lines.company_id
    )
  );

-- ---------------------------------------------------------------------------
-- S3: period lock state may only change through lock/unlock RPCs (permissioned + audited)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Lockers can update periods" ON public.accounting_periods;

-- ---------------------------------------------------------------------------
-- S4: loosening lock dates requires periods.unlock (not only periods.lock)
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
  _old_everyone DATE;
  _old_advisors DATE;
  _old_conversion DATE;
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

  SELECT to_jsonb(t), t.lock_date_everyone, t.lock_date_except_advisors, t.conversion_date
    INTO _old, _old_everyone, _old_advisors, _old_conversion
  FROM public.organisation_lock_policy t WHERE company_id = _company_id;

  -- Moving a lock date earlier (or clearing it) reopens closed periods.
  IF (_old_everyone IS NOT NULL AND (_lock_date_everyone IS NULL OR _lock_date_everyone < _old_everyone))
     OR (_old_advisors IS NOT NULL AND (_lock_date_except_advisors IS NULL OR _lock_date_except_advisors < _old_advisors))
     OR (_old_conversion IS NOT NULL AND (_conversion_date IS NULL OR _conversion_date < _old_conversion))
  THEN
    IF NOT public.has_company_permission(_company_id, 'periods.unlock') THEN
      RAISE EXCEPTION 'Moving a lock date earlier requires permission to unlock periods';
    END IF;
  END IF;

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
-- S6: manual journals may not touch subledger control accounts (AR/AP/tax).
-- Opening balances use source_type = 'opening_balance'; documents use their own sources.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.block_manual_control_account_lines()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  _src public.journal_source_type;
  _control BOOLEAN;
BEGIN
  SELECT source_type INTO _src FROM public.journals WHERE id = NEW.journal_id;
  IF _src = 'manual' THEN
    SELECT is_control INTO _control FROM public.accounts WHERE id = NEW.account_id;
    IF COALESCE(_control, false) THEN
      RAISE EXCEPTION 'Manual journals cannot post to a control account (accounts receivable, accounts payable, tax). Use an invoice, bill, credit note, payment or an opening balance journal instead.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS journal_lines_block_manual_control_trg ON public.journal_lines;
CREATE TRIGGER journal_lines_block_manual_control_trg
  BEFORE INSERT ON public.journal_lines
  FOR EACH ROW EXECUTE FUNCTION public.block_manual_control_account_lines();

-- ---------------------------------------------------------------------------
-- S8/S10: unauthenticated callers must not reach SECURITY DEFINER helpers
-- ---------------------------------------------------------------------------
-- seed_fx_accounts is only called from other SECURITY DEFINER functions.
REVOKE ALL ON FUNCTION public.seed_fx_accounts(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.lookup_fx_rate_to_base(
  _company_id UUID,
  _from_currency CHAR,
  _as_of DATE
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _base CHAR(3);
  _rate NUMERIC(18, 8);
BEGIN
  IF current_setting('linkbooks.trusted', true) IS DISTINCT FROM 'on'
     AND (auth.uid() IS NULL OR NOT public.is_company_member(_company_id)) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  SELECT base_currency INTO _base FROM public.companies WHERE id = _company_id;
  IF _base IS NULL THEN RAISE EXCEPTION 'Company not found'; END IF;
  IF UPPER(_from_currency) = UPPER(_base) THEN RETURN 1; END IF;

  SELECT rate INTO _rate
  FROM public.exchange_rates
  WHERE company_id = _company_id
    AND from_currency = UPPER(_from_currency)
    AND to_currency = UPPER(_base)
    AND rate_date <= _as_of
    AND voided_at IS NULL
  ORDER BY rate_date DESC
  LIMIT 1;

  IF _rate IS NULL THEN
    RAISE EXCEPTION 'No exchange rate for % → % on or before %', _from_currency, _base, _as_of;
  END IF;
  RETURN _rate;
END;
$$;

REVOKE ALL ON FUNCTION public.lookup_fx_rate_to_base(UUID, CHAR, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lookup_fx_rate_to_base(UUID, CHAR, DATE) TO authenticated;

REVOKE ALL ON FUNCTION public.ensure_accounting_period_coverage(UUID, DATE, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ensure_accounting_period_coverage(UUID, DATE, DATE, TEXT) TO authenticated;

-- S12: advisers must be active members (parity with has_company_permission).
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
      AND m.status = 'active'
      AND m.role IN ('owner', 'admin', 'accountant')
  );
$$;

REVOKE ALL ON FUNCTION public.is_company_advisor(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_company_advisor(UUID) TO authenticated;
