-- Products catalogue, workflow settings, storage for org logos.
-- Additive. No inventory valuation / stock ledger in this migration (honest catalogue only).

-- ---------------------------------------------------------------------------
-- Products & services (non-inventory catalogue)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.product_kind AS ENUM ('service', 'product', 'non_inventory');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  kind public.product_kind NOT NULL DEFAULT 'service',
  code TEXT,
  name TEXT NOT NULL,
  description TEXT,
  sales_price_minor BIGINT NOT NULL DEFAULT 0 CHECK (sales_price_minor >= 0),
  purchase_cost_minor BIGINT NOT NULL DEFAULT 0 CHECK (purchase_cost_minor >= 0),
  income_account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL,
  expense_account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL,
  sales_tax_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK (sales_tax_rate_bps >= 0 AND sales_tax_rate_bps <= 10000),
  purchase_tax_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK (purchase_tax_rate_bps >= 0 AND purchase_tax_rate_bps <= 10000),
  unit TEXT NOT NULL DEFAULT 'each',
  is_active BOOLEAN NOT NULL DEFAULT true,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT products_name_nonempty CHECK (length(trim(name)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS products_company_code_uidx
  ON public.products (company_id, lower(code))
  WHERE code IS NOT NULL AND length(trim(code)) > 0 AND is_active;

CREATE INDEX IF NOT EXISTS products_company_idx ON public.products (company_id, is_active);
CREATE INDEX IF NOT EXISTS products_company_name_idx ON public.products (company_id, lower(name));

ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS products_select ON public.products;
CREATE POLICY products_select ON public.products FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

DROP POLICY IF EXISTS products_write ON public.products;
CREATE POLICY products_write ON public.products FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'products.manage'))
  WITH CHECK (public.has_company_permission(company_id, 'products.manage'));

GRANT SELECT, INSERT, UPDATE ON public.products TO authenticated;

-- Optional link from document lines (nullable — legacy lines remain valid)
ALTER TABLE public.sales_invoice_lines
  ADD COLUMN IF NOT EXISTS product_id UUID REFERENCES public.products(id) ON DELETE SET NULL;
ALTER TABLE public.sales_quote_lines
  ADD COLUMN IF NOT EXISTS product_id UUID REFERENCES public.products(id) ON DELETE SET NULL;
ALTER TABLE public.purchase_bill_lines
  ADD COLUMN IF NOT EXISTS product_id UUID REFERENCES public.products(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Organisation workflow / module settings (persisted defaults)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.company_workflow_settings (
  company_id UUID PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  sales_default_payment_terms_days INTEGER NOT NULL DEFAULT 30 CHECK (sales_default_payment_terms_days >= 0),
  sales_default_notes TEXT,
  sales_payment_instructions TEXT,
  sales_quote_validity_days INTEGER NOT NULL DEFAULT 30 CHECK (sales_quote_validity_days >= 1 AND sales_quote_validity_days <= 365),
  sales_prices_include_tax BOOLEAN NOT NULL DEFAULT false,
  purchases_default_payment_terms_days INTEGER NOT NULL DEFAULT 30 CHECK (purchases_default_payment_terms_days >= 0),
  purchases_default_notes TEXT,
  purchases_require_po BOOLEAN NOT NULL DEFAULT false,
  banking_csv_date_format TEXT NOT NULL DEFAULT 'YYYY-MM-DD',
  accounting_require_journal_memo BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE public.company_workflow_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workflow_settings_select ON public.company_workflow_settings;
CREATE POLICY workflow_settings_select ON public.company_workflow_settings FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

DROP POLICY IF EXISTS workflow_settings_write ON public.company_workflow_settings;
CREATE POLICY workflow_settings_write ON public.company_workflow_settings FOR ALL TO authenticated
  USING (
    public.has_company_permission(company_id, 'company.settings.edit')
    OR public.has_company_permission(company_id, 'accounts.manage')
  )
  WITH CHECK (
    public.has_company_permission(company_id, 'company.settings.edit')
    OR public.has_company_permission(company_id, 'accounts.manage')
  );

GRANT SELECT, INSERT, UPDATE ON public.company_workflow_settings TO authenticated;

-- ---------------------------------------------------------------------------
-- Org logo storage bucket (private; served via signed URLs / public logo path policy)
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'org-logos',
  'org-logos',
  false,
  2097152,
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/gif']
)
ON CONFLICT (id) DO UPDATE SET
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Path convention: {company_id}/logo.{ext}
DROP POLICY IF EXISTS org_logos_select ON storage.objects;
CREATE POLICY org_logos_select ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'org-logos'
    AND public.is_company_member((storage.foldername(name))[1]::uuid)
  );

DROP POLICY IF EXISTS org_logos_insert ON storage.objects;
CREATE POLICY org_logos_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'org-logos'
    AND public.has_company_permission((storage.foldername(name))[1]::uuid, 'company.settings.edit')
  );

DROP POLICY IF EXISTS org_logos_update ON storage.objects;
CREATE POLICY org_logos_update ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'org-logos'
    AND public.has_company_permission((storage.foldername(name))[1]::uuid, 'company.settings.edit')
  )
  WITH CHECK (
    bucket_id = 'org-logos'
    AND public.has_company_permission((storage.foldername(name))[1]::uuid, 'company.settings.edit')
  );

DROP POLICY IF EXISTS org_logos_delete ON storage.objects;
CREATE POLICY org_logos_delete ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'org-logos'
    AND public.has_company_permission((storage.foldername(name))[1]::uuid, 'company.settings.edit')
  );

-- Clear products on demo reset
CREATE OR REPLACE FUNCTION public.reset_demo_company(_company_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  is_d BOOLEAN;
BEGIN
  SELECT is_demo INTO is_d FROM public.companies WHERE id = _company_id;
  IF NOT FOUND OR NOT is_d THEN
    RAISE EXCEPTION 'reset_demo_company denied: company is not a demo company';
  END IF;
  IF NOT public.has_company_permission(_company_id, 'demo.reset') THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;

  PERFORM set_config('linkbooks.trusted', 'on', true);

  DELETE FROM public.journal_lines WHERE journal_id IN (
    SELECT id FROM public.journals WHERE company_id = _company_id
  );
  DELETE FROM public.journals WHERE company_id = _company_id;
  DELETE FROM public.audit_events WHERE company_id = _company_id;

  BEGIN DELETE FROM public.bank_transactions WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.bank_transfers WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.bank_rules WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.reconciliation_links WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.bank_statement_imports WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.sales_receipt_allocations WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.sales_credit_allocations WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.sales_credit_note_lines WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.sales_invoice_lines WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.sales_recurring_invoice_lines WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.sales_recurring_invoices WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.sales_receipts WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.sales_credit_notes WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.sales_invoices WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.sales_quote_lines WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.sales_quotes WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.supplier_payment_allocations WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.purchase_credit_allocations WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.purchase_credit_note_lines WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.purchase_bill_lines WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.purchase_order_lines WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.employee_expense_claims WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.supplier_payments WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.purchase_credit_notes WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.purchase_expenses WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.purchase_bills WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.purchase_orders WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.recurring_bills WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.purchase_payments WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.products WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.contacts WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.exchange_rates WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.document_sequences WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.ai_suggestions WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.company_workflow_settings WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;

  PERFORM public.seed_default_chart_of_accounts(_company_id);
  PERFORM public.seed_default_accounting_periods(_company_id);
  PERFORM public.ensure_accounting_period_coverage(
    _company_id,
    DATE '2026-04-01',
    DATE '2027-03-31',
    'Demo FY 2026/27'
  );
  BEGIN
    PERFORM public.seed_fx_accounts(_company_id);
  EXCEPTION WHEN undefined_function THEN NULL;
  END;

  INSERT INTO public.document_sequences (company_id, document_type, prefix, next_number, padding)
  VALUES
    (_company_id, 'invoice', 'INV-', 1001, 4),
    (_company_id, 'bill', 'BILL-', 2001, 4),
    (_company_id, 'quote', 'QU-', 5001, 4),
    (_company_id, 'credit_note', 'SCN-', 1, 4),
    (_company_id, 'purchase_order', 'PO-', 3001, 4)
  ON CONFLICT (company_id, document_type) DO NOTHING;

  INSERT INTO public.company_workflow_settings (company_id)
  VALUES (_company_id)
  ON CONFLICT (company_id) DO NOTHING;

  INSERT INTO public.audit_events (company_id, actor_user_id, action, entity_type, entity_id, details)
  VALUES (_company_id, auth.uid(), 'demo.reset', 'company', _company_id, '{"scope":"demo_only"}'::jsonb);

  PERFORM set_config('linkbooks.trusted', 'off', true);
END;
$$;
