-- Multi-country tax framework: treatments, pack metadata, line tax_code_id, richer seed.
-- Additive. Does not rewrite posted journals or historical tax amounts.

ALTER TABLE public.company_tax_settings
  ADD COLUMN IF NOT EXISTS registration_date DATE,
  ADD COLUMN IF NOT EXISTS registration_end_date DATE,
  ADD COLUMN IF NOT EXISTS applied_pack_id TEXT,
  ADD COLUMN IF NOT EXISTS applied_pack_version TEXT,
  ADD COLUMN IF NOT EXISTS non_recoverable_tax_account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL;

ALTER TABLE public.tax_rates
  ADD COLUMN IF NOT EXISTS code TEXT,
  ADD COLUMN IF NOT EXISTS treatment TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS applies_to TEXT NOT NULL DEFAULT 'both',
  ADD COLUMN IF NOT EXISTS jurisdiction_code TEXT,
  ADD COLUMN IF NOT EXISTS source_note TEXT;

ALTER TABLE public.tax_rates
  DROP CONSTRAINT IF EXISTS tax_rates_treatment_check;
ALTER TABLE public.tax_rates
  ADD CONSTRAINT tax_rates_treatment_check
  CHECK (treatment IN (
    'standard', 'reduced', 'zero_rated', 'exempt', 'outside_scope', 'no_tax', 'reverse_charge'
  ));

ALTER TABLE public.tax_rates
  DROP CONSTRAINT IF EXISTS tax_rates_applies_to_check;
ALTER TABLE public.tax_rates
  ADD CONSTRAINT tax_rates_applies_to_check
  CHECK (applies_to IN ('sales', 'purchases', 'both'));

ALTER TABLE public.tax_codes
  ADD COLUMN IF NOT EXISTS treatment TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS reporting_class TEXT,
  ADD COLUMN IF NOT EXISTS description TEXT;

ALTER TABLE public.tax_codes
  DROP CONSTRAINT IF EXISTS tax_codes_treatment_check;
ALTER TABLE public.tax_codes
  ADD CONSTRAINT tax_codes_treatment_check
  CHECK (treatment IN (
    'standard', 'reduced', 'zero_rated', 'exempt', 'outside_scope', 'no_tax', 'reverse_charge'
  ));

-- Optional tax code on document lines (bps remain authoritative snapshot)
ALTER TABLE public.sales_invoice_lines
  ADD COLUMN IF NOT EXISTS tax_code_id UUID REFERENCES public.tax_codes(id) ON DELETE SET NULL;
ALTER TABLE public.purchase_bill_lines
  ADD COLUMN IF NOT EXISTS tax_code_id UUID REFERENCES public.tax_codes(id) ON DELETE SET NULL;

-- Applied pack audit per company
CREATE TABLE IF NOT EXISTS public.company_tax_pack_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  pack_id TEXT NOT NULL,
  pack_version TEXT NOT NULL,
  verification_status TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS company_tax_pack_applications_company_idx
  ON public.company_tax_pack_applications (company_id, applied_at DESC);

ALTER TABLE public.company_tax_pack_applications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members view tax pack applications" ON public.company_tax_pack_applications;
CREATE POLICY "Members view tax pack applications" ON public.company_tax_pack_applications
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));
DROP POLICY IF EXISTS "Tax managers insert pack applications" ON public.company_tax_pack_applications;
CREATE POLICY "Tax managers insert pack applications" ON public.company_tax_pack_applications
  FOR INSERT TO authenticated
  WITH CHECK (public.has_company_permission(company_id, 'tax.settings'));

-- Idempotent country-aware seed (never overwrites existing codes by code)
CREATE OR REPLACE FUNCTION public.seed_country_tax_pack(
  _company_id UUID,
  _pack_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _regime TEXT;
  _country TEXT;
  _pack TEXT;
  _added_rates INT := 0;
  _added_codes INT := 0;
  _rate_std UUID;
  _rate_zero UUID;
  _rate_red UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF NOT public.has_company_permission(_company_id, 'tax.settings') THEN
    RAISE EXCEPTION 'Missing tax.settings permission';
  END IF;

  SELECT cts.tax_regime, c.country_code
  INTO _regime, _country
  FROM public.company_tax_settings cts
  JOIN public.companies c ON c.id = cts.company_id
  WHERE cts.company_id = _company_id;

  IF _regime IS NULL THEN RAISE EXCEPTION 'Tax settings not found'; END IF;

  _pack := COALESCE(NULLIF(trim(_pack_id), ''), CASE
    WHEN _country = 'GB' AND _regime = 'vat' THEN 'gb_vat_config'
    WHEN _country = 'AU' AND _regime = 'gst' THEN 'au_gst_config'
    WHEN _country = 'NZ' AND _regime = 'gst' THEN 'nz_gst_config'
    WHEN _country = 'SG' AND _regime = 'gst' THEN 'sg_gst_config'
    WHEN _country = 'ZA' AND _regime = 'vat' THEN 'za_vat_config'
    WHEN _country = 'AE' AND _regime = 'vat' THEN 'ae_vat_config'
    WHEN _country = 'IN' AND _regime = 'gst' THEN 'in_gst_config'
    WHEN _country IN ('US','CA') AND _regime = 'sales_tax' THEN 'na_sales_tax_manual'
    WHEN _regime = 'vat' THEN 'generic_vat'
    WHEN _regime = 'gst' THEN 'generic_gst'
    ELSE 'generic_none'
  END);

  -- GB / generic VAT
  IF _pack IN ('gb_vat_config', 'generic_vat') THEN
    IF NOT EXISTS (SELECT 1 FROM public.tax_rates WHERE company_id = _company_id AND name = 'Standard VAT') THEN
      INSERT INTO public.tax_rates (company_id, name, code, rate_bps, effective_from, treatment, applies_to, source_note)
      VALUES (_company_id, 'Standard VAT', 'STD', 2000, CURRENT_DATE, 'standard', 'both',
        'Starter config rate — verify against current HMRC rates before use')
      RETURNING id INTO _rate_std;
      _added_rates := _added_rates + 1;
    ELSE
      SELECT id INTO _rate_std FROM public.tax_rates WHERE company_id = _company_id AND name = 'Standard VAT' LIMIT 1;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.tax_rates WHERE company_id = _company_id AND name = 'Zero-rated') THEN
      INSERT INTO public.tax_rates (company_id, name, code, rate_bps, effective_from, treatment, applies_to, source_note)
      VALUES (_company_id, 'Zero-rated', 'ZERO', 0, CURRENT_DATE, 'zero_rated', 'both', 'Zero-rated supplies (not exempt)')
      RETURNING id INTO _rate_zero;
      _added_rates := _added_rates + 1;
    ELSE
      SELECT id INTO _rate_zero FROM public.tax_rates WHERE company_id = _company_id AND name = 'Zero-rated' LIMIT 1;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.tax_rates WHERE company_id = _company_id AND name = 'Reduced VAT') THEN
      INSERT INTO public.tax_rates (company_id, name, code, rate_bps, effective_from, treatment, applies_to, source_note)
      VALUES (_company_id, 'Reduced VAT', 'RED', 500, CURRENT_DATE, 'reduced', 'both',
        'UK reduced rate starter — verify applicability')
      RETURNING id INTO _rate_red;
      _added_rates := _added_rates + 1;
    END IF;
    IF _rate_std IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.tax_codes WHERE company_id = _company_id AND code = 'VAT20') THEN
      INSERT INTO public.tax_codes (company_id, code, name, tax_rate_id, applies_to, is_recoverable, treatment, reporting_class)
      VALUES (_company_id, 'VAT20', 'Standard rated', _rate_std, 'both', true, 'standard', 'output_standard');
      _added_codes := _added_codes + 1;
    END IF;
    IF _rate_zero IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.tax_codes WHERE company_id = _company_id AND code = 'VAT0') THEN
      INSERT INTO public.tax_codes (company_id, code, name, tax_rate_id, applies_to, is_recoverable, treatment, reporting_class)
      VALUES (_company_id, 'VAT0', 'Zero-rated', _rate_zero, 'both', true, 'zero_rated', 'zero_rated');
      _added_codes := _added_codes + 1;
    END IF;
    IF _rate_zero IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.tax_codes WHERE company_id = _company_id AND code = 'EXEMPT') THEN
      INSERT INTO public.tax_codes (company_id, code, name, tax_rate_id, applies_to, is_recoverable, treatment, reporting_class, description)
      VALUES (_company_id, 'EXEMPT', 'Exempt', _rate_zero, 'both', false, 'exempt', 'exempt',
        'Exempt is not the same as zero-rated');
      _added_codes := _added_codes + 1;
    END IF;
    IF _rate_zero IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.tax_codes WHERE company_id = _company_id AND code = 'OS') THEN
      INSERT INTO public.tax_codes (company_id, code, name, tax_rate_id, applies_to, is_recoverable, treatment, reporting_class, description)
      VALUES (_company_id, 'OS', 'Outside scope', _rate_zero, 'both', false, 'outside_scope', 'outside_scope',
        'Outside the scope of VAT');
      _added_codes := _added_codes + 1;
    END IF;
  ELSIF _pack IN ('au_gst_config', 'nz_gst_config', 'sg_gst_config', 'generic_gst') THEN
    IF NOT EXISTS (SELECT 1 FROM public.tax_rates WHERE company_id = _company_id AND name = 'Standard GST') THEN
      INSERT INTO public.tax_rates (company_id, name, code, rate_bps, effective_from, treatment, applies_to, source_note)
      VALUES (_company_id, 'Standard GST', 'GST',
        CASE WHEN _pack = 'sg_gst_config' THEN 900 ELSE 1000 END,
        CURRENT_DATE, 'standard', 'both',
        'Starter GST rate — verify against current authority rates; not a filing return');
      _added_rates := _added_rates + 1;
    END IF;
    SELECT id INTO _rate_std FROM public.tax_rates WHERE company_id = _company_id AND name = 'Standard GST' LIMIT 1;
    IF _rate_std IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.tax_codes WHERE company_id = _company_id AND code = 'GST') THEN
      INSERT INTO public.tax_codes (company_id, code, name, tax_rate_id, applies_to, is_recoverable, treatment)
      VALUES (_company_id, 'GST', 'GST taxable', _rate_std, 'both', true, 'standard');
      _added_codes := _added_codes + 1;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.tax_rates WHERE company_id = _company_id AND name = 'GST free / zero') THEN
      INSERT INTO public.tax_rates (company_id, name, code, rate_bps, effective_from, treatment, applies_to)
      VALUES (_company_id, 'GST free / zero', 'GST0', 0, CURRENT_DATE, 'zero_rated', 'both');
      _added_rates := _added_rates + 1;
    END IF;
  ELSIF _pack IN ('za_vat_config', 'ae_vat_config') THEN
    IF NOT EXISTS (SELECT 1 FROM public.tax_rates WHERE company_id = _company_id AND name = 'Standard VAT') THEN
      INSERT INTO public.tax_rates (company_id, name, code, rate_bps, effective_from, treatment, applies_to, source_note)
      VALUES (_company_id, 'Standard VAT', 'STD',
        CASE WHEN _pack = 'ae_vat_config' THEN 500 ELSE 1500 END,
        CURRENT_DATE, 'standard', 'both', 'Starter rate — verify before use');
      _added_rates := _added_rates + 1;
    END IF;
  ELSIF _pack = 'in_gst_config' THEN
    -- Component placeholders at 0 — organisation must configure CGST/SGST/IGST; no invented rates
    IF NOT EXISTS (SELECT 1 FROM public.tax_rates WHERE company_id = _company_id AND name = 'IGST placeholder') THEN
      INSERT INTO public.tax_rates (company_id, name, code, rate_bps, effective_from, treatment, applies_to, source_note)
      VALUES (_company_id, 'IGST placeholder', 'IGST', 0, CURRENT_DATE, 'standard', 'both',
        'India GST components require organisation configuration — no default rate invented');
      _added_rates := _added_rates + 1;
    END IF;
  ELSIF _pack = 'na_sales_tax_manual' THEN
    -- No national rate seeded for US/CA
    NULL;
  END IF;

  UPDATE public.company_tax_settings
  SET applied_pack_id = _pack,
      applied_pack_version = '2026.10.1',
      updated_at = now()
  WHERE company_id = _company_id;

  INSERT INTO public.company_tax_pack_applications (company_id, pack_id, pack_version, verification_status, applied_by, details)
  VALUES (
    _company_id, _pack, '2026.10.1', 'draft_config',
    auth.uid(),
    jsonb_build_object('added_rates', _added_rates, 'added_codes', _added_codes)
  );

  RETURN jsonb_build_object(
    'pack_id', _pack,
    'added_rates', _added_rates,
    'added_codes', _added_codes,
    'verification_status', 'draft_config'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.seed_country_tax_pack(UUID, TEXT) TO authenticated;

-- Keep legacy seed as wrapper
CREATE OR REPLACE FUNCTION public.seed_default_tax_pack(_company_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.seed_country_tax_pack(_company_id, NULL);
END;
$$;
