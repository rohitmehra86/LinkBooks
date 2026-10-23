-- Workstream A (C-01): merge two contacts in ONE transaction across every table that
-- references public.contacts(id).
-- The table list is discovered from foreign keys (pg_constraint), so tables added later
-- (supplier_payments, money_documents, recurring templates, projects, ...) are covered
-- without code changes. Posted journals do not reference contacts and are never touched.
-- Link tables with a uniqueness rule (group members, tag assignments) drop the merged
-- contact's duplicate rows instead of failing the merge.

CREATE OR REPLACE FUNCTION public.merge_contacts(
  _company_id UUID,
  _survivor_id UUID,
  _merge_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _fk RECORD;
  _moved BIGINT;
  _dropped BIGINT;
  _total_moved BIGINT := 0;
  _per_table JSONB := '{}'::JSONB;
  _merge_name TEXT;
  _survivor_name TEXT;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF NOT public.has_company_permission(_company_id, 'contacts.manage') THEN
    RAISE EXCEPTION 'You do not have permission to merge contacts';
  END IF;
  IF _survivor_id = _merge_id THEN
    RAISE EXCEPTION 'Cannot merge a contact into itself';
  END IF;

  SELECT name INTO _survivor_name FROM public.contacts
  WHERE id = _survivor_id AND company_id = _company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Survivor contact not found in this organisation'; END IF;

  SELECT name INTO _merge_name FROM public.contacts
  WHERE id = _merge_id AND company_id = _company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Contact to merge not found in this organisation'; END IF;

  FOR _fk IN
    SELECT cl.relname AS table_name, att.attname AS column_name,
           EXISTS (
             SELECT 1 FROM pg_attribute ca
             WHERE ca.attrelid = cl.oid AND ca.attname = 'company_id' AND NOT ca.attisdropped
           ) AS has_company
    FROM pg_constraint con
    JOIN pg_class cl ON cl.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = cl.relnamespace
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
    WHERE con.contype = 'f'
      AND con.confrelid = 'public.contacts'::regclass
      AND array_length(con.conkey, 1) = 1
      AND ns.nspname = 'public'
      AND cl.relname <> 'contacts'
      AND cl.relkind = 'r'
    ORDER BY cl.relname, att.attname
  LOOP
    -- Only touch tables we can scope to this company.
    IF NOT _fk.has_company THEN CONTINUE; END IF;

    BEGIN
      EXECUTE format(
        'UPDATE public.%I SET %I = $1 WHERE company_id = $2 AND %I = $3',
        _fk.table_name, _fk.column_name, _fk.column_name
      ) USING _survivor_id, _company_id, _merge_id;
      GET DIAGNOSTICS _moved = ROW_COUNT;
    EXCEPTION WHEN unique_violation THEN
      -- Link table where the survivor already has the same link: keep the survivor's.
      IF _fk.table_name IN ('contact_group_members', 'contact_tag_assignments') THEN
        EXECUTE format(
          'DELETE FROM public.%I t WHERE t.company_id = $1 AND t.%I = $2 '
          'AND EXISTS (SELECT 1 FROM public.%I s WHERE s.company_id = $1 AND s.%I = $3 '
          'AND to_jsonb(s) - ''id'' - ''%s'' - ''created_at'' = to_jsonb(t) - ''id'' - ''%s'' - ''created_at'')',
          _fk.table_name, _fk.column_name, _fk.table_name, _fk.column_name,
          _fk.column_name, _fk.column_name
        ) USING _company_id, _merge_id, _survivor_id;
        GET DIAGNOSTICS _dropped = ROW_COUNT;
        EXECUTE format(
          'UPDATE public.%I SET %I = $1 WHERE company_id = $2 AND %I = $3',
          _fk.table_name, _fk.column_name, _fk.column_name
        ) USING _survivor_id, _company_id, _merge_id;
        GET DIAGNOSTICS _moved = ROW_COUNT;
      ELSE
        RAISE;
      END IF;
    END;

    IF _moved > 0 THEN
      _total_moved := _total_moved + _moved;
      _per_table := _per_table || jsonb_build_object(_fk.table_name || '.' || _fk.column_name, _moved);
    END IF;
  END LOOP;

  -- Archive the merged contact; APPEND to its notes rather than overwriting them.
  UPDATE public.contacts
  SET is_active = false,
      archived_at = now(),
      notes = NULLIF(
        trim(both E'\n' from COALESCE(notes, '') || E'\n' ||
          format('Merged into "%s" (%s) on %s', _survivor_name, _survivor_id, to_char(now(), 'YYYY-MM-DD'))),
        ''
      ),
      updated_at = now()
  WHERE id = _merge_id AND company_id = _company_id;

  UPDATE public.contacts
  SET notes = NULLIF(
        trim(both E'\n' from COALESCE(notes, '') || E'\n' ||
          format('Absorbed "%s" (%s) on %s', _merge_name, _merge_id, to_char(now(), 'YYYY-MM-DD'))),
        ''
      ),
      updated_at = now()
  WHERE id = _survivor_id AND company_id = _company_id;

  RETURN jsonb_build_object(
    'survivor_id', _survivor_id,
    'merged_id', _merge_id,
    'rows_moved', _total_moved,
    'by_table', _per_table
  );
END;
$$;

REVOKE ALL ON FUNCTION public.merge_contacts(UUID, UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.merge_contacts(UUID, UUID, UUID) TO authenticated;
