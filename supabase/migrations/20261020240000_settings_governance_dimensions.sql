-- Settings governance: reporting dimensions, document/line assignments, localisation.

-- ---------------------------------------------------------------------------
-- Extend tracking categories as first-class reporting dimensions
-- ---------------------------------------------------------------------------
ALTER TABLE public.tracking_categories
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS dimension_kind TEXT NOT NULL DEFAULT 'custom',
  ADD COLUMN IF NOT EXISTS applies_to TEXT[] NOT NULL DEFAULT ARRAY['sales','purchases','banking','journals']::TEXT[],
  ADD COLUMN IF NOT EXISTS is_required BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE public.tracking_categories
  DROP CONSTRAINT IF EXISTS tracking_categories_kind_check;
ALTER TABLE public.tracking_categories
  ADD CONSTRAINT tracking_categories_kind_check
  CHECK (dimension_kind IN (
    'class', 'department', 'location', 'project', 'cost_centre',
    'product_line', 'property', 'fund', 'custom'
  ));

ALTER TABLE public.tracking_options
  ADD COLUMN IF NOT EXISTS code TEXT,
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS parent_option_id UUID REFERENCES public.tracking_options(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS tracking_options_parent_idx
  ON public.tracking_options (parent_option_id)
  WHERE parent_option_id IS NOT NULL;

-- Document-level dimension assignments (sales invoice, bill, journal, bank txn, …)
CREATE TABLE IF NOT EXISTS public.document_tracking_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  category_id UUID NOT NULL REFERENCES public.tracking_categories(id) ON DELETE RESTRICT,
  option_id UUID NOT NULL REFERENCES public.tracking_options(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT document_tracking_entity_type_check CHECK (entity_type IN (
    'sales_invoice', 'sales_quote', 'sales_credit_note',
    'purchase_bill', 'purchase_credit_note', 'purchase_order',
    'journal', 'bank_transaction', 'expense'
  )),
  UNIQUE (company_id, entity_type, entity_id, category_id)
);

CREATE INDEX IF NOT EXISTS document_tracking_entity_idx
  ON public.document_tracking_assignments (company_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS document_tracking_option_idx
  ON public.document_tracking_assignments (company_id, option_id);

-- Line-level assignments (invoice lines, bill lines, journal lines)
CREATE TABLE IF NOT EXISTS public.line_tracking_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  line_id UUID NOT NULL,
  category_id UUID NOT NULL REFERENCES public.tracking_categories(id) ON DELETE RESTRICT,
  option_id UUID NOT NULL REFERENCES public.tracking_options(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT line_tracking_entity_type_check CHECK (entity_type IN (
    'sales_invoice_line', 'purchase_bill_line', 'journal_line', 'bank_transaction_line'
  )),
  UNIQUE (company_id, entity_type, line_id, category_id)
);

CREATE INDEX IF NOT EXISTS line_tracking_line_idx
  ON public.line_tracking_assignments (company_id, entity_type, line_id);
CREATE INDEX IF NOT EXISTS line_tracking_option_idx
  ON public.line_tracking_assignments (company_id, option_id);

ALTER TABLE public.document_tracking_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.line_tracking_assignments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members view document tracking" ON public.document_tracking_assignments;
CREATE POLICY "Members view document tracking" ON public.document_tracking_assignments
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));
DROP POLICY IF EXISTS "Posters manage document tracking" ON public.document_tracking_assignments;
CREATE POLICY "Posters manage document tracking" ON public.document_tracking_assignments
  FOR ALL TO authenticated
  USING (
    public.has_company_permission(company_id, 'accounts.manage')
    OR public.has_company_permission(company_id, 'sales.draft')
    OR public.has_company_permission(company_id, 'purchases.draft')
    OR public.has_company_permission(company_id, 'journals.manual')
    OR public.has_company_permission(company_id, 'banking.reconcile')
  )
  WITH CHECK (
    public.has_company_permission(company_id, 'accounts.manage')
    OR public.has_company_permission(company_id, 'sales.draft')
    OR public.has_company_permission(company_id, 'purchases.draft')
    OR public.has_company_permission(company_id, 'journals.manual')
    OR public.has_company_permission(company_id, 'banking.reconcile')
  );

DROP POLICY IF EXISTS "Members view line tracking" ON public.line_tracking_assignments;
CREATE POLICY "Members view line tracking" ON public.line_tracking_assignments
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));
DROP POLICY IF EXISTS "Posters manage line tracking" ON public.line_tracking_assignments;
CREATE POLICY "Posters manage line tracking" ON public.line_tracking_assignments
  FOR ALL TO authenticated
  USING (
    public.has_company_permission(company_id, 'accounts.manage')
    OR public.has_company_permission(company_id, 'sales.draft')
    OR public.has_company_permission(company_id, 'purchases.draft')
    OR public.has_company_permission(company_id, 'journals.manual')
  )
  WITH CHECK (
    public.has_company_permission(company_id, 'accounts.manage')
    OR public.has_company_permission(company_id, 'sales.draft')
    OR public.has_company_permission(company_id, 'purchases.draft')
    OR public.has_company_permission(company_id, 'journals.manual')
  );

-- Localisation extras on companies
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS number_decimal_separator TEXT NOT NULL DEFAULT '.',
  ADD COLUMN IF NOT EXISTS number_thousands_separator TEXT NOT NULL DEFAULT ',',
  ADD COLUMN IF NOT EXISTS first_day_of_week SMALLINT NOT NULL DEFAULT 1;

ALTER TABLE public.companies
  DROP CONSTRAINT IF EXISTS companies_first_day_of_week_check;
ALTER TABLE public.companies
  ADD CONSTRAINT companies_first_day_of_week_check
  CHECK (first_day_of_week BETWEEN 0 AND 6);

-- Pending invitations: ensure usable without email provider (token for accept link)
ALTER TABLE public.company_invitations
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

COMMENT ON TABLE public.document_tracking_assignments IS
  'Analytical dimension assignments on documents. Not GL accounts or tax codes.';
COMMENT ON TABLE public.line_tracking_assignments IS
  'Line-level analytical dimensions. Historical rows retained when options are deactivated.';
