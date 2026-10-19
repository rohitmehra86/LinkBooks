-- Cross-cutting: org settings extras, document sequences, branding, FX rates,
-- audit helper, demo reset. Apply via supabase db push / SQL editor when approved.

DO $$ BEGIN
  ALTER TYPE public.journal_source_type ADD VALUE 'fx_revaluation';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Organisation localisation preferences
-- ---------------------------------------------------------------------------
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT 'en-GB',
  ADD COLUMN IF NOT EXISTS date_format TEXT NOT NULL DEFAULT 'DD/MM/YYYY',
  ADD COLUMN IF NOT EXISTS invoice_footer TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS document_theme_color TEXT NOT NULL DEFAULT '#0F766E';

COMMENT ON COLUMN public.companies.locale IS 'BCP 47 locale for number/date display preferences';
COMMENT ON COLUMN public.companies.date_format IS 'Display preference only; storage remains ISO dates';

-- ---------------------------------------------------------------------------
-- Document branding
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.company_branding (
  company_id UUID PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  trading_name TEXT,
  letterhead_line TEXT,
  invoice_email TEXT,
  invoice_phone TEXT,
  logo_url TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.company_branding ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can read branding" ON public.company_branding;
CREATE POLICY "Members can read branding"
  ON public.company_branding FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

DROP POLICY IF EXISTS "Settings editors manage branding" ON public.company_branding;
CREATE POLICY "Settings editors manage branding"
  ON public.company_branding FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'company.settings.edit'))
  WITH CHECK (public.has_company_permission(company_id, 'company.settings.edit'));

GRANT SELECT, INSERT, UPDATE ON public.company_branding TO authenticated;

-- ---------------------------------------------------------------------------
-- Document number sequences
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.document_sequences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL,
  prefix TEXT NOT NULL DEFAULT '',
  next_number INTEGER NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  padding INTEGER NOT NULL DEFAULT 4 CHECK (padding >= 1 AND padding <= 10),
  UNIQUE (company_id, document_type)
);

ALTER TABLE public.document_sequences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can read sequences" ON public.document_sequences;
CREATE POLICY "Members can read sequences"
  ON public.document_sequences FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

DROP POLICY IF EXISTS "Settings editors manage sequences" ON public.document_sequences;
CREATE POLICY "Settings editors manage sequences"
  ON public.document_sequences FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'company.settings.edit'))
  WITH CHECK (public.has_company_permission(company_id, 'company.settings.edit'));

GRANT SELECT, INSERT, UPDATE ON public.document_sequences TO authenticated;

CREATE OR REPLACE FUNCTION public.allocate_document_number(_company_id UUID, _document_type TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _prefix TEXT;
  _next INTEGER;
  _pad INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'Not a member of this company';
  END IF;

  INSERT INTO public.document_sequences (company_id, document_type, prefix, next_number, padding)
  VALUES (_company_id, _document_type, UPPER(LEFT(_document_type, 3)) || '-', 1, 4)
  ON CONFLICT (company_id, document_type) DO NOTHING;

  UPDATE public.document_sequences
  SET next_number = next_number + 1
  WHERE company_id = _company_id AND document_type = _document_type
  RETURNING prefix, next_number - 1, padding INTO _prefix, _next, _pad;

  IF _next IS NULL THEN RAISE EXCEPTION 'Could not allocate document number'; END IF;
  RETURN _prefix || lpad(_next::TEXT, _pad, '0');
END;
$$;

GRANT EXECUTE ON FUNCTION public.allocate_document_number(UUID, TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- Enabled currencies (UX allow-list; base always implied)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.company_currencies (
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  currency_code CHAR(3) NOT NULL,
  enabled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, currency_code)
);

ALTER TABLE public.company_currencies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members read currencies" ON public.company_currencies;
CREATE POLICY "Members read currencies"
  ON public.company_currencies FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

DROP POLICY IF EXISTS "Settings editors manage currencies" ON public.company_currencies;
CREATE POLICY "Settings editors manage currencies"
  ON public.company_currencies FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'company.settings.edit'))
  WITH CHECK (public.has_company_permission(company_id, 'company.settings.edit'));

GRANT SELECT, INSERT, DELETE ON public.company_currencies TO authenticated;

-- ---------------------------------------------------------------------------
-- Exchange rates (append-only rate values; void instead of mutate)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.exchange_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  from_currency CHAR(3) NOT NULL,
  to_currency CHAR(3) NOT NULL,
  rate_date DATE NOT NULL,
  rate NUMERIC(18, 8) NOT NULL CHECK (rate > 0),
  note TEXT,
  voided_at TIMESTAMPTZ,
  voided_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, from_currency, to_currency, rate_date)
);

CREATE INDEX IF NOT EXISTS exchange_rates_lookup_idx
  ON public.exchange_rates (company_id, from_currency, to_currency, rate_date DESC)
  WHERE voided_at IS NULL;

ALTER TABLE public.exchange_rates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members read exchange rates" ON public.exchange_rates;
CREATE POLICY "Members read exchange rates"
  ON public.exchange_rates FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

DROP POLICY IF EXISTS "Settings editors insert exchange rates" ON public.exchange_rates;
CREATE POLICY "Settings editors insert exchange rates"
  ON public.exchange_rates FOR INSERT TO authenticated
  WITH CHECK (public.has_company_permission(company_id, 'company.settings.edit'));

-- No UPDATE/DELETE policies for clients — void via SECURITY DEFINER only.

GRANT SELECT, INSERT ON public.exchange_rates TO authenticated;

CREATE OR REPLACE FUNCTION public.prevent_exchange_rate_mutate()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Exchange rates cannot be deleted; void them instead';
  END IF;
  -- Allow only voiding fields to change; never the rate, currencies, or date.
  IF NEW.rate IS DISTINCT FROM OLD.rate
     OR NEW.from_currency IS DISTINCT FROM OLD.from_currency
     OR NEW.to_currency IS DISTINCT FROM OLD.to_currency
     OR NEW.rate_date IS DISTINCT FROM OLD.rate_date
     OR NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'Historical exchange rates cannot be altered';
  END IF;
  IF OLD.voided_at IS NOT NULL AND NEW.voided_at IS DISTINCT FROM OLD.voided_at THEN
    RAISE EXCEPTION 'Voided exchange rates cannot be un-voided';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS exchange_rates_immutable ON public.exchange_rates;
CREATE TRIGGER exchange_rates_immutable
  BEFORE UPDATE OR DELETE ON public.exchange_rates
  FOR EACH ROW EXECUTE FUNCTION public.prevent_exchange_rate_mutate();

CREATE OR REPLACE FUNCTION public.void_exchange_rate(_rate_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _company_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  SELECT company_id INTO _company_id FROM public.exchange_rates WHERE id = _rate_id;
  IF _company_id IS NULL THEN RAISE EXCEPTION 'Rate not found'; END IF;
  IF NOT public.has_company_permission(_company_id, 'company.settings.edit') THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;
  UPDATE public.exchange_rates
  SET voided_at = now(), voided_by = auth.uid()
  WHERE id = _rate_id AND voided_at IS NULL;
  INSERT INTO public.audit_events (company_id, actor_user_id, action, entity_type, entity_id, details)
  VALUES (_company_id, auth.uid(), 'exchange_rate.void', 'exchange_rate', _rate_id, '{}'::jsonb);
END;
$$;

GRANT EXECUTE ON FUNCTION public.void_exchange_rate(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.lookup_fx_rate_to_base(
  _company_id UUID,
  _from_currency CHAR(3),
  _as_of DATE
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _base CHAR(3);
  _rate NUMERIC(18, 8);
BEGIN
  SELECT base_currency INTO _base FROM public.companies WHERE id = _company_id;
  IF _base IS NULL THEN RAISE EXCEPTION 'Company not found'; END IF;
  IF UPPER(_from_currency) = UPPER(_base) THEN RETURN 1; END IF;

  SELECT rate INTO _rate
  FROM public.exchange_rates
  WHERE company_id = _company_id
    AND from_currency = UPPER(_from_currency)
    AND to_currency = UPPER(_base)
    AND rate_date <= _as_of
    AND voided_at IS NULL
  ORDER BY rate_date DESC
  LIMIT 1;

  IF _rate IS NULL THEN
    RAISE EXCEPTION 'No exchange rate for % → % on or before %', _from_currency, _base, _as_of;
  END IF;
  RETURN _rate;
END;
$$;

GRANT EXECUTE ON FUNCTION public.lookup_fx_rate_to_base(UUID, CHAR, DATE) TO authenticated;

-- ---------------------------------------------------------------------------
-- System FX gain/loss accounts on CoA seed
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.seed_fx_accounts(_company_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.accounts (company_id, code, name, account_type, normal_balance, is_system, is_postable)
  VALUES
    (_company_id, '7700', 'Realised FX gains', 'income', 'credit', true, true),
    (_company_id, '7710', 'Realised FX losses', 'expense', 'debit', true, true),
    (_company_id, '7720', 'Unrealised FX gains', 'income', 'credit', true, true),
    (_company_id, '7730', 'Unrealised FX losses', 'expense', 'debit', true, true)
  ON CONFLICT (company_id, code) DO NOTHING;
END;
$$;

-- Best-effort: seed for existing companies that already have CoA
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT DISTINCT company_id FROM public.accounts LOOP
    PERFORM public.seed_fx_accounts(r.company_id);
  END LOOP;
EXCEPTION WHEN undefined_table THEN
  NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Audit helper (admin / settings actions)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_audit_event(
  _company_id UUID,
  _action TEXT,
  _entity_type TEXT,
  _entity_id UUID DEFAULT NULL,
  _details JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _id UUID;
  _safe JSONB;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'Not a member of this company';
  END IF;
  -- Strip common secret keys if callers pass them accidentally
  _safe := COALESCE(_details, '{}'::jsonb)
    - 'password' - 'token' - 'secret' - 'api_key' - 'access_token' - 'refresh_token';

  INSERT INTO public.audit_events (company_id, actor_user_id, action, entity_type, entity_id, details)
  VALUES (_company_id, auth.uid(), _action, _entity_type, _entity_id, _safe)
  RETURNING id INTO _id;
  RETURN _id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_audit_event(UUID, TEXT, TEXT, UUID, JSONB) TO authenticated;

-- ---------------------------------------------------------------------------
-- Block base currency change once journals exist
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_base_currency_change_after_post()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.base_currency IS DISTINCT FROM OLD.base_currency THEN
    IF EXISTS (SELECT 1 FROM public.journals WHERE company_id = OLD.id LIMIT 1) THEN
      RAISE EXCEPTION 'Base currency cannot change after journals have been posted';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS companies_base_currency_lock ON public.companies;
CREATE TRIGGER companies_base_currency_lock
  BEFORE UPDATE ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.prevent_base_currency_change_after_post();

-- ---------------------------------------------------------------------------
-- Demo company reset (isolated to is_demo companies only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reset_demo_company(_company_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _is_demo BOOLEAN;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  SELECT is_demo INTO _is_demo FROM public.companies WHERE id = _company_id;
  IF _is_demo IS NULL THEN RAISE EXCEPTION 'Company not found'; END IF;
  IF NOT _is_demo THEN
    RAISE EXCEPTION 'reset_demo_company denied: company is not a demo company';
  END IF;
  IF NOT public.has_company_permission(_company_id, 'demo.reset') THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;

  PERFORM set_config('linkbooks.trusted', 'on', true);

  -- Transactional / document data only — never touch other companies
  DELETE FROM public.journal_lines WHERE journal_id IN (
    SELECT id FROM public.journals WHERE company_id = _company_id
  );
  DELETE FROM public.journals WHERE company_id = _company_id;
  DELETE FROM public.audit_events WHERE company_id = _company_id;

  -- Module tables (safe if absent)
  BEGIN DELETE FROM public.bank_transactions WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.bank_transfers WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.bank_rules WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.sales_invoice_lines WHERE invoice_id IN (SELECT id FROM public.sales_invoices WHERE company_id = _company_id); EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.sales_invoices WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.sales_credit_notes WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.sales_receipts WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.sales_quotes WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.purchase_bill_lines WHERE bill_id IN (SELECT id FROM public.purchase_bills WHERE company_id = _company_id); EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.purchase_bills WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.purchase_payments WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.purchase_expenses WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.purchase_credit_notes WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.contacts WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.exchange_rates WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;
  BEGIN DELETE FROM public.document_sequences WHERE company_id = _company_id; EXCEPTION WHEN undefined_table THEN NULL; END;

  -- Re-seed masters (same engine as real orgs)
  PERFORM public.seed_default_chart_of_accounts(_company_id);
  PERFORM public.seed_default_accounting_periods(_company_id);
  PERFORM public.seed_fx_accounts(_company_id);

  INSERT INTO public.document_sequences (company_id, document_type, prefix, next_number, padding)
  VALUES
    (_company_id, 'sales_invoice', 'INV-', 1, 4),
    (_company_id, 'purchase_bill', 'BILL-', 1, 4),
    (_company_id, 'sales_quote', 'QU-', 1, 4),
    (_company_id, 'sales_credit_note', 'SCN-', 1, 4),
    (_company_id, 'purchase_credit_note', 'PCN-', 1, 4)
  ON CONFLICT (company_id, document_type) DO UPDATE
    SET next_number = 1, prefix = EXCLUDED.prefix, padding = EXCLUDED.padding;

  INSERT INTO public.audit_events (company_id, actor_user_id, action, entity_type, entity_id, details)
  VALUES (_company_id, auth.uid(), 'demo.reset', 'company', _company_id, '{"scope":"demo_only"}'::jsonb);

  PERFORM set_config('linkbooks.trusted', 'off', true);
END;
$$;

GRANT EXECUTE ON FUNCTION public.reset_demo_company(UUID) TO authenticated;

-- Ensure demo create also seeds FX accounts (wrap existing behaviour)
CREATE OR REPLACE FUNCTION public.create_demo_company()
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _uid UUID := auth.uid();
  _id UUID;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  SELECT id INTO _id FROM public.companies WHERE created_by = _uid AND is_demo;
  PERFORM set_config('linkbooks.trusted', 'on', true);

  IF _id IS NULL THEN
    INSERT INTO public.companies (name, legal_name, country_code, base_currency,
      fiscal_year_end_month, fiscal_year_end_day, timezone, is_demo, created_by)
    VALUES ('Demo Company Ltd', 'Demo Company Ltd (fictional)', 'GB', 'GBP', 3, 31, 'Europe/London', true, _uid)
    RETURNING id INTO _id;
    INSERT INTO public.company_tax_settings (company_id, tax_regime, prices_include_tax, filing_frequency)
      VALUES (_id, 'vat', false, 'quarterly');
    INSERT INTO public.company_members (company_id, user_id, role, status) VALUES (_id, _uid, 'owner', 'active');
    PERFORM public.seed_default_chart_of_accounts(_id);
    PERFORM public.seed_default_accounting_periods(_id);
    PERFORM public.seed_fx_accounts(_id);
  ELSE
    PERFORM public.seed_default_chart_of_accounts(_id);
    PERFORM public.seed_default_accounting_periods(_id);
    PERFORM public.seed_fx_accounts(_id);
  END IF;

  UPDATE public.profiles SET last_company_id = _id WHERE id = _uid;
  PERFORM set_config('linkbooks.trusted', 'off', true);
  RETURN _id;
END;
$$;

-- Seed default sequences for existing companies
INSERT INTO public.document_sequences (company_id, document_type, prefix, next_number, padding)
SELECT c.id, d.document_type, d.prefix, 1, 4
FROM public.companies c
CROSS JOIN (VALUES
  ('sales_invoice', 'INV-'),
  ('purchase_bill', 'BILL-'),
  ('sales_quote', 'QU-'),
  ('sales_credit_note', 'SCN-'),
  ('purchase_credit_note', 'PCN-')
) AS d(document_type, prefix)
ON CONFLICT DO NOTHING;
