-- Wave 2 H (ops) — recurring manual journals: scheduler-able due-processing RPCs.
--
--   run_due_recurring_journals(payload)       user-triggered ("Run due now") for one company
--   post_recurring_journal_now(payload)       post the next occurrence of one template immediately
--   process_all_due_recurring_journals(date)  system entry for a scheduler (pg_cron / HTTP cron);
--                                             service_role / postgres only, acts as each template's creator
--
-- Every occurrence is ONE post_journal call (single posting engine) keyed on template + occurrence date,
-- so a double run or a retry never posts twice. Honours interval_months, end_date and max_occurrences.
-- Additive and idempotent.

ALTER TABLE public.recurring_journal_templates
  ADD COLUMN IF NOT EXISTS last_run_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS memo TEXT;

-- Internal worker. Posts due occurrences of ONE template as the current auth.uid().
-- Returns {posted, last_date, error}. Stops at the first failing occurrence (e.g. locked period).
CREATE OR REPLACE FUNCTION public.ops_run_recurring_journal(
  _template_id UUID, _as_of DATE, _max INT, _ignore_date BOOLEAN DEFAULT FALSE
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _t RECORD;
  _posted INT := 0;
  _count INT;
  _journal UUID;
  _lines JSONB;
  _next DATE;
  _err TEXT := NULL;
  _last DATE := NULL;
  _months INT;
  _iter INT := 0;
BEGIN
  SELECT * INTO _t FROM public.recurring_journal_templates WHERE id = _template_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Recurring journal not found'; END IF;

  LOOP
    EXIT WHEN _iter >= _max;
    _iter := _iter + 1;
    EXIT WHEN NOT _t.is_active;
    EXIT WHEN _t.end_date IS NOT NULL AND _t.next_date > _t.end_date;
    SELECT count(*) INTO _count FROM public.recurring_journal_occurrences WHERE template_id = _t.id;
    EXIT WHEN _t.max_occurrences IS NOT NULL AND _count >= _t.max_occurrences;
    EXIT WHEN NOT _ignore_date AND _t.next_date > _as_of;

    BEGIN
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'account_id', l->>'accountId',
               'description', COALESCE(NULLIF(l->>'description', ''), _t.name),
               'debit_minor', COALESCE((l->>'debitMinor')::BIGINT, 0),
               'credit_minor', COALESCE((l->>'creditMinor')::BIGINT, 0))), '[]'::JSONB)
        INTO _lines
      FROM jsonb_array_elements(_t.lines) l;

      _journal := public.post_journal(jsonb_build_object(
        'company_id', _t.company_id,
        'journal_date', _t.next_date,
        'memo', COALESCE(_t.memo, _t.name),
        'source_type', 'manual',
        'source_id', _t.id,
        'idempotency_key', 'recurring_journal:' || _t.id::TEXT || ':' || _t.next_date::TEXT,
        'lines', _lines
      ));

      INSERT INTO public.recurring_journal_occurrences (company_id, template_id, occurrence_date, journal_id)
      VALUES (_t.company_id, _t.id, _t.next_date, _journal)
      ON CONFLICT (template_id, occurrence_date) DO NOTHING;

      _last := _t.next_date;
      _posted := _posted + 1;
      -- Drift-free: always computed from the start date (Jan 31 -> Feb 28 -> Mar 31).
      _months := (extract(year FROM _t.next_date)::INT - extract(year FROM _t.start_date)::INT) * 12
               + (extract(month FROM _t.next_date)::INT - extract(month FROM _t.start_date)::INT)
               + _t.interval_months;
      _next := (_t.start_date + (_months * INTERVAL '1 month'))::DATE;
      UPDATE public.recurring_journal_templates
      SET next_date = _next, last_run_at = now(), last_error = NULL, updated_at = now()
      WHERE id = _t.id;
      _t.next_date := _next;
    EXCEPTION WHEN OTHERS THEN
      _err := SQLERRM;
      UPDATE public.recurring_journal_templates
      SET last_run_at = now(), last_error = left(_err, 500), updated_at = now()
      WHERE id = _t.id;
      EXIT;
    END;
  END LOOP;

  -- Finished schedules switch themselves off.
  SELECT count(*) INTO _count FROM public.recurring_journal_occurrences WHERE template_id = _t.id;
  IF _t.is_active AND (
       (_t.end_date IS NOT NULL AND _t.next_date > _t.end_date)
    OR (_t.max_occurrences IS NOT NULL AND _count >= _t.max_occurrences)
  ) THEN
    UPDATE public.recurring_journal_templates SET is_active = FALSE, updated_at = now() WHERE id = _t.id;
  END IF;

  RETURN jsonb_build_object('template_id', _t.id, 'posted', _posted, 'last_date', _last, 'error', _err);
END;
$$;

REVOKE ALL ON FUNCTION public.ops_run_recurring_journal(UUID, DATE, INT, BOOLEAN) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- run_due_recurring_journals(payload): company_id, [as_of_date], [max_per_template]
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.run_due_recurring_journals(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _company UUID := NULLIF(payload->>'company_id', '')::UUID;
  _as_of DATE := COALESCE(NULLIF(payload->>'as_of_date', '')::DATE, CURRENT_DATE);
  _max INT := LEAST(GREATEST(COALESCE(NULLIF(payload->>'max_per_template', '')::INT, 12), 1), 60);
  _tid UUID;
  _res JSONB;
  _results JSONB := '[]'::JSONB;
  _total INT := 0;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF _company IS NULL THEN RAISE EXCEPTION 'company_id is required'; END IF;
  IF NOT public.is_company_member(_company) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT public.has_company_permission(_company, 'journals.manual') THEN
    RAISE EXCEPTION 'You do not have permission to post recurring journals';
  END IF;
  IF NOT public.has_company_permission(_company, 'accounting.post') THEN
    RAISE EXCEPTION 'You do not have permission to post to the ledger';
  END IF;

  FOR _tid IN
    SELECT id FROM public.recurring_journal_templates
    WHERE company_id = _company AND is_active AND next_date <= _as_of
    ORDER BY next_date, id
  LOOP
    _res := public.ops_run_recurring_journal(_tid, _as_of, _max, FALSE);
    _total := _total + (_res->>'posted')::INT;
    _results := _results || jsonb_build_array(_res);
  END LOOP;
  RETURN jsonb_build_object('as_of', _as_of, 'posted', _total, 'templates', _results);
END;
$$;

-- ---------------------------------------------------------------------------
-- post_recurring_journal_now(payload): company_id, template_id
--   Posts the next scheduled occurrence immediately (even if it is in the future).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_recurring_journal_now(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _company UUID := NULLIF(payload->>'company_id', '')::UUID;
  _tid UUID := NULLIF(payload->>'template_id', '')::UUID;
  _res JSONB;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF _company IS NULL OR _tid IS NULL THEN RAISE EXCEPTION 'company_id and template_id are required'; END IF;
  IF NOT public.is_company_member(_company) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT (public.has_company_permission(_company, 'journals.manual')
          AND public.has_company_permission(_company, 'accounting.post')) THEN
    RAISE EXCEPTION 'You do not have permission to post recurring journals';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.recurring_journal_templates WHERE id = _tid AND company_id = _company) THEN
    RAISE EXCEPTION 'Recurring journal not found';
  END IF;
  _res := public.ops_run_recurring_journal(_tid, CURRENT_DATE, 1, TRUE);
  IF _res->>'error' IS NOT NULL THEN RAISE EXCEPTION '%', _res->>'error'; END IF;
  IF (_res->>'posted')::INT = 0 THEN
    RAISE EXCEPTION 'Nothing to post: this schedule is paused or has ended';
  END IF;
  RETURN _res;
END;
$$;

-- ---------------------------------------------------------------------------
-- process_all_due_recurring_journals(as_of): scheduler entry (all companies).
--   Acts as each template's creator (their membership and permissions are re-checked every run),
--   so the ledger audit trail still names a real user. Not callable by clients.
--
--   Supabase pg_cron example (enable the extension first, then run once):
--     select cron.schedule('recurring-journals', '15 2 * * *',
--                          $$select public.process_all_due_recurring_journals(current_date)$$);
--   Or call it from the app's cron endpoint (supabaseAdmin.rpc) — see docs/plans/WAVE2_H_OPS.md.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.process_all_due_recurring_journals(_as_of DATE DEFAULT CURRENT_DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _t RECORD;
  _res JSONB;
  _posted INT := 0;
  _failed INT := 0;
  _skipped INT := 0;
  _errors JSONB := '[]'::JSONB;
BEGIN
  FOR _t IN
    SELECT id, company_id, created_by FROM public.recurring_journal_templates
    WHERE is_active AND next_date <= _as_of
    ORDER BY company_id, next_date, id
    LIMIT 500
  LOOP
    PERFORM set_config('request.jwt.claim.sub', _t.created_by::TEXT, TRUE);
    PERFORM set_config('request.jwt.claims',
      jsonb_build_object('sub', _t.created_by, 'role', 'authenticated')::TEXT, TRUE);
    IF NOT (public.is_company_member(_t.company_id)
            AND public.has_company_permission(_t.company_id, 'journals.manual')
            AND public.has_company_permission(_t.company_id, 'accounting.post')) THEN
      _skipped := _skipped + 1;
      UPDATE public.recurring_journal_templates
      SET last_run_at = now(), last_error = 'The creator no longer has permission to post this journal. Re-save it from an authorised account.'
      WHERE id = _t.id;
      CONTINUE;
    END IF;
    _res := public.ops_run_recurring_journal(_t.id, _as_of, 12, FALSE);
    _posted := _posted + (_res->>'posted')::INT;
    IF _res->>'error' IS NOT NULL THEN
      _failed := _failed + 1;
      _errors := _errors || jsonb_build_array(jsonb_build_object('template_id', _t.id, 'message', _res->>'error'));
    END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claim.sub', '', TRUE);
  PERFORM set_config('request.jwt.claims', '', TRUE);
  RETURN jsonb_build_object('as_of', _as_of, 'posted', _posted, 'failed', _failed, 'skipped', _skipped, 'errors', _errors);
END;
$$;

REVOKE ALL ON FUNCTION public.run_due_recurring_journals(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.post_recurring_journal_now(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.process_all_due_recurring_journals(DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_due_recurring_journals(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.post_recurring_journal_now(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.process_all_due_recurring_journals(DATE) TO service_role;
