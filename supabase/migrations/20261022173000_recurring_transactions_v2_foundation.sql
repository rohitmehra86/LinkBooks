-- Recurring Transactions Engine V2 — Stage 1 foundation
-- Non-destructive: legacy recurring_bills / sales_recurring_invoices remain.

DO $$ BEGIN
  CREATE TYPE public.recurring_document_type AS ENUM (
    'purchase_bill',
    'sales_invoice'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.recurring_template_mode AS ENUM (
    'scheduled',
    'reminder',
    'on_demand'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.recurring_occurrence_status AS ENUM (
    'pending',
    'processing',
    'completed',
    'failed',
    'skipped',
    'needs_input'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.recurring_catch_up_policy AS ENUM (
    'all_missed',
    'latest_only',
    'review_each'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Templates & immutable versions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.recurring_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  document_type public.recurring_document_type NOT NULL,
  name TEXT NOT NULL,
  contact_id UUID REFERENCES public.contacts(id) ON DELETE RESTRICT,
  currency_code CHAR(3) NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  archived_at TIMESTAMPTZ,
  legacy_recurring_bill_id UUID UNIQUE REFERENCES public.recurring_bills(id) ON DELETE SET NULL,
  legacy_sales_recurring_invoice_id UUID UNIQUE REFERENCES public.sales_recurring_invoices(id) ON DELETE SET NULL,
  current_version_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT recurring_templates_legacy_one CHECK (
    (legacy_recurring_bill_id IS NOT NULL)::int + (legacy_sales_recurring_invoice_id IS NOT NULL)::int <= 1
  )
);

CREATE INDEX IF NOT EXISTS recurring_templates_company_active_idx
  ON public.recurring_templates (company_id, is_active)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS public.recurring_template_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  template_id UUID NOT NULL REFERENCES public.recurring_templates(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (template_id, version_no)
);

ALTER TABLE public.recurring_templates
  DROP CONSTRAINT IF EXISTS recurring_templates_current_version_fk;
ALTER TABLE public.recurring_templates
  ADD CONSTRAINT recurring_templates_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES public.recurring_template_versions(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Schedules (one per template in v1)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.recurring_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  template_id UUID NOT NULL UNIQUE REFERENCES public.recurring_templates(id) ON DELETE CASCADE,
  mode public.recurring_template_mode NOT NULL DEFAULT 'scheduled',
  frequency_legacy public.recurrence_frequency,
  rrule TEXT NOT NULL,
  dtstart DATE NOT NULL,
  time_zone TEXT NOT NULL DEFAULT 'UTC',
  next_occurrence_date DATE NOT NULL,
  generate_days_in_advance INTEGER NOT NULL DEFAULT 0 CHECK (generate_days_in_advance >= 0 AND generate_days_in_advance <= 365),
  end_date DATE,
  max_occurrences INTEGER CHECK (max_occurrences IS NULL OR max_occurrences > 0),
  occurrence_count INTEGER NOT NULL DEFAULT 0 CHECK (occurrence_count >= 0),
  catch_up_policy public.recurring_catch_up_policy NOT NULL DEFAULT 'latest_only',
  auto_authorise BOOLEAN NOT NULL DEFAULT false,
  is_paused BOOLEAN NOT NULL DEFAULT false,
  last_generated_on DATE,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recurring_schedules_due_idx
  ON public.recurring_schedules (company_id, next_occurrence_date)
  WHERE is_paused = false AND mode = 'scheduled';

-- ---------------------------------------------------------------------------
-- Materialised occurrences (idempotent generation)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.recurring_occurrences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  schedule_id UUID NOT NULL REFERENCES public.recurring_schedules(id) ON DELETE CASCADE,
  occurrence_key TEXT NOT NULL,
  scheduled_date DATE NOT NULL,
  document_date DATE NOT NULL,
  status public.recurring_occurrence_status NOT NULL DEFAULT 'pending',
  template_version_id UUID REFERENCES public.recurring_template_versions(id) ON DELETE SET NULL,
  purchase_bill_id UUID REFERENCES public.purchase_bills(id) ON DELETE SET NULL,
  sales_invoice_id UUID REFERENCES public.sales_invoices(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL,
  error_message TEXT,
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, schedule_id, occurrence_key),
  UNIQUE (company_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS recurring_occurrences_schedule_idx
  ON public.recurring_occurrences (schedule_id, scheduled_date DESC);

-- ---------------------------------------------------------------------------
-- Generation runs (audit / ops)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.recurring_generation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES public.companies(id) ON DELETE SET NULL,
  trigger_source TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  outcome TEXT,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.recurring_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recurring_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recurring_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recurring_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recurring_generation_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS recurring_templates_select ON public.recurring_templates;
CREATE POLICY recurring_templates_select ON public.recurring_templates FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

DROP POLICY IF EXISTS recurring_templates_write ON public.recurring_templates;
CREATE POLICY recurring_templates_write ON public.recurring_templates FOR ALL TO authenticated
  USING (
    public.has_company_permission(company_id, 'purchases.draft')
    OR public.has_company_permission(company_id, 'sales.draft')
  )
  WITH CHECK (
    public.has_company_permission(company_id, 'purchases.draft')
    OR public.has_company_permission(company_id, 'sales.draft')
  );

DROP POLICY IF EXISTS recurring_template_versions_select ON public.recurring_template_versions;
CREATE POLICY recurring_template_versions_select ON public.recurring_template_versions FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

DROP POLICY IF EXISTS recurring_template_versions_write ON public.recurring_template_versions;
CREATE POLICY recurring_template_versions_write ON public.recurring_template_versions FOR ALL TO authenticated
  USING (
    public.has_company_permission(company_id, 'purchases.draft')
    OR public.has_company_permission(company_id, 'sales.draft')
  )
  WITH CHECK (
    public.has_company_permission(company_id, 'purchases.draft')
    OR public.has_company_permission(company_id, 'sales.draft')
  );

DROP POLICY IF EXISTS recurring_schedules_select ON public.recurring_schedules;
CREATE POLICY recurring_schedules_select ON public.recurring_schedules FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

DROP POLICY IF EXISTS recurring_schedules_write ON public.recurring_schedules;
CREATE POLICY recurring_schedules_write ON public.recurring_schedules FOR ALL TO authenticated
  USING (
    public.has_company_permission(company_id, 'purchases.draft')
    OR public.has_company_permission(company_id, 'sales.draft')
  )
  WITH CHECK (
    public.has_company_permission(company_id, 'purchases.draft')
    OR public.has_company_permission(company_id, 'sales.draft')
  );

DROP POLICY IF EXISTS recurring_occurrences_select ON public.recurring_occurrences;
CREATE POLICY recurring_occurrences_select ON public.recurring_occurrences FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

DROP POLICY IF EXISTS recurring_occurrences_write ON public.recurring_occurrences;
CREATE POLICY recurring_occurrences_write ON public.recurring_occurrences FOR ALL TO authenticated
  USING (
    public.has_company_permission(company_id, 'purchases.draft')
    OR public.has_company_permission(company_id, 'sales.draft')
  )
  WITH CHECK (
    public.has_company_permission(company_id, 'purchases.draft')
    OR public.has_company_permission(company_id, 'sales.draft')
  );

DROP POLICY IF EXISTS recurring_generation_runs_select ON public.recurring_generation_runs;
CREATE POLICY recurring_generation_runs_select ON public.recurring_generation_runs FOR SELECT TO authenticated
  USING (company_id IS NULL OR public.is_company_member(company_id));

-- ---------------------------------------------------------------------------
-- Claim occurrence (concurrency-safe) — SECURITY DEFINER
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recurring_claim_occurrence(
  _company_id UUID,
  _schedule_id UUID,
  _scheduled_date DATE,
  _document_date DATE,
  _template_version_id UUID,
  _idempotency_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _occ public.recurring_occurrences%ROWTYPE;
  _key TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'Not a company member';
  END IF;

  _key := _schedule_id::text || ':' || _scheduled_date::text;

  INSERT INTO public.recurring_occurrences (
    company_id, schedule_id, occurrence_key, scheduled_date, document_date,
    status, template_version_id, idempotency_key, claimed_at
  ) VALUES (
    _company_id, _schedule_id, _key, _scheduled_date, _document_date,
    'processing', _template_version_id, _idempotency_key, now()
  )
  ON CONFLICT (company_id, schedule_id, occurrence_key) DO NOTHING
  RETURNING * INTO _occ;

  IF _occ.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'action', 'claimed',
      'occurrence_id', _occ.id,
      'status', _occ.status
    );
  END IF;

  SELECT * INTO _occ
  FROM public.recurring_occurrences
  WHERE company_id = _company_id
    AND schedule_id = _schedule_id
    AND occurrence_key = _key;

  IF _occ.status = 'completed' THEN
    RETURN jsonb_build_object(
      'action', 'already_completed',
      'occurrence_id', _occ.id,
      'purchase_bill_id', _occ.purchase_bill_id,
      'sales_invoice_id', _occ.sales_invoice_id
    );
  END IF;

  IF _occ.status = 'processing' AND _occ.claimed_at > now() - interval '15 minutes' THEN
    RETURN jsonb_build_object(
      'action', 'in_progress',
      'occurrence_id', _occ.id
    );
  END IF;

  UPDATE public.recurring_occurrences
  SET status = 'processing',
      claimed_at = now(),
      template_version_id = COALESCE(_template_version_id, template_version_id),
      error_message = NULL,
      updated_at = now()
  WHERE id = _occ.id
    AND status IN ('pending', 'failed', 'processing')
  RETURNING * INTO _occ;

  IF _occ.id IS NULL THEN
    SELECT * INTO _occ FROM public.recurring_occurrences
    WHERE company_id = _company_id AND schedule_id = _schedule_id AND occurrence_key = _key;
    RETURN jsonb_build_object(
      'action', 'already_completed',
      'occurrence_id', _occ.id,
      'purchase_bill_id', _occ.purchase_bill_id,
      'sales_invoice_id', _occ.sales_invoice_id
    );
  END IF;

  RETURN jsonb_build_object(
    'action', 'claimed',
    'occurrence_id', _occ.id,
    'status', _occ.status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.recurring_claim_occurrence FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recurring_claim_occurrence TO authenticated;

CREATE OR REPLACE FUNCTION public.recurring_complete_occurrence(
  _occurrence_id UUID,
  _purchase_bill_id UUID DEFAULT NULL,
  _sales_invoice_id UUID DEFAULT NULL,
  _failed_message TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _occ public.recurring_occurrences%ROWTYPE;
BEGIN
  SELECT * INTO _occ FROM public.recurring_occurrences WHERE id = _occurrence_id;
  IF _occ.id IS NULL THEN
    RAISE EXCEPTION 'Occurrence not found';
  END IF;
  IF auth.uid() IS NOT NULL AND NOT public.is_company_member(_occ.company_id) THEN
    RAISE EXCEPTION 'Not a company member';
  END IF;

  IF _failed_message IS NOT NULL THEN
    UPDATE public.recurring_occurrences
    SET status = 'failed',
        error_message = left(_failed_message, 2000),
        updated_at = now()
    WHERE id = _occurrence_id;
    RETURN;
  END IF;

  UPDATE public.recurring_occurrences
  SET status = 'completed',
      purchase_bill_id = COALESCE(_purchase_bill_id, purchase_bill_id),
      sales_invoice_id = COALESCE(_sales_invoice_id, sales_invoice_id),
      completed_at = now(),
      error_message = NULL,
      updated_at = now()
  WHERE id = _occurrence_id;
END;
$$;

REVOKE ALL ON FUNCTION public.recurring_complete_occurrence FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recurring_complete_occurrence TO authenticated;

-- ---------------------------------------------------------------------------
-- Backfill legacy recurring bills → v2
-- ---------------------------------------------------------------------------
INSERT INTO public.recurring_templates (
  company_id, document_type, name, contact_id, currency_code, owner_user_id,
  is_active, legacy_recurring_bill_id, created_at, updated_at
)
SELECT
  rb.company_id,
  'purchase_bill'::public.recurring_document_type,
  rb.name,
  rb.contact_id,
  rb.currency_code,
  rb.created_by,
  rb.is_active,
  rb.id,
  rb.created_at,
  rb.updated_at
FROM public.recurring_bills rb
WHERE NOT EXISTS (
  SELECT 1 FROM public.recurring_templates t WHERE t.legacy_recurring_bill_id = rb.id
);

INSERT INTO public.recurring_template_versions (
  company_id, template_id, version_no, payload, created_by, created_at
)
SELECT
  t.company_id,
  t.id,
  1,
  jsonb_build_object(
    'source', 'legacy_recurring_bill',
    'legacy_id', rb.id,
    'template', rb.template,
    'auto_authorise', rb.auto_authorise
  ),
  rb.created_by,
  rb.created_at
FROM public.recurring_templates t
JOIN public.recurring_bills rb ON rb.id = t.legacy_recurring_bill_id
WHERE NOT EXISTS (
  SELECT 1 FROM public.recurring_template_versions v WHERE v.template_id = t.id AND v.version_no = 1
);

UPDATE public.recurring_templates t
SET current_version_id = v.id
FROM public.recurring_template_versions v
WHERE v.template_id = t.id AND v.version_no = 1 AND t.current_version_id IS NULL;

INSERT INTO public.recurring_schedules (
  company_id, template_id, mode, frequency_legacy, rrule, dtstart, time_zone,
  next_occurrence_date, auto_authorise, is_paused, last_generated_on, last_error,
  created_at, updated_at
)
SELECT
  t.company_id,
  t.id,
  'scheduled'::public.recurring_template_mode,
  rb.frequency,
  CASE rb.frequency
    WHEN 'weekly' THEN 'FREQ=WEEKLY'
    WHEN 'monthly' THEN 'FREQ=MONTHLY'
    WHEN 'quarterly' THEN 'FREQ=MONTHLY;INTERVAL=3'
    WHEN 'yearly' THEN 'FREQ=YEARLY'
    ELSE 'FREQ=MONTHLY'
  END,
  rb.next_due_date,
  'UTC',
  rb.next_due_date,
  rb.auto_authorise,
  NOT rb.is_active,
  rb.last_generated_on,
  rb.last_error,
  rb.created_at,
  rb.updated_at
FROM public.recurring_templates t
JOIN public.recurring_bills rb ON rb.id = t.legacy_recurring_bill_id
WHERE NOT EXISTS (
  SELECT 1 FROM public.recurring_schedules s WHERE s.template_id = t.id
);

-- Backfill sales recurring invoices
INSERT INTO public.recurring_templates (
  company_id, document_type, name, contact_id, currency_code, owner_user_id,
  is_active, legacy_sales_recurring_invoice_id, created_at, updated_at
)
SELECT
  ri.company_id,
  'sales_invoice'::public.recurring_document_type,
  ri.name,
  ri.contact_id,
  ri.currency_code,
  ri.created_by,
  ri.is_active,
  ri.id,
  ri.created_at,
  ri.updated_at
FROM public.sales_recurring_invoices ri
WHERE NOT EXISTS (
  SELECT 1 FROM public.recurring_templates t WHERE t.legacy_sales_recurring_invoice_id = ri.id
);

INSERT INTO public.recurring_template_versions (
  company_id, template_id, version_no, payload, created_by, created_at
)
SELECT
  t.company_id,
  t.id,
  1,
  jsonb_build_object(
    'source', 'legacy_sales_recurring_invoice',
    'legacy_id', ri.id,
    'memo', ri.memo,
    'auto_authorise', ri.auto_authorise,
    'lines', COALESCE(
      (
        SELECT jsonb_agg(jsonb_build_object(
          'description', l.description,
          'account_id', l.account_id,
          'quantity', l.quantity,
          'unit_price_minor', l.unit_price_minor,
          'discount_minor', l.discount_minor,
          'tax_rate_bps', l.tax_rate_bps
        ) ORDER BY l.line_order)
        FROM public.sales_recurring_invoice_lines l
        WHERE l.recurring_id = ri.id
      ),
      '[]'::jsonb
    )
  ),
  ri.created_by,
  ri.created_at
FROM public.recurring_templates t
JOIN public.sales_recurring_invoices ri ON ri.id = t.legacy_sales_recurring_invoice_id
WHERE NOT EXISTS (
  SELECT 1 FROM public.recurring_template_versions v WHERE v.template_id = t.id AND v.version_no = 1
);

UPDATE public.recurring_templates t
SET current_version_id = v.id
FROM public.recurring_template_versions v
WHERE v.template_id = t.id AND v.version_no = 1
  AND t.legacy_sales_recurring_invoice_id IS NOT NULL
  AND t.current_version_id IS NULL;

INSERT INTO public.recurring_schedules (
  company_id, template_id, mode, frequency_legacy, rrule, dtstart, time_zone,
  next_occurrence_date, auto_authorise, is_paused, last_generated_on, last_error,
  created_at, updated_at
)
SELECT
  t.company_id,
  t.id,
  'scheduled'::public.recurring_template_mode,
  ri.frequency,
  CASE ri.frequency
    WHEN 'weekly' THEN 'FREQ=WEEKLY'
    WHEN 'monthly' THEN 'FREQ=MONTHLY'
    WHEN 'quarterly' THEN 'FREQ=MONTHLY;INTERVAL=3'
    WHEN 'yearly' THEN 'FREQ=YEARLY'
    ELSE 'FREQ=MONTHLY'
  END,
  ri.next_due_date,
  'UTC',
  ri.next_due_date,
  ri.auto_authorise,
  NOT ri.is_active,
  ri.last_generated_on,
  ri.last_error,
  ri.created_at,
  ri.updated_at
FROM public.recurring_templates t
JOIN public.sales_recurring_invoices ri ON ri.id = t.legacy_sales_recurring_invoice_id
WHERE NOT EXISTS (
  SELECT 1 FROM public.recurring_schedules s WHERE s.template_id = t.id
);
