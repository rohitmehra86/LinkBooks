-- Wave 2 / E: AC-08 account merge with historic dating.
--
-- The old merge posted ONE journal dated today carrying the source account's whole balance, which put
-- prior-year amounts into the current period. This version moves the source account's balance period by
-- period, with one journal per accounting period dated inside that period (the period's last day, or
-- today for the current period), so P&L by period and comparatives stay right. Posted lines are never
-- edited. Periods that are locked cannot take a dated journal: the preview lists them and the caller must
-- either unlock them or explicitly accept posting their share dated today.
--
-- Limits (stated on the screen): accounts held in a foreign currency are not supported. Archiving the
-- source follows the existing archive rules; an income or expense account with activity in the current
-- financial year cannot be archived, so it is left active (balance already moved) and the reason returned.
-- Additive and idempotent.

CREATE OR REPLACE FUNCTION public.account_merge_plan(_company UUID, _source UUID, _target UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _s public.accounts%ROWTYPE;
  _t public.accounts%ROWTYPE;
  _base CHAR(3);
  _p RECORD;
  _periods JSONB := '[]'::jsonb;
  _total BIGINT := 0;
  _locked INTEGER := 0;
  _date DATE;
  _is_locked BOOLEAN;
  _reason TEXT;
BEGIN
  IF _source = _target THEN RAISE EXCEPTION 'Choose a different account to keep'; END IF;
  SELECT * INTO _s FROM public.accounts WHERE id = _source AND company_id = _company;
  IF NOT FOUND THEN RAISE EXCEPTION 'The account to merge was not found'; END IF;
  SELECT * INTO _t FROM public.accounts WHERE id = _target AND company_id = _company;
  IF NOT FOUND THEN RAISE EXCEPTION 'The account to keep was not found'; END IF;
  IF _s.is_system OR _s.is_control OR _s.is_locked THEN RAISE EXCEPTION 'System accounts cannot be merged.'; END IF;
  IF _s.account_type <> _t.account_type THEN RAISE EXCEPTION 'Accounts can only be merged when they share a class.'; END IF;
  IF NOT _t.is_active OR NOT _t.is_postable OR _t.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'The account to keep must be active and postable';
  END IF;
  SELECT base_currency INTO _base FROM public.companies WHERE id = _company;
  IF (_s.currency_code IS NOT NULL AND upper(_s.currency_code::TEXT) <> upper(_base::TEXT))
     OR (_t.currency_code IS NOT NULL AND upper(_t.currency_code::TEXT) <> upper(_base::TEXT)) THEN
    RAISE EXCEPTION 'Merging foreign-currency accounts is not supported';
  END IF;

  FOR _p IN
    SELECT ap.id, ap.name, ap.start_date, ap.end_date, ap.status::TEXT AS status,
           SUM(public.fx_to_base_minor(jl.debit_minor, j.fx_rate_to_base, j.currency_code, _base)
               - public.fx_to_base_minor(jl.credit_minor, j.fx_rate_to_base, j.currency_code, _base))::BIGINT AS net
    FROM public.journal_lines jl
    JOIN public.journals j ON j.id = jl.journal_id AND j.status = 'posted'
    JOIN public.accounting_periods ap ON ap.id = j.period_id
    WHERE jl.company_id = _company AND jl.account_id = _source
    GROUP BY ap.id, ap.name, ap.start_date, ap.end_date, ap.status
    HAVING SUM(public.fx_to_base_minor(jl.debit_minor, j.fx_rate_to_base, j.currency_code, _base)
               - public.fx_to_base_minor(jl.credit_minor, j.fx_rate_to_base, j.currency_code, _base)) <> 0
    ORDER BY ap.start_date
  LOOP
    _date := GREATEST(_p.start_date, LEAST(_p.end_date, CURRENT_DATE));
    _is_locked := FALSE; _reason := NULL;
    IF _p.status <> 'open' THEN
      _is_locked := TRUE; _reason := 'Period is ' || _p.status;
    ELSE
      BEGIN
        PERFORM public.assert_journal_date_unlocked(_company, _date);
      EXCEPTION WHEN OTHERS THEN
        _is_locked := TRUE; _reason := left(SQLERRM, 200);
      END;
    END IF;
    IF _is_locked THEN _locked := _locked + 1; END IF;
    _total := _total + _p.net;
    _periods := _periods || jsonb_build_array(jsonb_build_object(
      'period_id', _p.id, 'period_name', _p.name, 'journal_date', _date,
      'net_minor', _p.net, 'locked', _is_locked, 'lock_reason', _reason));
  END LOOP;

  RETURN jsonb_build_object(
    'source', jsonb_build_object('id', _s.id, 'code', _s.code, 'name', _s.name),
    'target', jsonb_build_object('id', _t.id, 'code', _t.code, 'name', _t.name),
    'periods', _periods, 'total_net_minor', _total, 'locked_count', _locked,
    'today', CURRENT_DATE
  );
END;
$$;

REVOKE ALL ON FUNCTION public.account_merge_plan(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;

-- preview_account_merge(payload{company_id, source_id, target_id})
CREATE OR REPLACE FUNCTION public.preview_account_merge(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _company UUID := NULLIF(payload->>'company_id', '')::UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF _company IS NULL THEN RAISE EXCEPTION 'company_id is required'; END IF;
  IF NOT public.is_company_member(_company) THEN RAISE EXCEPTION 'You do not have access to that organisation'; END IF;
  IF NOT public.has_company_permission(_company, 'accounts.manage') THEN
    RAISE EXCEPTION 'You do not have permission to merge accounts';
  END IF;
  RETURN public.account_merge_plan(_company, NULLIF(payload->>'source_id', '')::UUID, NULLIF(payload->>'target_id', '')::UUID);
END;
$$;

REVOKE ALL ON FUNCTION public.preview_account_merge(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_account_merge(JSONB) TO authenticated;

-- merge_accounts_dated(payload{company_id, source_id, target_id, [post_locked_periods_today]})
CREATE OR REPLACE FUNCTION public.merge_accounts_dated(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _company UUID := NULLIF(payload->>'company_id', '')::UUID;
  _source UUID := NULLIF(payload->>'source_id', '')::UUID;
  _target UUID := NULLIF(payload->>'target_id', '')::UUID;
  _fallback BOOLEAN := COALESCE((payload->>'post_locked_periods_today')::BOOLEAN, FALSE);
  _plan JSONB;
  _p JSONB;
  _net BIGINT;
  _locked_net BIGINT := 0;
  _jids UUID[] := '{}';
  _jid UUID;
  _base CHAR(3);
  _scode TEXT;
  _tcode TEXT;
  _names TEXT;
  _children INTEGER;
  _archived BOOLEAN := FALSE;
  _archive_error TEXT;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF _company IS NULL OR _source IS NULL OR _target IS NULL THEN
    RAISE EXCEPTION 'company_id, source_id and target_id are required';
  END IF;
  IF NOT public.is_company_member(_company) THEN RAISE EXCEPTION 'You do not have access to that organisation'; END IF;
  IF NOT public.has_company_permission(_company, 'accounts.manage') THEN
    RAISE EXCEPTION 'You do not have permission to merge accounts';
  END IF;
  IF NOT (public.has_company_permission(_company, 'accounting.post') OR public.has_company_permission(_company, 'journals.manual')) THEN
    RAISE EXCEPTION 'You do not have permission to post journals';
  END IF;

  -- Serialise merges per company; the plan is computed after the lock.
  PERFORM 1 FROM public.accounts WHERE id IN (_source, _target) AND company_id = _company ORDER BY id FOR UPDATE;
  _plan := public.account_merge_plan(_company, _source, _target);
  SELECT base_currency INTO _base FROM public.companies WHERE id = _company;
  _scode := _plan->'source'->>'code';
  _tcode := _plan->'target'->>'code';

  IF (_plan->>'locked_count')::INTEGER > 0 AND NOT _fallback THEN
    SELECT string_agg(p->>'period_name', ', ') INTO _names
    FROM jsonb_array_elements(_plan->'periods') p WHERE (p->>'locked')::BOOLEAN;
    RAISE EXCEPTION 'These periods are locked and cannot take a dated journal: %. Unlock them, or choose to post their share dated today.', _names;
  END IF;

  FOR _p IN SELECT value FROM jsonb_array_elements(_plan->'periods')
  LOOP
    _net := (_p->>'net_minor')::BIGINT;
    IF (_p->>'locked')::BOOLEAN THEN
      _locked_net := _locked_net + _net;
      CONTINUE;
    END IF;
    _jid := public.post_journal(jsonb_build_object(
      'company_id', _company,
      'journal_date', _p->>'journal_date',
      'memo', 'Merge ' || _scode || ' into ' || _tcode || ' (' || (_p->>'period_name') || ')',
      'currency_code', _base, 'fx_rate_to_base', 1,
      'source_type', 'manual',
      'idempotency_key', 'merge:' || _source::TEXT || ':' || _target::TEXT || ':' || (_p->>'period_id'),
      'lines', CASE WHEN _net > 0 THEN jsonb_build_array(
          jsonb_build_object('account_id', _target, 'description', 'Merged from ' || _scode, 'debit_minor', _net, 'credit_minor', 0),
          jsonb_build_object('account_id', _source, 'description', 'Merged into ' || _tcode, 'debit_minor', 0, 'credit_minor', _net))
        ELSE jsonb_build_array(
          jsonb_build_object('account_id', _source, 'description', 'Merged into ' || _tcode, 'debit_minor', -_net, 'credit_minor', 0),
          jsonb_build_object('account_id', _target, 'description', 'Merged from ' || _scode, 'debit_minor', 0, 'credit_minor', -_net)) END
    ));
    _jids := _jids || _jid;
  END LOOP;

  IF _locked_net <> 0 THEN
    _jid := public.post_journal(jsonb_build_object(
      'company_id', _company,
      'journal_date', CURRENT_DATE,
      'memo', 'Merge ' || _scode || ' into ' || _tcode || ' (locked periods, dated today)',
      'currency_code', _base, 'fx_rate_to_base', 1,
      'source_type', 'manual',
      'idempotency_key', 'merge:' || _source::TEXT || ':' || _target::TEXT || ':locked',
      'lines', CASE WHEN _locked_net > 0 THEN jsonb_build_array(
          jsonb_build_object('account_id', _target, 'description', 'Merged from ' || _scode, 'debit_minor', _locked_net, 'credit_minor', 0),
          jsonb_build_object('account_id', _source, 'description', 'Merged into ' || _tcode, 'debit_minor', 0, 'credit_minor', _locked_net))
        ELSE jsonb_build_array(
          jsonb_build_object('account_id', _source, 'description', 'Merged into ' || _tcode, 'debit_minor', -_locked_net, 'credit_minor', 0),
          jsonb_build_object('account_id', _target, 'description', 'Merged from ' || _scode, 'debit_minor', 0, 'credit_minor', -_locked_net)) END
    ));
    _jids := _jids || _jid;
  END IF;

  UPDATE public.accounts SET parent_id = _target WHERE company_id = _company AND parent_id = _source;
  GET DIAGNOSTICS _children = ROW_COUNT;

  -- Archiving follows the normal archive rules. Income and expense accounts with activity in the current
  -- financial year cannot be archived (their posted lines stay), so the merge still succeeds: the balance has
  -- moved, the account is left active, and the reason is returned instead of failing the whole merge.
  BEGIN
    UPDATE public.accounts SET is_active = FALSE, archived_by = _uid WHERE id = _source AND company_id = _company;
    _archived := TRUE;
  EXCEPTION WHEN OTHERS THEN
    _archived := FALSE;
    _archive_error := left(SQLERRM, 300);
  END;

  PERFORM public.record_audit_event(_company, 'account.merged', 'account', _source,
    jsonb_build_object('target_id', _target, 'journals', cardinality(_jids),
                       'locked_periods_posted_today', _locked_net <> 0, 'children_moved', _children,
                       'archived', _archived, 'archive_blocked', _archive_error));

  RETURN jsonb_build_object('journal_ids', to_jsonb(_jids), 'journal_count', cardinality(_jids),
                            'locked_periods_posted_today', _locked_net <> 0,
                            'archived', _archived, 'archive_blocked_reason', _archive_error);
END;
$$;

REVOKE ALL ON FUNCTION public.merge_accounts_dated(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.merge_accounts_dated(JSONB) TO authenticated;
