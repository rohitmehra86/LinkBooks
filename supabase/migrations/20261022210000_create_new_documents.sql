-- Create New documents: cash sales, refunds, direct receipts, deposits,
-- card payments, bank adjustments, projects, document inbox, recurring journals.
-- Posting still goes through post_journal. These tables do not post by themselves.

CREATE TABLE IF NOT EXISTS public.projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'on_hold', 'completed', 'archived')),
  start_date DATE,
  end_date DATE,
  description TEXT,
  budget_minor BIGINT CHECK (budget_minor IS NULL OR budget_minor >= 0),
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

CREATE TABLE IF NOT EXISTS public.money_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'sales_receipt', 'customer_refund', 'supplier_refund', 'receive_money',
    'bank_deposit', 'card_payment', 'bank_adjustment'
  )),
  contact_id UUID REFERENCES public.contacts(id) ON DELETE RESTRICT,
  project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  document_date DATE NOT NULL,
  reference TEXT,
  memo TEXT,
  currency_code CHAR(3) NOT NULL,
  fx_rate_to_base NUMERIC(18, 8) NOT NULL DEFAULT 1 CHECK (fx_rate_to_base > 0),
  bank_account_id UUID REFERENCES public.accounts(id) ON DELETE RESTRICT,
  counter_account_id UUID REFERENCES public.accounts(id) ON DELETE RESTRICT,
  settlement TEXT NOT NULL DEFAULT 'bank' CHECK (settlement IN ('bank', 'undeposited')),
  total_minor BIGINT NOT NULL CHECK (total_minor > 0),
  tax_minor BIGINT NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'void')),
  deposit_status TEXT CHECK (deposit_status IN ('undeposited', 'deposited')),
  deposited_in_id UUID,
  source_credit_note_id UUID,
  adjustment_type TEXT CHECK (adjustment_type IN ('bank_fee', 'interest_income', 'interest_expense')),
  posted_journal_id UUID REFERENCES public.journals(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, idempotency_key)
);

ALTER TABLE public.money_documents
  DROP CONSTRAINT IF EXISTS money_documents_deposited_in_fk;
ALTER TABLE public.money_documents
  ADD CONSTRAINT money_documents_deposited_in_fk
  FOREIGN KEY (deposited_in_id) REFERENCES public.money_documents(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS money_documents_company_date
  ON public.money_documents (company_id, document_date);

CREATE TABLE IF NOT EXISTS public.money_document_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES public.money_documents(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  description TEXT NOT NULL,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  net_minor BIGINT NOT NULL CHECK (net_minor >= 0),
  tax_minor BIGINT NOT NULL CHECK (tax_minor >= 0),
  project_id UUID REFERENCES public.projects(id) ON DELETE SET NULL,
  UNIQUE (document_id, line_no)
);

CREATE TABLE IF NOT EXISTS public.money_deposit_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  deposit_id UUID NOT NULL REFERENCES public.money_documents(id) ON DELETE CASCADE,
  source_document_id UUID NOT NULL REFERENCES public.money_documents(id) ON DELETE RESTRICT,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  UNIQUE (source_document_id)
);

CREATE TABLE IF NOT EXISTS public.recurring_journal_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE,
  max_occurrences INTEGER CHECK (max_occurrences IS NULL OR max_occurrences > 0),
  next_date DATE NOT NULL,
  interval_months INTEGER NOT NULL DEFAULT 1 CHECK (interval_months BETWEEN 1 AND 12),
  is_active BOOLEAN NOT NULL DEFAULT true,
  lines JSONB NOT NULL,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.recurring_journal_occurrences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  template_id UUID NOT NULL REFERENCES public.recurring_journal_templates(id) ON DELETE CASCADE,
  occurrence_date DATE NOT NULL,
  journal_id UUID REFERENCES public.journals(id) ON DELETE RESTRICT,
  UNIQUE (template_id, occurrence_date)
);

CREATE TABLE IF NOT EXISTS public.inbox_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  content_type TEXT,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 20971520),
  status TEXT NOT NULL DEFAULT 'inbox' CHECK (status IN ('inbox', 'classified', 'linked')),
  scan_status TEXT NOT NULL DEFAULT 'not_scanned' CHECK (scan_status IN ('not_scanned')),
  note TEXT,
  linked_entity_type TEXT,
  linked_entity_id UUID,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.money_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.money_document_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.money_deposit_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recurring_journal_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recurring_journal_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS projects_select ON public.projects;
CREATE POLICY projects_select ON public.projects FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
DROP POLICY IF EXISTS projects_write ON public.projects;
CREATE POLICY projects_write ON public.projects FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'accounts.manage') OR public.has_company_permission(company_id, 'contacts.manage'))
  WITH CHECK (public.has_company_permission(company_id, 'accounts.manage') OR public.has_company_permission(company_id, 'contacts.manage'));

DROP POLICY IF EXISTS money_documents_select ON public.money_documents;
CREATE POLICY money_documents_select ON public.money_documents FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
DROP POLICY IF EXISTS money_documents_write ON public.money_documents;
CREATE POLICY money_documents_write ON public.money_documents FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'accounting.post') OR public.has_company_permission(company_id, 'journals.manual'))
  WITH CHECK (public.has_company_permission(company_id, 'accounting.post') OR public.has_company_permission(company_id, 'journals.manual'));

DROP POLICY IF EXISTS money_document_lines_select ON public.money_document_lines;
CREATE POLICY money_document_lines_select ON public.money_document_lines FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
DROP POLICY IF EXISTS money_document_lines_write ON public.money_document_lines;
CREATE POLICY money_document_lines_write ON public.money_document_lines FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'accounting.post') OR public.has_company_permission(company_id, 'journals.manual'))
  WITH CHECK (public.has_company_permission(company_id, 'accounting.post') OR public.has_company_permission(company_id, 'journals.manual'));

DROP POLICY IF EXISTS money_deposit_items_select ON public.money_deposit_items;
CREATE POLICY money_deposit_items_select ON public.money_deposit_items FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
DROP POLICY IF EXISTS money_deposit_items_write ON public.money_deposit_items;
CREATE POLICY money_deposit_items_write ON public.money_deposit_items FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'accounting.post'))
  WITH CHECK (public.has_company_permission(company_id, 'accounting.post'));

DROP POLICY IF EXISTS recurring_journal_templates_select ON public.recurring_journal_templates;
CREATE POLICY recurring_journal_templates_select ON public.recurring_journal_templates FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
DROP POLICY IF EXISTS recurring_journal_templates_write ON public.recurring_journal_templates;
CREATE POLICY recurring_journal_templates_write ON public.recurring_journal_templates FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'journals.manual'))
  WITH CHECK (public.has_company_permission(company_id, 'journals.manual'));

DROP POLICY IF EXISTS recurring_journal_occurrences_select ON public.recurring_journal_occurrences;
CREATE POLICY recurring_journal_occurrences_select ON public.recurring_journal_occurrences FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
DROP POLICY IF EXISTS recurring_journal_occurrences_write ON public.recurring_journal_occurrences;
CREATE POLICY recurring_journal_occurrences_write ON public.recurring_journal_occurrences FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'journals.manual'))
  WITH CHECK (public.has_company_permission(company_id, 'journals.manual'));

DROP POLICY IF EXISTS inbox_documents_select ON public.inbox_documents;
CREATE POLICY inbox_documents_select ON public.inbox_documents FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
DROP POLICY IF EXISTS inbox_documents_write ON public.inbox_documents;
CREATE POLICY inbox_documents_write ON public.inbox_documents FOR ALL TO authenticated
  USING (
    public.has_company_permission(company_id, 'purchases.draft')
    OR public.has_company_permission(company_id, 'sales.draft')
  )
  WITH CHECK (
    public.has_company_permission(company_id, 'purchases.draft')
    OR public.has_company_permission(company_id, 'sales.draft')
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.projects TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.money_documents TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.money_document_lines TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.money_deposit_items TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recurring_journal_templates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recurring_journal_occurrences TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inbox_documents TO authenticated;
