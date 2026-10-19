-- Sales, Banking extensions, Contacts policy align
-- Depends on accounting engine + purchases (contacts).
-- Additive. Do not apply to production without approval.
-- Money: BIGINT minor units.

-- ---------------------------------------------------------------------------
-- Contacts: allow sales.draft writers; unique name per company (active)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Managers write contacts" ON public.contacts;
CREATE POLICY "Managers write contacts" ON public.contacts FOR INSERT TO authenticated
  WITH CHECK (
    public.has_company_permission(company_id, 'contacts.manage')
    OR public.has_company_permission(company_id, 'purchases.draft')
    OR public.has_company_permission(company_id, 'sales.draft')
  );
DROP POLICY IF EXISTS "Managers update contacts" ON public.contacts;
CREATE POLICY "Managers update contacts" ON public.contacts FOR UPDATE TO authenticated
  USING (
    public.has_company_permission(company_id, 'contacts.manage')
    OR public.has_company_permission(company_id, 'purchases.draft')
    OR public.has_company_permission(company_id, 'sales.draft')
  )
  WITH CHECK (
    public.has_company_permission(company_id, 'contacts.manage')
    OR public.has_company_permission(company_id, 'purchases.draft')
    OR public.has_company_permission(company_id, 'sales.draft')
  );

CREATE UNIQUE INDEX IF NOT EXISTS contacts_company_name_active_uidx
  ON public.contacts (company_id, lower(trim(name)))
  WHERE is_active = true;

-- ---------------------------------------------------------------------------
-- Sales document statuses
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.sales_doc_status AS ENUM (
    'draft', 'authorised', 'partly_paid', 'paid', 'void'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.quote_status AS ENUM (
    'draft', 'sent', 'accepted', 'declined', 'expired', 'converted', 'void'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Quotes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sales_quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE RESTRICT,
  quote_number TEXT,
  quote_date DATE NOT NULL,
  expiry_date DATE,
  currency_code CHAR(3) NOT NULL,
  status public.quote_status NOT NULL DEFAULT 'draft',
  subtotal_minor BIGINT NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
  tax_minor BIGINT NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor BIGINT NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  memo TEXT,
  converted_invoice_id UUID,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sales_quotes_totals CHECK (total_minor = subtotal_minor + tax_minor)
);

CREATE INDEX IF NOT EXISTS sales_quotes_company_idx ON public.sales_quotes (company_id, status);

CREATE TABLE IF NOT EXISTS public.sales_quote_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  quote_id UUID NOT NULL REFERENCES public.sales_quotes(id) ON DELETE CASCADE,
  line_order INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  quantity NUMERIC(18,6) NOT NULL CHECK (quantity > 0),
  unit_price_minor BIGINT NOT NULL CHECK (unit_price_minor >= 0),
  discount_minor BIGINT NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  tax_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bps >= 0 AND tax_rate_bps <= 10000),
  net_minor BIGINT NOT NULL CHECK (net_minor >= 0),
  tax_minor BIGINT NOT NULL CHECK (tax_minor >= 0),
  gross_minor BIGINT NOT NULL CHECK (gross_minor >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sales_quote_lines_quote_idx ON public.sales_quote_lines (quote_id);

-- ---------------------------------------------------------------------------
-- Customer invoices
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sales_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE RESTRICT,
  invoice_number TEXT,
  invoice_date DATE NOT NULL,
  due_date DATE NOT NULL,
  currency_code CHAR(3) NOT NULL,
  status public.sales_doc_status NOT NULL DEFAULT 'draft',
  subtotal_minor BIGINT NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
  tax_minor BIGINT NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor BIGINT NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  amount_paid_minor BIGINT NOT NULL DEFAULT 0 CHECK (amount_paid_minor >= 0),
  amount_credited_minor BIGINT NOT NULL DEFAULT 0 CHECK (amount_credited_minor >= 0),
  memo TEXT,
  quote_id UUID REFERENCES public.sales_quotes(id) ON DELETE SET NULL,
  posted_journal_id UUID REFERENCES public.journals(id) ON DELETE RESTRICT,
  void_journal_id UUID REFERENCES public.journals(id) ON DELETE RESTRICT,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  authorised_at TIMESTAMPTZ,
  authorised_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sales_invoices_totals CHECK (total_minor = subtotal_minor + tax_minor),
  CONSTRAINT sales_invoices_paid_le_total CHECK (amount_paid_minor + amount_credited_minor <= total_minor)
);

CREATE UNIQUE INDEX IF NOT EXISTS sales_invoices_number_uidx
  ON public.sales_invoices (company_id, lower(invoice_number))
  WHERE invoice_number IS NOT NULL AND status <> 'void';

CREATE INDEX IF NOT EXISTS sales_invoices_company_status_idx
  ON public.sales_invoices (company_id, status, due_date);
CREATE INDEX IF NOT EXISTS sales_invoices_company_contact_idx
  ON public.sales_invoices (company_id, contact_id);

CREATE TABLE IF NOT EXISTS public.sales_invoice_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES public.sales_invoices(id) ON DELETE CASCADE,
  line_order INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  quantity NUMERIC(18,6) NOT NULL CHECK (quantity > 0),
  unit_price_minor BIGINT NOT NULL CHECK (unit_price_minor >= 0),
  discount_minor BIGINT NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  tax_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bps >= 0 AND tax_rate_bps <= 10000),
  net_minor BIGINT NOT NULL CHECK (net_minor >= 0),
  tax_minor BIGINT NOT NULL CHECK (tax_minor >= 0),
  gross_minor BIGINT NOT NULL CHECK (gross_minor >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sales_invoice_lines_invoice_idx ON public.sales_invoice_lines (invoice_id);

ALTER TABLE public.sales_quotes
  DROP CONSTRAINT IF EXISTS sales_quotes_converted_invoice_fkey;
ALTER TABLE public.sales_quotes
  ADD CONSTRAINT sales_quotes_converted_invoice_fkey
  FOREIGN KEY (converted_invoice_id) REFERENCES public.sales_invoices(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Customer credit notes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sales_credit_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE RESTRICT,
  credit_number TEXT,
  credit_date DATE NOT NULL,
  currency_code CHAR(3) NOT NULL,
  status public.sales_doc_status NOT NULL DEFAULT 'draft',
  subtotal_minor BIGINT NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
  tax_minor BIGINT NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor BIGINT NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  amount_allocated_minor BIGINT NOT NULL DEFAULT 0 CHECK (amount_allocated_minor >= 0),
  memo TEXT,
  invoice_id UUID REFERENCES public.sales_invoices(id) ON DELETE SET NULL,
  posted_journal_id UUID REFERENCES public.journals(id) ON DELETE RESTRICT,
  void_journal_id UUID REFERENCES public.journals(id) ON DELETE RESTRICT,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  authorised_at TIMESTAMPTZ,
  authorised_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sales_credits_totals CHECK (total_minor = subtotal_minor + tax_minor),
  CONSTRAINT sales_credits_alloc_le_total CHECK (amount_allocated_minor <= total_minor)
);

CREATE TABLE IF NOT EXISTS public.sales_credit_note_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  credit_note_id UUID NOT NULL REFERENCES public.sales_credit_notes(id) ON DELETE CASCADE,
  line_order INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  quantity NUMERIC(18,6) NOT NULL CHECK (quantity > 0),
  unit_price_minor BIGINT NOT NULL CHECK (unit_price_minor >= 0),
  discount_minor BIGINT NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  tax_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bps >= 0 AND tax_rate_bps <= 10000),
  net_minor BIGINT NOT NULL CHECK (net_minor >= 0),
  tax_minor BIGINT NOT NULL CHECK (tax_minor >= 0),
  gross_minor BIGINT NOT NULL CHECK (gross_minor >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.sales_credit_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  credit_note_id UUID NOT NULL REFERENCES public.sales_credit_notes(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES public.sales_invoices(id) ON DELETE RESTRICT,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (credit_note_id, invoice_id)
);

-- ---------------------------------------------------------------------------
-- Customer receipts (payments received)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sales_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE RESTRICT,
  receipt_date DATE NOT NULL,
  currency_code CHAR(3) NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  unallocated_minor BIGINT NOT NULL CHECK (unallocated_minor >= 0),
  bank_account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  reference TEXT,
  memo TEXT,
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'void')),
  posted_journal_id UUID REFERENCES public.journals(id) ON DELETE RESTRICT,
  void_journal_id UUID REFERENCES public.journals(id) ON DELETE RESTRICT,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sales_receipts_unalloc_le_amount CHECK (unallocated_minor <= amount_minor)
);

CREATE TABLE IF NOT EXISTS public.sales_receipt_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  receipt_id UUID NOT NULL REFERENCES public.sales_receipts(id) ON DELETE CASCADE,
  invoice_id UUID NOT NULL REFERENCES public.sales_invoices(id) ON DELETE RESTRICT,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (receipt_id, invoice_id)
);

-- ---------------------------------------------------------------------------
-- Recurring invoices
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sales_recurring_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  frequency public.recurrence_frequency NOT NULL DEFAULT 'monthly',
  next_due_date DATE NOT NULL,
  currency_code CHAR(3) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  auto_authorise BOOLEAN NOT NULL DEFAULT false,
  memo TEXT,
  last_generated_on DATE,
  last_invoice_id UUID REFERENCES public.sales_invoices(id) ON DELETE SET NULL,
  last_error TEXT,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.sales_recurring_invoice_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  recurring_id UUID NOT NULL REFERENCES public.sales_recurring_invoices(id) ON DELETE CASCADE,
  line_order INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  quantity NUMERIC(18,6) NOT NULL CHECK (quantity > 0),
  unit_price_minor BIGINT NOT NULL CHECK (unit_price_minor >= 0),
  discount_minor BIGINT NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  tax_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bps >= 0 AND tax_rate_bps <= 10000)
);

-- ---------------------------------------------------------------------------
-- Banking: statement imports, rules, transfers, reconciliation sessions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bank_statement_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  bank_account_id UUID NOT NULL REFERENCES public.bank_accounts(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'failed', 'partial')),
  error_summary TEXT,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.bank_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  match_field TEXT NOT NULL DEFAULT 'description' CHECK (match_field IN ('description', 'reference', 'payee')),
  match_pattern TEXT NOT NULL,
  match_type TEXT NOT NULL DEFAULT 'contains' CHECK (match_type IN ('contains', 'equals', 'starts_with')),
  offset_account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  priority INTEGER NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bank_rules_pattern_nonempty CHECK (length(trim(match_pattern)) > 0)
);

CREATE INDEX IF NOT EXISTS bank_rules_company_idx ON public.bank_rules (company_id, is_active, priority);

CREATE TABLE IF NOT EXISTS public.bank_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  from_bank_account_id UUID NOT NULL REFERENCES public.bank_accounts(id) ON DELETE RESTRICT,
  to_bank_account_id UUID NOT NULL REFERENCES public.bank_accounts(id) ON DELETE RESTRICT,
  transfer_date DATE NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency_code CHAR(3) NOT NULL,
  memo TEXT,
  posted_journal_id UUID REFERENCES public.journals(id) ON DELETE RESTRICT,
  void_journal_id UUID REFERENCES public.journals(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'void')),
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bank_transfers_distinct_accounts CHECK (from_bank_account_id <> to_bank_account_id)
);

CREATE TABLE IF NOT EXISTS public.reconciliation_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  bank_account_id UUID NOT NULL REFERENCES public.bank_accounts(id) ON DELETE CASCADE,
  statement_date DATE NOT NULL,
  statement_balance_minor BIGINT NOT NULL,
  reconciled_balance_minor BIGINT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'void')),
  completed_at TIMESTAMPTZ,
  completed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  notes TEXT,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Optional feed config — never invent a connected feed
CREATE TABLE IF NOT EXISTS public.bank_feed_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  bank_account_id UUID NOT NULL REFERENCES public.bank_accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disconnected'
    CHECK (status IN ('disconnected', 'pending', 'connected', 'error')),
  external_account_id TEXT,
  last_sync_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, bank_account_id)
);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.sales_quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_quote_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_credit_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_credit_note_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_credit_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_receipt_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_recurring_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_recurring_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_statement_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reconciliation_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_feed_connections ENABLE ROW LEVEL SECURITY;

-- Sales view
CREATE POLICY "Members view sales quotes" ON public.sales_quotes FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
CREATE POLICY "Members view sales quote lines" ON public.sales_quote_lines FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
CREATE POLICY "Members view sales invoices" ON public.sales_invoices FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
CREATE POLICY "Members view sales invoice lines" ON public.sales_invoice_lines FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
CREATE POLICY "Members view sales credits" ON public.sales_credit_notes FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
CREATE POLICY "Members view sales credit lines" ON public.sales_credit_note_lines FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
CREATE POLICY "Members view sales credit alloc" ON public.sales_credit_allocations FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
CREATE POLICY "Members view sales receipts" ON public.sales_receipts FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
CREATE POLICY "Members view sales receipt alloc" ON public.sales_receipt_allocations FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
CREATE POLICY "Members view sales recurring" ON public.sales_recurring_invoices FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
CREATE POLICY "Members view sales recurring lines" ON public.sales_recurring_invoice_lines FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

-- Sales write
CREATE POLICY "Sales draft quotes" ON public.sales_quotes FOR INSERT TO authenticated
  WITH CHECK (public.has_company_permission(company_id, 'sales.draft'));
CREATE POLICY "Sales update quotes" ON public.sales_quotes FOR UPDATE TO authenticated
  USING (public.has_company_permission(company_id, 'sales.draft')
    OR public.has_company_permission(company_id, 'sales.authorise')
    OR public.has_company_permission(company_id, 'sales.void'));
CREATE POLICY "Sales draft quote lines" ON public.sales_quote_lines FOR INSERT TO authenticated
  WITH CHECK (public.has_company_permission(company_id, 'sales.draft'));
CREATE POLICY "Sales delete quote lines" ON public.sales_quote_lines FOR DELETE TO authenticated
  USING (public.has_company_permission(company_id, 'sales.draft'));

CREATE POLICY "Sales draft invoices" ON public.sales_invoices FOR INSERT TO authenticated
  WITH CHECK (public.has_company_permission(company_id, 'sales.draft'));
CREATE POLICY "Sales update invoices" ON public.sales_invoices FOR UPDATE TO authenticated
  USING (public.has_company_permission(company_id, 'sales.draft')
    OR public.has_company_permission(company_id, 'sales.authorise')
    OR public.has_company_permission(company_id, 'sales.void')
    OR public.has_company_permission(company_id, 'sales.payment'));
CREATE POLICY "Sales draft invoice lines" ON public.sales_invoice_lines FOR INSERT TO authenticated
  WITH CHECK (public.has_company_permission(company_id, 'sales.draft'));
CREATE POLICY "Sales delete invoice lines" ON public.sales_invoice_lines FOR DELETE TO authenticated
  USING (public.has_company_permission(company_id, 'sales.draft'));

CREATE POLICY "Sales draft credits" ON public.sales_credit_notes FOR INSERT TO authenticated
  WITH CHECK (public.has_company_permission(company_id, 'sales.draft'));
CREATE POLICY "Sales update credits" ON public.sales_credit_notes FOR UPDATE TO authenticated
  USING (public.has_company_permission(company_id, 'sales.draft')
    OR public.has_company_permission(company_id, 'sales.authorise')
    OR public.has_company_permission(company_id, 'sales.void')
    OR public.has_company_permission(company_id, 'sales.payment'));
CREATE POLICY "Sales draft credit lines" ON public.sales_credit_note_lines FOR INSERT TO authenticated
  WITH CHECK (public.has_company_permission(company_id, 'sales.draft'));
CREATE POLICY "Sales delete credit lines" ON public.sales_credit_note_lines FOR DELETE TO authenticated
  USING (public.has_company_permission(company_id, 'sales.draft'));
CREATE POLICY "Sales credit alloc insert" ON public.sales_credit_allocations FOR INSERT TO authenticated
  WITH CHECK (public.has_company_permission(company_id, 'sales.payment')
    OR public.has_company_permission(company_id, 'sales.authorise'));

CREATE POLICY "Sales receipt insert" ON public.sales_receipts FOR INSERT TO authenticated
  WITH CHECK (public.has_company_permission(company_id, 'sales.payment'));
CREATE POLICY "Sales receipt update" ON public.sales_receipts FOR UPDATE TO authenticated
  USING (public.has_company_permission(company_id, 'sales.payment')
    OR public.has_company_permission(company_id, 'sales.void'));
CREATE POLICY "Sales receipt alloc insert" ON public.sales_receipt_allocations FOR INSERT TO authenticated
  WITH CHECK (public.has_company_permission(company_id, 'sales.payment'));

CREATE POLICY "Sales recurring insert" ON public.sales_recurring_invoices FOR INSERT TO authenticated
  WITH CHECK (public.has_company_permission(company_id, 'sales.draft'));
CREATE POLICY "Sales recurring update" ON public.sales_recurring_invoices FOR UPDATE TO authenticated
  USING (public.has_company_permission(company_id, 'sales.draft')
    OR public.has_company_permission(company_id, 'sales.authorise'));
CREATE POLICY "Sales recurring lines insert" ON public.sales_recurring_invoice_lines FOR INSERT TO authenticated
  WITH CHECK (public.has_company_permission(company_id, 'sales.draft'));
CREATE POLICY "Sales recurring lines delete" ON public.sales_recurring_invoice_lines FOR DELETE TO authenticated
  USING (public.has_company_permission(company_id, 'sales.draft'));

-- Banking extensions
CREATE POLICY "Members view statement imports" ON public.bank_statement_imports FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
CREATE POLICY "Banking import writes" ON public.bank_statement_imports FOR INSERT TO authenticated
  WITH CHECK (public.has_company_permission(company_id, 'banking.import'));

CREATE POLICY "Members view bank rules" ON public.bank_rules FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
CREATE POLICY "Banking manage rules" ON public.bank_rules FOR INSERT TO authenticated
  WITH CHECK (public.has_company_permission(company_id, 'banking.feeds.manage')
    OR public.has_company_permission(company_id, 'banking.categorise'));
CREATE POLICY "Banking update rules" ON public.bank_rules FOR UPDATE TO authenticated
  USING (public.has_company_permission(company_id, 'banking.feeds.manage')
    OR public.has_company_permission(company_id, 'banking.categorise'));
CREATE POLICY "Banking delete rules" ON public.bank_rules FOR DELETE TO authenticated
  USING (public.has_company_permission(company_id, 'banking.feeds.manage'));

CREATE POLICY "Members view transfers" ON public.bank_transfers FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
CREATE POLICY "Banking create transfers" ON public.bank_transfers FOR INSERT TO authenticated
  WITH CHECK (public.has_company_permission(company_id, 'banking.categorise')
    OR public.has_company_permission(company_id, 'banking.reconcile'));
CREATE POLICY "Banking update transfers" ON public.bank_transfers FOR UPDATE TO authenticated
  USING (public.has_company_permission(company_id, 'banking.categorise')
    OR public.has_company_permission(company_id, 'banking.reconcile'));

CREATE POLICY "Members view recon sessions" ON public.reconciliation_sessions FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
CREATE POLICY "Reconcile sessions insert" ON public.reconciliation_sessions FOR INSERT TO authenticated
  WITH CHECK (public.has_company_permission(company_id, 'banking.reconcile'));
CREATE POLICY "Reconcile sessions update" ON public.reconciliation_sessions FOR UPDATE TO authenticated
  USING (public.has_company_permission(company_id, 'banking.reconcile'));

CREATE POLICY "Members view feed connections" ON public.bank_feed_connections FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
CREATE POLICY "Feeds manage connections" ON public.bank_feed_connections FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'banking.feeds.manage'))
  WITH CHECK (public.has_company_permission(company_id, 'banking.feeds.manage'));
