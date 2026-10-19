-- Tax masters, firm/client, tax settings extensions
-- Depends on companies + accounting engine. Additive. No prod apply without approval.

-- ---------------------------------------------------------------------------
-- Tax settings extensions
-- ---------------------------------------------------------------------------
ALTER TABLE public.company_tax_settings
  ADD COLUMN IF NOT EXISTS tax_basis TEXT NOT NULL DEFAULT 'invoice'
    CHECK (tax_basis IN ('invoice', 'cash'));
ALTER TABLE public.company_tax_settings
  ADD COLUMN IF NOT EXISTS jurisdiction_code TEXT;
ALTER TABLE public.company_tax_settings
  ADD COLUMN IF NOT EXISTS default_sales_tax_code_id UUID;
ALTER TABLE public.company_tax_settings
  ADD COLUMN IF NOT EXISTS default_purchase_tax_code_id UUID;
ALTER TABLE public.company_tax_settings
  ADD COLUMN IF NOT EXISTS output_tax_account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL;
ALTER TABLE public.company_tax_settings
  ADD COLUMN IF NOT EXISTS input_tax_account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Tax rates & codes (org-specific; effective-dated)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tax_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  rate_bps INTEGER NOT NULL CHECK (rate_bps >= 0 AND rate_bps <= 10000),
  effective_from DATE NOT NULL,
  effective_to DATE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tax_rates_name_nonempty CHECK (length(trim(name)) > 0),
  CONSTRAINT tax_rates_effective_range CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE INDEX IF NOT EXISTS tax_rates_company_idx ON public.tax_rates (company_id, is_active, effective_from);

CREATE TABLE IF NOT EXISTS public.tax_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  tax_rate_id UUID NOT NULL REFERENCES public.tax_rates(id) ON DELETE RESTRICT,
  tax_account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL,
  applies_to TEXT NOT NULL DEFAULT 'both' CHECK (applies_to IN ('sales', 'purchases', 'both')),
  is_recoverable BOOLEAN NOT NULL DEFAULT true,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tax_codes_code_nonempty CHECK (length(trim(code)) > 0),
  UNIQUE (company_id, code)
);

CREATE INDEX IF NOT EXISTS tax_codes_company_idx ON public.tax_codes (company_id, is_active);

ALTER TABLE public.company_tax_settings
  DROP CONSTRAINT IF EXISTS company_tax_settings_default_sales_tax_code_id_fkey;
ALTER TABLE public.company_tax_settings
  ADD CONSTRAINT company_tax_settings_default_sales_tax_code_id_fkey
  FOREIGN KEY (default_sales_tax_code_id) REFERENCES public.tax_codes(id) ON DELETE SET NULL;
ALTER TABLE public.company_tax_settings
  DROP CONSTRAINT IF EXISTS company_tax_settings_default_purchase_tax_code_id_fkey;
ALTER TABLE public.company_tax_settings
  ADD CONSTRAINT company_tax_settings_default_purchase_tax_code_id_fkey
  FOREIGN KEY (default_purchase_tax_code_id) REFERENCES public.tax_codes(id) ON DELETE SET NULL;

ALTER TABLE public.tax_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tax_codes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members view tax rates" ON public.tax_rates;
CREATE POLICY "Members view tax rates" ON public.tax_rates FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
DROP POLICY IF EXISTS "Tax settings write rates" ON public.tax_rates;
CREATE POLICY "Tax settings write rates" ON public.tax_rates FOR INSERT TO authenticated
  WITH CHECK (public.has_company_permission(company_id, 'tax.settings'));
DROP POLICY IF EXISTS "Tax settings update rates" ON public.tax_rates;
CREATE POLICY "Tax settings update rates" ON public.tax_rates FOR UPDATE TO authenticated
  USING (public.has_company_permission(company_id, 'tax.settings'))
  WITH CHECK (public.has_company_permission(company_id, 'tax.settings'));

DROP POLICY IF EXISTS "Members view tax codes" ON public.tax_codes;
CREATE POLICY "Members view tax codes" ON public.tax_codes FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
DROP POLICY IF EXISTS "Tax settings write codes" ON public.tax_codes;
CREATE POLICY "Tax settings write codes" ON public.tax_codes FOR INSERT TO authenticated
  WITH CHECK (public.has_company_permission(company_id, 'tax.settings'));
DROP POLICY IF EXISTS "Tax settings update codes" ON public.tax_codes;
CREATE POLICY "Tax settings update codes" ON public.tax_codes FOR UPDATE TO authenticated
  USING (public.has_company_permission(company_id, 'tax.settings'))
  WITH CHECK (public.has_company_permission(company_id, 'tax.settings'));

-- Allow tax.settings to update company_tax_settings (was owners/admins only)
DROP POLICY IF EXISTS "Tax settings editors can update tax settings" ON public.company_tax_settings;
CREATE POLICY "Tax settings editors can update tax settings" ON public.company_tax_settings
  FOR UPDATE TO authenticated
  USING (
    public.has_company_permission(company_id, 'tax.settings')
    OR public.has_company_permission(company_id, 'company.settings.edit')
  )
  WITH CHECK (
    public.has_company_permission(company_id, 'tax.settings')
    OR public.has_company_permission(company_id, 'company.settings.edit')
  );

-- ---------------------------------------------------------------------------
-- Firm / client management
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.firms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT firms_name_nonempty CHECK (length(trim(name)) > 0)
);

DO $$ BEGIN
  CREATE TYPE public.firm_member_role AS ENUM ('owner', 'admin', 'member');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.firm_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID NOT NULL REFERENCES public.firms(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.firm_member_role NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (firm_id, user_id)
);

DO $$ BEGIN
  CREATE TYPE public.firm_access_level AS ENUM ('view', 'bookkeep', 'full');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.firm_client_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID NOT NULL REFERENCES public.firms(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  access_level public.firm_access_level NOT NULL DEFAULT 'view',
  linked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (firm_id, company_id)
);

CREATE INDEX IF NOT EXISTS firm_members_user_idx ON public.firm_members (user_id);
CREATE INDEX IF NOT EXISTS firm_client_links_company_idx ON public.firm_client_links (company_id);

ALTER TABLE public.firms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firm_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.firm_client_links ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_firm_member(_firm_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.firm_members
    WHERE firm_id = _firm_id AND user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.is_firm_admin(_firm_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.firm_members
    WHERE firm_id = _firm_id AND user_id = auth.uid()
      AND role IN ('owner', 'admin')
  );
$$;

DROP POLICY IF EXISTS "Firm members view firm" ON public.firms;
CREATE POLICY "Firm members view firm" ON public.firms FOR SELECT TO authenticated
  USING (public.is_firm_member(id));
DROP POLICY IF EXISTS "Authenticated create firm" ON public.firms;
CREATE POLICY "Authenticated create firm" ON public.firms FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid());
DROP POLICY IF EXISTS "Firm admins update firm" ON public.firms;
CREATE POLICY "Firm admins update firm" ON public.firms FOR UPDATE TO authenticated
  USING (public.is_firm_admin(id));

DROP POLICY IF EXISTS "Firm members view members" ON public.firm_members;
CREATE POLICY "Firm members view members" ON public.firm_members FOR SELECT TO authenticated
  USING (public.is_firm_member(firm_id));
DROP POLICY IF EXISTS "Firm admins insert members" ON public.firm_members;
CREATE POLICY "Firm admins insert members" ON public.firm_members FOR INSERT TO authenticated
  WITH CHECK (public.is_firm_admin(firm_id) OR user_id = auth.uid());
DROP POLICY IF EXISTS "Firm admins update members" ON public.firm_members;
CREATE POLICY "Firm admins update members" ON public.firm_members FOR UPDATE TO authenticated
  USING (public.is_firm_admin(firm_id));

DROP POLICY IF EXISTS "Firm members view links" ON public.firm_client_links;
CREATE POLICY "Firm members view links" ON public.firm_client_links FOR SELECT TO authenticated
  USING (public.is_firm_member(firm_id)
    OR public.is_company_member(company_id));
DROP POLICY IF EXISTS "Firm admins manage links" ON public.firm_client_links;
CREATE POLICY "Firm admins manage links" ON public.firm_client_links FOR INSERT TO authenticated
  WITH CHECK (public.is_firm_admin(firm_id));
DROP POLICY IF EXISTS "Firm admins update links" ON public.firm_client_links;
CREATE POLICY "Firm admins update links" ON public.firm_client_links FOR UPDATE TO authenticated
  USING (public.is_firm_admin(firm_id) OR public.has_company_permission(company_id, 'company.settings.edit'));

-- Seed helper: default UK-style VAT rates when regime is vat (opt-in via RPC)
CREATE OR REPLACE FUNCTION public.seed_default_tax_pack(_company_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _regime TEXT;
  _std UUID;
  _zero UUID;
BEGIN
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT public.has_company_permission(_company_id, 'tax.settings') THEN
    RAISE EXCEPTION 'Missing tax.settings permission';
  END IF;

  SELECT tax_regime INTO _regime FROM public.company_tax_settings WHERE company_id = _company_id;
  IF _regime IS NULL OR _regime = 'none' THEN
    RETURN;
  END IF;

  -- Only seed if no rates exist
  IF EXISTS (SELECT 1 FROM public.tax_rates WHERE company_id = _company_id) THEN
    RETURN;
  END IF;

  IF _regime = 'vat' THEN
    INSERT INTO public.tax_rates (company_id, name, rate_bps, effective_from)
    VALUES (_company_id, 'Standard VAT', 2000, '1973-04-01')
    RETURNING id INTO _std;
    INSERT INTO public.tax_rates (company_id, name, rate_bps, effective_from)
    VALUES (_company_id, 'Zero-rated', 0, '1973-04-01')
    RETURNING id INTO _zero;
    INSERT INTO public.tax_codes (company_id, code, name, tax_rate_id, applies_to)
    VALUES
      (_company_id, 'VAT20', 'Standard rated sales/purchases', _std, 'both'),
      (_company_id, 'VAT0', 'Zero-rated', _zero, 'both');
  ELSIF _regime = 'gst' THEN
    INSERT INTO public.tax_rates (company_id, name, rate_bps, effective_from)
    VALUES (_company_id, 'Standard GST', 1000, '2000-07-01')
    RETURNING id INTO _std;
    INSERT INTO public.tax_codes (company_id, code, name, tax_rate_id, applies_to)
    VALUES (_company_id, 'GST10', 'Standard GST', _std, 'both');
  END IF;
  -- sales_tax / other: no auto seed — configure rates explicitly
END;
$$;
