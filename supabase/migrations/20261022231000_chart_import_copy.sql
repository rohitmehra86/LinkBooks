-- Transactional chart import and firm copy. Permission is checked inside the function.

CREATE OR REPLACE FUNCTION public.import_chart_accounts(_company_id uuid, _rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  row jsonb;
  parent uuid;
  imported integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in required';
  END IF;
  IF NOT public.has_company_permission(_company_id, 'accounts.manage') THEN
    RAISE EXCEPTION 'You do not have permission to manage accounts';
  END IF;
  IF jsonb_typeof(_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(_rows) = 0 THEN
    RAISE EXCEPTION 'Import needs at least one account';
  END IF;
  IF jsonb_array_length(_rows) > 500 THEN
    RAISE EXCEPTION 'Import is limited to 500 accounts at a time';
  END IF;

  FOR row IN SELECT value FROM jsonb_array_elements(_rows) LOOP
    INSERT INTO public.accounts (
      company_id, code, name, account_kind, description, detail_type, is_header,
      currency_code, source, is_system, is_postable, is_control, is_active
    ) VALUES (
      _company_id,
      btrim(row->>'code'),
      btrim(row->>'name'),
      row->>'account_kind',
      NULLIF(btrim(COALESCE(row->>'description', '')), ''),
      NULLIF(btrim(COALESCE(row->>'detail_type', '')), ''),
      COALESCE((row->>'is_header')::boolean, false),
      NULLIF(btrim(COALESCE(row->>'currency_code', '')), ''),
      'import',
      false,
      NOT COALESCE((row->>'is_header')::boolean, false),
      false,
      true
    );
    imported := imported + 1;
  END LOOP;

  FOR row IN SELECT value FROM jsonb_array_elements(_rows) LOOP
    IF NULLIF(btrim(COALESCE(row->>'parent_code', '')), '') IS NOT NULL THEN
      SELECT id INTO parent FROM public.accounts
      WHERE company_id = _company_id AND code = btrim(row->>'parent_code');
      IF parent IS NULL THEN
        RAISE EXCEPTION 'Parent code % was not found', btrim(row->>'parent_code');
      END IF;
      UPDATE public.accounts
      SET parent_id = parent
      WHERE company_id = _company_id AND code = btrim(row->>'code');
    END IF;
  END LOOP;

  RETURN jsonb_build_object('imported', imported);
END;
$$;

REVOKE ALL ON FUNCTION public.import_chart_accounts(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.import_chart_accounts(uuid, jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.copy_chart_accounts(_source uuid, _target uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  copied integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in required';
  END IF;
  IF _source = _target THEN
    RAISE EXCEPTION 'Choose a different organisation to copy from';
  END IF;
  IF NOT public.has_company_permission(_source, 'accounts.manage')
     OR NOT public.has_company_permission(_target, 'accounts.manage') THEN
    RAISE EXCEPTION 'You need account access in both organisations';
  END IF;

  INSERT INTO public.accounts (
    company_id, code, name, account_kind, description, detail_type, is_header,
    currency_code, source, is_system, is_postable, is_control, is_active, sort_order
  )
  SELECT
    _target, s.code, s.name, s.account_kind, s.description, s.detail_type, s.is_header,
    s.currency_code, 'copy', false, s.is_postable, false, s.is_active, s.sort_order
  FROM public.accounts s
  WHERE s.company_id = _source
    AND s.is_system = false
    AND s.is_control = false
    AND NOT EXISTS (
      SELECT 1 FROM public.accounts t
      WHERE t.company_id = _target AND (t.code = s.code OR lower(t.name) = lower(s.name))
    );
  GET DIAGNOSTICS copied = ROW_COUNT;

  UPDATE public.accounts child
  SET parent_id = target_parent.id
  FROM public.accounts source_child
  JOIN public.accounts source_parent ON source_parent.id = source_child.parent_id
  JOIN public.accounts target_parent
    ON target_parent.company_id = _target AND target_parent.code = source_parent.code
  WHERE child.company_id = _target
    AND child.code = source_child.code
    AND source_child.company_id = _source
    AND child.parent_id IS NULL;

  RETURN jsonb_build_object('copied', copied);
END;
$$;

REVOKE ALL ON FUNCTION public.copy_chart_accounts(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.copy_chart_accounts(uuid, uuid) TO authenticated;
