-- Workstream B (Sales / AR): reversal with an explicit date.
--
-- public.reverse_journal always reverses at the ORIGINAL journal date, so voiding a document
-- from a locked/closed period is rejected. reverse_journal_on lets the caller choose the
-- reversal date. The date must not be before the original journal date; post_journal itself
-- enforces that the date falls in an OPEN period and is not behind a lock date.
--
-- The old reverse_journal(uuid, text) signature is untouched.
-- Additive and idempotent. Never edits posted journals (post_journal marks the original as reversed).

CREATE OR REPLACE FUNCTION public.reverse_journal_on(
  _journal_id UUID,
  _reversal_date DATE,
  _idempotency_key TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  j RECORD;
  payload JSONB;
  lines JSONB := '[]'::jsonb;
  ln RECORD;
  new_id UUID;
  idem TEXT;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF _reversal_date IS NULL THEN RAISE EXCEPTION 'A reversal date is required'; END IF;

  SELECT * INTO j FROM public.journals WHERE id = _journal_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Journal not found'; END IF;
  IF NOT public.is_company_member(j.company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT (
    public.has_company_permission(j.company_id, 'accounting.post')
    OR public.has_company_permission(j.company_id, 'journals.manual')
  ) THEN
    RAISE EXCEPTION 'You do not have permission to reverse journals';
  END IF;
  IF j.status <> 'posted' THEN RAISE EXCEPTION 'Only posted journals can be reversed'; END IF;

  idem := COALESCE(NULLIF(trim(_idempotency_key), ''), 'reversal:' || j.id::TEXT);

  -- Idempotent retry: an earlier call with the same key already produced the reversal.
  IF j.reversed_by_journal_id IS NOT NULL THEN
    SELECT id INTO new_id FROM public.journals
    WHERE company_id = j.company_id AND idempotency_key = idem;
    IF new_id IS NOT NULL THEN RETURN new_id; END IF;
    RAISE EXCEPTION 'Journal already reversed';
  END IF;

  IF _reversal_date < j.journal_date THEN
    RAISE EXCEPTION 'Reversal date % cannot be before the original journal date %', _reversal_date, j.journal_date;
  END IF;

  FOR ln IN
    SELECT account_id, description, debit_minor, credit_minor
    FROM public.journal_lines WHERE journal_id = j.id ORDER BY line_no
  LOOP
    lines := lines || jsonb_build_array(jsonb_build_object(
      'account_id', ln.account_id,
      'description', COALESCE(ln.description, 'Reversal'),
      'debit_minor', ln.credit_minor,
      'credit_minor', ln.debit_minor
    ));
  END LOOP;

  payload := jsonb_build_object(
    'company_id', j.company_id,
    'journal_date', _reversal_date,
    'memo', 'Reversal of journal #' || j.journal_number,
    'currency_code', j.currency_code,
    'fx_rate_to_base', j.fx_rate_to_base,
    'source_type', 'reversal',
    'source_id', j.id,
    'idempotency_key', idem,
    'reverses_journal_id', j.id,
    'lines', lines
  );

  new_id := public.post_journal(payload);
  RETURN new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reverse_journal_on(UUID, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_journal_on(UUID, DATE, TEXT) TO authenticated;
