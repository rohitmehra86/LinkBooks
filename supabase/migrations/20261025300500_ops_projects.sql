-- Projects: tag document lines and bank transactions with a project, and report profitability from the
-- posted figures. Tags are analytical only: they never touch post_journal or any ledger amount.
-- Additive and idempotent.

-- ---------------------------------------------------------------------------
-- 1. project_id on line tables and bank transactions
-- ---------------------------------------------------------------------------
ALTER TABLE public.sales_invoice_lines ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL;
ALTER TABLE public.sales_credit_note_lines ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL;
ALTER TABLE public.purchase_bill_lines ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL;
ALTER TABLE public.purchase_credit_note_lines ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL;
ALTER TABLE public.bank_transactions ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS sales_invoice_lines_project_idx ON public.sales_invoice_lines (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sales_credit_note_lines_project_idx ON public.sales_credit_note_lines (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS purchase_bill_lines_project_idx ON public.purchase_bill_lines (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS purchase_credit_note_lines_project_idx ON public.purchase_credit_note_lines (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bank_transactions_project_idx ON public.bank_transactions (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS money_documents_project_idx ON public.money_documents (project_id) WHERE project_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. set_document_project(payload)
--    company_id, kind (sales_invoice | sales_credit_note | purchase_bill | purchase_credit_note |
--    bank_transaction), document_id, project_id (null clears), [line_ids] (only those lines; documents only)
--    Allowed on posted documents too: a tag is analytical and does not change any amount.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_document_project(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _company UUID := NULLIF(payload->>'company_id', '')::UUID;
  _kind TEXT := payload->>'kind';
  _doc UUID := NULLIF(payload->>'document_id', '')::UUID;
  _project UUID := NULLIF(payload->>'project_id', '')::UUID;
  _line_ids UUID[];
  _perm TEXT;
  _status TEXT;
  _n INT := 0;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF _company IS NULL OR _doc IS NULL THEN RAISE EXCEPTION 'company_id and document_id are required'; END IF;
  IF NOT public.is_company_member(_company) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  _perm := CASE _kind
    WHEN 'sales_invoice' THEN 'sales.draft' WHEN 'sales_credit_note' THEN 'sales.draft'
    WHEN 'purchase_bill' THEN 'purchases.draft' WHEN 'purchase_credit_note' THEN 'purchases.draft'
    WHEN 'bank_transaction' THEN 'banking.categorise'
    ELSE NULL END;
  IF _perm IS NULL THEN RAISE EXCEPTION 'Unsupported document kind'; END IF;
  IF NOT (public.has_company_permission(_company, _perm) OR public.has_company_permission(_company, 'accounts.manage')) THEN
    RAISE EXCEPTION 'You do not have permission to tag this document';
  END IF;

  IF payload ? 'line_ids' AND jsonb_typeof(payload->'line_ids') = 'array' THEN
    SELECT array_agg(x::UUID) INTO _line_ids FROM jsonb_array_elements_text(payload->'line_ids') x;
  END IF;

  IF _project IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.projects p
    WHERE p.id = _project AND p.company_id = _company AND p.status NOT IN ('archived', 'completed')
  ) THEN
    RAISE EXCEPTION 'Project not found or no longer open';
  END IF;

  IF _kind = 'sales_invoice' THEN
    SELECT status::TEXT INTO _status FROM public.sales_invoices WHERE id = _doc AND company_id = _company FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Document not found'; END IF;
    IF _status = 'void' THEN RAISE EXCEPTION 'A void document cannot be tagged'; END IF;
    UPDATE public.sales_invoice_lines SET project_id = _project
    WHERE invoice_id = _doc AND company_id = _company AND (_line_ids IS NULL OR id = ANY(_line_ids));
    GET DIAGNOSTICS _n = ROW_COUNT;
  ELSIF _kind = 'sales_credit_note' THEN
    SELECT status::TEXT INTO _status FROM public.sales_credit_notes WHERE id = _doc AND company_id = _company FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Document not found'; END IF;
    IF _status = 'void' THEN RAISE EXCEPTION 'A void document cannot be tagged'; END IF;
    UPDATE public.sales_credit_note_lines SET project_id = _project
    WHERE credit_note_id = _doc AND company_id = _company AND (_line_ids IS NULL OR id = ANY(_line_ids));
    GET DIAGNOSTICS _n = ROW_COUNT;
  ELSIF _kind = 'purchase_bill' THEN
    SELECT status::TEXT INTO _status FROM public.purchase_bills WHERE id = _doc AND company_id = _company FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Document not found'; END IF;
    IF _status = 'void' THEN RAISE EXCEPTION 'A void document cannot be tagged'; END IF;
    UPDATE public.purchase_bill_lines SET project_id = _project
    WHERE bill_id = _doc AND company_id = _company AND (_line_ids IS NULL OR id = ANY(_line_ids));
    GET DIAGNOSTICS _n = ROW_COUNT;
  ELSIF _kind = 'purchase_credit_note' THEN
    SELECT status::TEXT INTO _status FROM public.purchase_credit_notes WHERE id = _doc AND company_id = _company FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Document not found'; END IF;
    IF _status = 'void' THEN RAISE EXCEPTION 'A void document cannot be tagged'; END IF;
    UPDATE public.purchase_credit_note_lines SET project_id = _project
    WHERE credit_note_id = _doc AND company_id = _company AND (_line_ids IS NULL OR id = ANY(_line_ids));
    GET DIAGNOSTICS _n = ROW_COUNT;
  ELSE
    PERFORM 1 FROM public.bank_transactions WHERE id = _doc AND company_id = _company FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Document not found'; END IF;
    UPDATE public.bank_transactions SET project_id = _project WHERE id = _doc AND company_id = _company;
    GET DIAGNOSTICS _n = ROW_COUNT;
  END IF;

  PERFORM public.record_audit_event(_company, 'project.tag', _kind, _doc,
    jsonb_build_object('project_id', _project, 'rows', _n, 'line_ids', _line_ids));
  RETURN jsonb_build_object('tagged', _n, 'project_id', _project);
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. project_profitability(company, from, to)
--    Revenue / cost in BASE currency from POSTED figures only:
--      invoice and credit-note lines tagged to the project (net of tax, converted at the document rate),
--      bill and supplier credit-note lines tagged to the project,
--      bank transactions tagged to the project: income/expense lines of their own posted journal,
--      Create-New money documents (cash sales, card payments, ...) tagged to the project.
--    Draft, awaiting-approval and void documents are excluded. Documents in a foreign currency with no usable
--    rate are counted in unconverted_documents instead of being guessed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ops_doc_rate(_company UUID, _ccy TEXT, _rate NUMERIC, _on DATE)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _base TEXT; _r NUMERIC;
BEGIN
  SELECT base_currency INTO _base FROM public.companies WHERE id = _company;
  IF upper(_ccy) = upper(_base) THEN RETURN 1; END IF;
  IF _rate IS NOT NULL AND _rate > 0 AND _rate <> 1 THEN RETURN _rate; END IF;
  BEGIN
    _r := public.lookup_fx_rate_to_base(_company, upper(_ccy), _on);
  EXCEPTION WHEN OTHERS THEN
    _r := NULL;
  END;
  RETURN _r;
END;
$$;
REVOKE ALL ON FUNCTION public.ops_doc_rate(UUID, TEXT, NUMERIC, DATE) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.project_profitability(_company_id UUID, _from DATE DEFAULT NULL, _to DATE DEFAULT NULL)
RETURNS TABLE (
  project_id UUID,
  code TEXT,
  name TEXT,
  status TEXT,
  budget_minor BIGINT,
  revenue_minor BIGINT,
  cost_minor BIGINT,
  profit_minor BIGINT,
  unconverted_documents INT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT (public.has_company_permission(_company_id, 'reports.view')
          OR public.has_company_permission(_company_id, 'accounts.manage')) THEN
    RAISE EXCEPTION 'You do not have permission to view reports';
  END IF;

  RETURN QUERY
  WITH docs AS (
    -- (project, signed revenue, signed cost, unconverted flag), one row per tagged line / journal
    SELECT l.project_id AS pid,
           CASE WHEN r.rate IS NULL THEN 0 ELSE public.ops_minor_to_base(_company_id, l.net_minor, h.currency_code::TEXT, r.rate) END AS rev,
           0::BIGINT AS cost, (r.rate IS NULL) AS unrated, h.id AS doc
    FROM public.sales_invoice_lines l
    JOIN public.sales_invoices h ON h.id = l.invoice_id
    CROSS JOIN LATERAL (SELECT public.ops_doc_rate(_company_id, h.currency_code::TEXT, h.fx_rate_to_base, h.invoice_date) AS rate) r
    WHERE l.company_id = _company_id AND l.project_id IS NOT NULL
      AND h.status IN ('authorised', 'partly_paid', 'paid')
      AND (_from IS NULL OR h.invoice_date >= _from) AND (_to IS NULL OR h.invoice_date <= _to)
    UNION ALL
    SELECT l.project_id,
           CASE WHEN r.rate IS NULL THEN 0 ELSE -public.ops_minor_to_base(_company_id, l.net_minor, h.currency_code::TEXT, r.rate) END,
           0, (r.rate IS NULL), h.id
    FROM public.sales_credit_note_lines l
    JOIN public.sales_credit_notes h ON h.id = l.credit_note_id
    CROSS JOIN LATERAL (SELECT public.ops_doc_rate(_company_id, h.currency_code::TEXT, h.fx_rate_to_base, h.credit_date) AS rate) r
    WHERE l.company_id = _company_id AND l.project_id IS NOT NULL
      AND h.status IN ('authorised', 'partly_paid', 'paid')
      AND (_from IS NULL OR h.credit_date >= _from) AND (_to IS NULL OR h.credit_date <= _to)
    UNION ALL
    SELECT l.project_id, 0,
           CASE WHEN r.rate IS NULL THEN 0 ELSE public.ops_minor_to_base(_company_id, l.net_minor, h.currency_code::TEXT, r.rate) END,
           (r.rate IS NULL), h.id
    FROM public.purchase_bill_lines l
    JOIN public.purchase_bills h ON h.id = l.bill_id
    CROSS JOIN LATERAL (SELECT public.ops_doc_rate(_company_id, h.currency_code::TEXT, h.fx_rate_to_base, h.bill_date) AS rate) r
    WHERE l.company_id = _company_id AND l.project_id IS NOT NULL
      AND h.status IN ('authorised', 'partly_paid', 'paid')
      AND (_from IS NULL OR h.bill_date >= _from) AND (_to IS NULL OR h.bill_date <= _to)
    UNION ALL
    SELECT l.project_id, 0,
           CASE WHEN r.rate IS NULL THEN 0 ELSE -public.ops_minor_to_base(_company_id, l.net_minor, h.currency_code::TEXT, r.rate) END,
           (r.rate IS NULL), h.id
    FROM public.purchase_credit_note_lines l
    JOIN public.purchase_credit_notes h ON h.id = l.credit_note_id
    CROSS JOIN LATERAL (SELECT public.ops_doc_rate(_company_id, h.currency_code::TEXT, h.fx_rate_to_base, h.credit_date) AS rate) r
    WHERE l.company_id = _company_id AND l.project_id IS NOT NULL
      AND h.status IN ('authorised', 'partly_paid', 'paid')
      AND (_from IS NULL OR h.credit_date >= _from) AND (_to IS NULL OR h.credit_date <= _to)
    UNION ALL
    -- Journal-based: bank transactions and Create-New money documents (their own posted, un-reversed journal)
    SELECT t.project_id,
           CASE WHEN a.account_type = 'income' THEN jl.credit_minor - jl.debit_minor ELSE 0 END,
           CASE WHEN a.account_type = 'expense' THEN jl.debit_minor - jl.credit_minor ELSE 0 END,
           false, jl.journal_id
    FROM public.bank_transactions t
    JOIN public.reconciliation_links rl ON rl.bank_transaction_id = t.id
    JOIN public.journal_lines own ON own.id = rl.journal_line_id
    JOIN public.journals j ON j.id = own.journal_id
      AND j.status = 'posted' AND j.reversed_by_journal_id IS NULL AND j.source_type = 'bank_transaction'
    JOIN public.journal_lines jl ON jl.journal_id = j.id
    JOIN public.accounts a ON a.id = jl.account_id
    WHERE t.company_id = _company_id AND t.project_id IS NOT NULL
      AND a.account_type IN ('income', 'expense')
      AND (_from IS NULL OR j.journal_date >= _from) AND (_to IS NULL OR j.journal_date <= _to)
    UNION ALL
    SELECT m.project_id,
           CASE WHEN a.account_type = 'income' THEN jl.credit_minor - jl.debit_minor ELSE 0 END,
           CASE WHEN a.account_type = 'expense' THEN jl.debit_minor - jl.credit_minor ELSE 0 END,
           false, jl.journal_id
    FROM public.money_documents m
    JOIN public.journals j ON j.id = m.posted_journal_id
      AND j.status = 'posted' AND j.reversed_by_journal_id IS NULL
    JOIN public.journal_lines jl ON jl.journal_id = j.id
    JOIN public.accounts a ON a.id = jl.account_id
    WHERE m.company_id = _company_id AND m.project_id IS NOT NULL AND m.status = 'posted'
      AND a.account_type IN ('income', 'expense')
      AND (_from IS NULL OR j.journal_date >= _from) AND (_to IS NULL OR j.journal_date <= _to)
  ), agg AS (
    SELECT d.pid,
           COALESCE(SUM(d.rev), 0)::BIGINT AS revenue,
           COALESCE(SUM(d.cost), 0)::BIGINT AS cost,
           COUNT(DISTINCT d.doc) FILTER (WHERE d.unrated)::INT AS unrated_docs
    FROM docs d GROUP BY d.pid
  )
  SELECT p.id, p.code, p.name, p.status, p.budget_minor,
         COALESCE(g.revenue, 0)::BIGINT,
         COALESCE(g.cost, 0)::BIGINT,
         (COALESCE(g.revenue, 0) - COALESCE(g.cost, 0))::BIGINT,
         COALESCE(g.unrated_docs, 0)
  FROM public.projects p
  LEFT JOIN agg g ON g.pid = p.id
  WHERE p.company_id = _company_id
  ORDER BY p.code;
END;
$$;

REVOKE ALL ON FUNCTION public.set_document_project(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.project_profitability(UUID, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_document_project(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.project_profitability(UUID, DATE, DATE) TO authenticated;
