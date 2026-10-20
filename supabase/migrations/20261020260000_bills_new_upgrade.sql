-- New Bill upgrade: transaction address, terms catalog, tax mode, notes, attachment payload.

ALTER TABLE public.purchase_bills
  ADD COLUMN IF NOT EXISTS supplier_address_line1 TEXT,
  ADD COLUMN IF NOT EXISTS supplier_address_line2 TEXT,
  ADD COLUMN IF NOT EXISTS supplier_address_city TEXT,
  ADD COLUMN IF NOT EXISTS supplier_address_region TEXT,
  ADD COLUMN IF NOT EXISTS supplier_address_postal TEXT,
  ADD COLUMN IF NOT EXISTS supplier_address_country TEXT,
  ADD COLUMN IF NOT EXISTS payment_terms_days INT,
  ADD COLUMN IF NOT EXISTS payment_term_id UUID,
  ADD COLUMN IF NOT EXISTS due_date_manual_override BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tax_calculation TEXT NOT NULL DEFAULT 'exclusive',
  ADD COLUMN IF NOT EXISTS fx_rate_to_base NUMERIC(18, 8);

ALTER TABLE public.purchase_bills
  DROP CONSTRAINT IF EXISTS purchase_bills_tax_calculation_check;
ALTER TABLE public.purchase_bills
  ADD CONSTRAINT purchase_bills_tax_calculation_check
  CHECK (tax_calculation IN ('exclusive', 'inclusive', 'none'));

-- Organisation payment terms catalogue
CREATE TABLE IF NOT EXISTS public.company_payment_terms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  days INT NOT NULL DEFAULT 30 CHECK (days >= 0 AND days <= 3650),
  calculation_method TEXT NOT NULL DEFAULT 'days_after_bill_date',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT company_payment_terms_name_nonempty CHECK (length(trim(name)) > 0),
  CONSTRAINT company_payment_terms_method_check CHECK (
    calculation_method IN ('days_after_bill_date', 'due_on_receipt', 'days_after_month_end')
  ),
  UNIQUE (company_id, name)
);

CREATE INDEX IF NOT EXISTS company_payment_terms_company_idx
  ON public.company_payment_terms (company_id);

ALTER TABLE public.purchase_bills
  DROP CONSTRAINT IF EXISTS purchase_bills_payment_term_fk;
ALTER TABLE public.purchase_bills
  ADD CONSTRAINT purchase_bills_payment_term_fk
  FOREIGN KEY (payment_term_id) REFERENCES public.company_payment_terms(id) ON DELETE SET NULL;

ALTER TABLE public.company_payment_terms ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members view payment terms" ON public.company_payment_terms;
CREATE POLICY "Members view payment terms" ON public.company_payment_terms
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));
DROP POLICY IF EXISTS "Managers manage payment terms" ON public.company_payment_terms;
CREATE POLICY "Managers manage payment terms" ON public.company_payment_terms
  FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'purchases.draft')
    OR public.has_company_permission(company_id, 'company.settings.edit'))
  WITH CHECK (public.has_company_permission(company_id, 'purchases.draft')
    OR public.has_company_permission(company_id, 'company.settings.edit'));

-- Internal notes on bills
CREATE TABLE IF NOT EXISTS public.bill_internal_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  bill_id UUID NOT NULL REFERENCES public.purchase_bills(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (length(trim(body)) > 0 AND length(body) <= 4000),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bill_internal_notes_bill_idx ON public.bill_internal_notes (bill_id);

ALTER TABLE public.bill_internal_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members view bill notes" ON public.bill_internal_notes;
CREATE POLICY "Members view bill notes" ON public.bill_internal_notes
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));
DROP POLICY IF EXISTS "Draft writers manage bill notes" ON public.bill_internal_notes;
CREATE POLICY "Draft writers manage bill notes" ON public.bill_internal_notes
  FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'purchases.draft'))
  WITH CHECK (public.has_company_permission(company_id, 'purchases.draft'));

-- Attachment binary payload (max 20 MB) when object storage is not configured
ALTER TABLE public.document_attachments
  ADD COLUMN IF NOT EXISTS content_base64 TEXT;

ALTER TABLE public.document_attachments
  DROP CONSTRAINT IF EXISTS document_attachments_size_check;
ALTER TABLE public.document_attachments
  ADD CONSTRAINT document_attachments_size_check
  CHECK (size_bytes IS NULL OR (size_bytes >= 0 AND size_bytes <= 20971520));

-- Line tracking / catalogue / billable
ALTER TABLE public.purchase_bill_lines
  ADD COLUMN IF NOT EXISTS class_option_id UUID REFERENCES public.tracking_options(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS location_option_id UUID REFERENCES public.tracking_options(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS project_option_id UUID REFERENCES public.tracking_options(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS customer_contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS is_billable BOOLEAN NOT NULL DEFAULT false;

-- Duplicate supplier invoice: soft warn + explicit override
ALTER TABLE public.purchase_bills
  ADD COLUMN IF NOT EXISTS duplicate_override BOOLEAN NOT NULL DEFAULT false;

DROP INDEX IF EXISTS public.purchase_bills_supplier_invoice_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS purchase_bills_supplier_invoice_uidx
  ON public.purchase_bills (company_id, contact_id, lower(supplier_invoice_number))
  WHERE supplier_invoice_number IS NOT NULL
    AND status <> 'void'
    AND duplicate_override = false;

-- Seed default Net 30 / Due on receipt for companies that have none
INSERT INTO public.company_payment_terms (company_id, name, days, calculation_method)
SELECT c.id, 'Net 30', 30, 'days_after_bill_date'
FROM public.companies c
WHERE NOT EXISTS (
  SELECT 1 FROM public.company_payment_terms t WHERE t.company_id = c.id AND t.name = 'Net 30'
);

INSERT INTO public.company_payment_terms (company_id, name, days, calculation_method)
SELECT c.id, 'Due on receipt', 0, 'due_on_receipt'
FROM public.companies c
WHERE NOT EXISTS (
  SELECT 1 FROM public.company_payment_terms t WHERE t.company_id = c.id AND t.name = 'Due on receipt'
);
