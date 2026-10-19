-- Purchases module (bills, expenses, payments, credits, POs, recurring, contacts)
-- Depends on accounting engine migration (accounts, journals, post_journal).
-- Additive. Do not apply to production without approval.
-- Money: BIGINT minor units.

-- ---------------------------------------------------------------------------
-- Contacts (suppliers / customers)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.contact_kind AS ENUM ('supplier', 'customer', 'both', 'employee');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  kind public.contact_kind NOT NULL DEFAULT 'supplier',
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  tax_number TEXT,
  payment_terms_days INTEGER NOT NULL DEFAULT 30 CHECK (payment_terms_days >= 0),
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT contacts_name_nonempty CHECK (length(trim(name)) > 0)
);

CREATE INDEX IF NOT EXISTS contacts_company_idx ON public.contacts (company_id);
CREATE INDEX IF NOT EXISTS contacts_company_kind_idx ON public.contacts (company_id, kind);
CREATE INDEX IF NOT EXISTS contacts_company_name_idx ON public.contacts (company_id, lower(name));

ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members view contacts" ON public.contacts;
CREATE POLICY "Members view contacts" ON public.contacts FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
DROP POLICY IF EXISTS "Managers write contacts" ON public.contacts;
CREATE POLICY "Managers write contacts" ON public.contacts FOR INSERT TO authenticated
  WITH CHECK (public.has_company_permission(company_id, 'contacts.manage')
    OR public.has_company_permission(company_id, 'purchases.draft'));
DROP POLICY IF EXISTS "Managers update contacts" ON public.contacts;
CREATE POLICY "Managers update contacts" ON public.contacts FOR UPDATE TO authenticated
  USING (public.has_company_permission(company_id, 'contacts.manage')
    OR public.has_company_permission(company_id, 'purchases.draft'))
  WITH CHECK (public.has_company_permission(company_id, 'contacts.manage')
    OR public.has_company_permission(company_id, 'purchases.draft'));

-- ---------------------------------------------------------------------------
-- Document statuses
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.purchase_doc_status AS ENUM (
    'draft', 'authorised', 'partly_paid', 'paid', 'void'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.po_status AS ENUM (
    'draft', 'sent', 'partially_received', 'billed', 'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.recurrence_frequency AS ENUM (
    'weekly', 'monthly', 'quarterly', 'yearly'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.expense_claim_status AS ENUM (
    'draft', 'submitted', 'approved', 'rejected', 'reimbursed', 'void'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Purchase bills
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.purchase_bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE RESTRICT,
  bill_number TEXT,
  supplier_invoice_number TEXT,
  bill_date DATE NOT NULL,
  due_date DATE NOT NULL,
  currency_code CHAR(3) NOT NULL,
  status public.purchase_doc_status NOT NULL DEFAULT 'draft',
  subtotal_minor BIGINT NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
  tax_minor BIGINT NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor BIGINT NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  amount_paid_minor BIGINT NOT NULL DEFAULT 0 CHECK (amount_paid_minor >= 0),
  amount_credited_minor BIGINT NOT NULL DEFAULT 0 CHECK (amount_credited_minor >= 0),
  memo TEXT,
  purchase_order_id UUID,
  posted_journal_id UUID REFERENCES public.journals(id) ON DELETE RESTRICT,
  void_journal_id UUID REFERENCES public.journals(id) ON DELETE RESTRICT,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  authorised_at TIMESTAMPTZ,
  authorised_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT purchase_bills_totals CHECK (total_minor = subtotal_minor + tax_minor),
  CONSTRAINT purchase_bills_paid_le_total CHECK (amount_paid_minor + amount_credited_minor <= total_minor)
);

-- Duplicate supplier invoice prevention (active docs only)
CREATE UNIQUE INDEX IF NOT EXISTS purchase_bills_supplier_invoice_uidx
  ON public.purchase_bills (company_id, contact_id, lower(supplier_invoice_number))
  WHERE supplier_invoice_number IS NOT NULL
    AND status <> 'void';

CREATE INDEX IF NOT EXISTS purchase_bills_company_status_idx
  ON public.purchase_bills (company_id, status, due_date);
CREATE INDEX IF NOT EXISTS purchase_bills_company_contact_idx
  ON public.purchase_bills (company_id, contact_id);

CREATE TABLE IF NOT EXISTS public.purchase_bill_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  bill_id UUID NOT NULL REFERENCES public.purchase_bills(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  description TEXT NOT NULL,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  quantity NUMERIC(18, 6) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_minor BIGINT NOT NULL DEFAULT 0 CHECK (unit_price_minor >= 0),
  discount_minor BIGINT NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  tax_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bps >= 0 AND tax_rate_bps <= 10000),
  net_minor BIGINT NOT NULL DEFAULT 0 CHECK (net_minor >= 0),
  tax_minor BIGINT NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  UNIQUE (bill_id, line_no)
);

-- ---------------------------------------------------------------------------
-- Direct expenses (paid immediately)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.purchase_expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  payee_name TEXT NOT NULL,
  contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  expense_date DATE NOT NULL,
  expense_account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  payment_account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  currency_code CHAR(3) NOT NULL,
  reference TEXT,
  memo TEXT,
  net_minor BIGINT NOT NULL DEFAULT 0 CHECK (net_minor >= 0),
  tax_minor BIGINT NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor BIGINT NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  status public.purchase_doc_status NOT NULL DEFAULT 'draft',
  posted_journal_id UUID REFERENCES public.journals(id) ON DELETE RESTRICT,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT purchase_expenses_totals CHECK (total_minor = net_minor + tax_minor)
);

CREATE INDEX IF NOT EXISTS purchase_expenses_company_idx
  ON public.purchase_expenses (company_id, expense_date DESC);

-- ---------------------------------------------------------------------------
-- Supplier payments + allocations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.supplier_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE RESTRICT,
  payment_date DATE NOT NULL,
  bank_account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  currency_code CHAR(3) NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  reference TEXT,
  memo TEXT,
  status public.purchase_doc_status NOT NULL DEFAULT 'draft',
  unallocated_minor BIGINT NOT NULL DEFAULT 0 CHECK (unallocated_minor >= 0),
  posted_journal_id UUID REFERENCES public.journals(id) ON DELETE RESTRICT,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.supplier_payment_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  payment_id UUID NOT NULL REFERENCES public.supplier_payments(id) ON DELETE CASCADE,
  bill_id UUID NOT NULL REFERENCES public.purchase_bills(id) ON DELETE RESTRICT,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  UNIQUE (payment_id, bill_id)
);

-- ---------------------------------------------------------------------------
-- Supplier credit notes + allocations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.purchase_credit_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE RESTRICT,
  credit_number TEXT,
  credit_date DATE NOT NULL,
  currency_code CHAR(3) NOT NULL,
  status public.purchase_doc_status NOT NULL DEFAULT 'draft',
  subtotal_minor BIGINT NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
  tax_minor BIGINT NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor BIGINT NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  amount_allocated_minor BIGINT NOT NULL DEFAULT 0 CHECK (amount_allocated_minor >= 0),
  memo TEXT,
  posted_journal_id UUID REFERENCES public.journals(id) ON DELETE RESTRICT,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT purchase_credits_totals CHECK (total_minor = subtotal_minor + tax_minor),
  CONSTRAINT purchase_credits_alloc_le_total CHECK (amount_allocated_minor <= total_minor)
);

CREATE TABLE IF NOT EXISTS public.purchase_credit_note_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  credit_note_id UUID NOT NULL REFERENCES public.purchase_credit_notes(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  description TEXT NOT NULL,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  net_minor BIGINT NOT NULL DEFAULT 0 CHECK (net_minor >= 0),
  tax_minor BIGINT NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  UNIQUE (credit_note_id, line_no)
);

CREATE TABLE IF NOT EXISTS public.purchase_credit_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  credit_note_id UUID NOT NULL REFERENCES public.purchase_credit_notes(id) ON DELETE CASCADE,
  bill_id UUID NOT NULL REFERENCES public.purchase_bills(id) ON DELETE RESTRICT,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  UNIQUE (credit_note_id, bill_id)
);

-- ---------------------------------------------------------------------------
-- Purchase orders (no ledger post)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE RESTRICT,
  order_number TEXT,
  order_date DATE NOT NULL,
  currency_code CHAR(3) NOT NULL,
  status public.po_status NOT NULL DEFAULT 'draft',
  subtotal_minor BIGINT NOT NULL DEFAULT 0,
  tax_minor BIGINT NOT NULL DEFAULT 0,
  total_minor BIGINT NOT NULL DEFAULT 0,
  memo TEXT,
  billed_bill_id UUID REFERENCES public.purchase_bills(id) ON DELETE SET NULL,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.purchase_order_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES public.purchase_orders(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  description TEXT NOT NULL,
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  quantity NUMERIC(18, 6) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_minor BIGINT NOT NULL DEFAULT 0,
  tax_rate_bps INTEGER NOT NULL DEFAULT 0,
  net_minor BIGINT NOT NULL DEFAULT 0,
  tax_minor BIGINT NOT NULL DEFAULT 0,
  UNIQUE (order_id, line_no)
);

ALTER TABLE public.purchase_bills
  DROP CONSTRAINT IF EXISTS purchase_bills_po_fk;
ALTER TABLE public.purchase_bills
  ADD CONSTRAINT purchase_bills_po_fk
  FOREIGN KEY (purchase_order_id) REFERENCES public.purchase_orders(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Recurring bills (generate drafts by default — no auto-post)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.recurring_bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  frequency public.recurrence_frequency NOT NULL DEFAULT 'monthly',
  next_due_date DATE NOT NULL,
  day_of_month SMALLINT CHECK (day_of_month IS NULL OR (day_of_month >= 1 AND day_of_month <= 28)),
  currency_code CHAR(3) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  auto_authorise BOOLEAN NOT NULL DEFAULT false,
  last_generated_on DATE,
  last_error TEXT,
  template JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS recurring_bills_gen_guard_uidx
  ON public.recurring_bills (id, last_generated_on)
  WHERE last_generated_on IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Employee expense claims
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.employee_expense_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  claimant_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  claim_date DATE NOT NULL,
  description TEXT NOT NULL,
  expense_account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  currency_code CHAR(3) NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  tax_minor BIGINT NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  status public.expense_claim_status NOT NULL DEFAULT 'draft',
  reimbursement_payment_id UUID REFERENCES public.supplier_payments(id) ON DELETE SET NULL,
  posted_journal_id UUID REFERENCES public.journals(id) ON DELETE RESTRICT,
  reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Attachments metadata (storage path only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.document_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  file_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  content_type TEXT,
  size_bytes INTEGER,
  uploaded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS document_attachments_entity_idx
  ON public.document_attachments (company_id, entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- RLS for purchase tables
-- ---------------------------------------------------------------------------
DO $$ DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'purchase_bills','purchase_bill_lines','purchase_expenses',
    'supplier_payments','supplier_payment_allocations',
    'purchase_credit_notes','purchase_credit_note_lines','purchase_credit_allocations',
    'purchase_orders','purchase_order_lines','recurring_bills',
    'employee_expense_claims','document_attachments'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.is_company_member(company_id))',
      t||'_select', t
    );
  END LOOP;
END $$;

-- Write policies (draft / authorise / payment)
DROP POLICY IF EXISTS purchase_bills_insert ON public.purchase_bills;
CREATE POLICY purchase_bills_insert ON public.purchase_bills FOR INSERT TO authenticated
  WITH CHECK (public.has_company_permission(company_id, 'purchases.draft'));
DROP POLICY IF EXISTS purchase_bills_update ON public.purchase_bills;
CREATE POLICY purchase_bills_update ON public.purchase_bills FOR UPDATE TO authenticated
  USING (
    public.has_company_permission(company_id, 'purchases.draft')
    OR public.has_company_permission(company_id, 'purchases.authorise')
    OR public.has_company_permission(company_id, 'purchases.payment')
  )
  WITH CHECK (
    public.has_company_permission(company_id, 'purchases.draft')
    OR public.has_company_permission(company_id, 'purchases.authorise')
    OR public.has_company_permission(company_id, 'purchases.payment')
  );

DROP POLICY IF EXISTS purchase_bill_lines_insert ON public.purchase_bill_lines;
CREATE POLICY purchase_bill_lines_insert ON public.purchase_bill_lines FOR INSERT TO authenticated
  WITH CHECK (public.has_company_permission(company_id, 'purchases.draft'));
DROP POLICY IF EXISTS purchase_bill_lines_update ON public.purchase_bill_lines;
CREATE POLICY purchase_bill_lines_update ON public.purchase_bill_lines FOR UPDATE TO authenticated
  USING (public.has_company_permission(company_id, 'purchases.draft'))
  WITH CHECK (public.has_company_permission(company_id, 'purchases.draft'));
DROP POLICY IF EXISTS purchase_bill_lines_delete ON public.purchase_bill_lines;
CREATE POLICY purchase_bill_lines_delete ON public.purchase_bill_lines FOR DELETE TO authenticated
  USING (public.has_company_permission(company_id, 'purchases.draft'));

DROP POLICY IF EXISTS purchase_expenses_write ON public.purchase_expenses;
CREATE POLICY purchase_expenses_write ON public.purchase_expenses FOR ALL TO authenticated
  USING (
    public.has_company_permission(company_id, 'expenses.submit')
    OR public.has_company_permission(company_id, 'purchases.authorise')
  )
  WITH CHECK (
    public.has_company_permission(company_id, 'expenses.submit')
    OR public.has_company_permission(company_id, 'purchases.authorise')
  );

DROP POLICY IF EXISTS supplier_payments_write ON public.supplier_payments;
CREATE POLICY supplier_payments_write ON public.supplier_payments FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'purchases.payment'))
  WITH CHECK (public.has_company_permission(company_id, 'purchases.payment'));

DROP POLICY IF EXISTS supplier_payment_alloc_write ON public.supplier_payment_allocations;
CREATE POLICY supplier_payment_alloc_write ON public.supplier_payment_allocations FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'purchases.payment'))
  WITH CHECK (public.has_company_permission(company_id, 'purchases.payment'));

DROP POLICY IF EXISTS purchase_credits_write ON public.purchase_credit_notes;
CREATE POLICY purchase_credits_write ON public.purchase_credit_notes FOR ALL TO authenticated
  USING (
    public.has_company_permission(company_id, 'purchases.draft')
    OR public.has_company_permission(company_id, 'purchases.authorise')
  )
  WITH CHECK (
    public.has_company_permission(company_id, 'purchases.draft')
    OR public.has_company_permission(company_id, 'purchases.authorise')
  );

DROP POLICY IF EXISTS purchase_credit_lines_write ON public.purchase_credit_note_lines;
CREATE POLICY purchase_credit_lines_write ON public.purchase_credit_note_lines FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'purchases.draft'))
  WITH CHECK (public.has_company_permission(company_id, 'purchases.draft'));

DROP POLICY IF EXISTS purchase_credit_alloc_write ON public.purchase_credit_allocations;
CREATE POLICY purchase_credit_alloc_write ON public.purchase_credit_allocations FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'purchases.payment')
    OR public.has_company_permission(company_id, 'purchases.authorise'))
  WITH CHECK (public.has_company_permission(company_id, 'purchases.payment')
    OR public.has_company_permission(company_id, 'purchases.authorise'));

DROP POLICY IF EXISTS purchase_orders_write ON public.purchase_orders;
CREATE POLICY purchase_orders_write ON public.purchase_orders FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'purchases.draft'))
  WITH CHECK (public.has_company_permission(company_id, 'purchases.draft'));

DROP POLICY IF EXISTS purchase_order_lines_write ON public.purchase_order_lines;
CREATE POLICY purchase_order_lines_write ON public.purchase_order_lines FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'purchases.draft'))
  WITH CHECK (public.has_company_permission(company_id, 'purchases.draft'));

DROP POLICY IF EXISTS recurring_bills_write ON public.recurring_bills;
CREATE POLICY recurring_bills_write ON public.recurring_bills FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'purchases.draft'))
  WITH CHECK (public.has_company_permission(company_id, 'purchases.draft'));

DROP POLICY IF EXISTS employee_claims_select ON public.employee_expense_claims;
-- already have generic select
DROP POLICY IF EXISTS employee_claims_write ON public.employee_expense_claims;
CREATE POLICY employee_claims_write ON public.employee_expense_claims FOR ALL TO authenticated
  USING (
    public.has_company_permission(company_id, 'expenses.submit')
    OR public.has_company_permission(company_id, 'expenses.approve')
  )
  WITH CHECK (
    public.has_company_permission(company_id, 'expenses.submit')
    OR public.has_company_permission(company_id, 'expenses.approve')
  );

DROP POLICY IF EXISTS document_attachments_write ON public.document_attachments;
CREATE POLICY document_attachments_write ON public.document_attachments FOR ALL TO authenticated
  USING (public.is_company_member(company_id))
  WITH CHECK (public.is_company_member(company_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
