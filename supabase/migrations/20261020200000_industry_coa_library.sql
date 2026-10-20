-- Industry CoA library: settings, tracking dimensions, account metadata, system protection.
-- Additive. Does not wipe existing accounts or balances. Template apply is app-side (idempotent inserts).

-- ---------------------------------------------------------------------------
-- Extend accounts with catalog / FS metadata (nullable; existing rows unchanged)
-- ---------------------------------------------------------------------------
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS catalog_key TEXT,
  ADD COLUMN IF NOT EXISTS recommendation_level TEXT,
  ADD COLUMN IF NOT EXISTS fs_line TEXT,
  ADD COLUMN IF NOT EXISTS cash_flow_class TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'system';

CREATE UNIQUE INDEX IF NOT EXISTS accounts_company_catalog_key_uidx
  ON public.accounts (company_id, catalog_key)
  WHERE catalog_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS accounts_company_fs_line_idx
  ON public.accounts (company_id, fs_line);

COMMENT ON COLUMN public.accounts.catalog_key IS 'Stable library identity when created from industry catalogue';
COMMENT ON COLUMN public.accounts.fs_line IS 'Canonical financial-statement line (reporting layer)';
COMMENT ON COLUMN public.accounts.source IS 'system | industry | optional | manual';

-- Protect system/control codes and non-postable retained earnings from destructive edits
CREATE OR REPLACE FUNCTION public.protect_system_accounts()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.is_system OR OLD.is_control THEN
      IF NEW.code IS DISTINCT FROM OLD.code THEN
        RAISE EXCEPTION 'System/control account code cannot be changed';
      END IF;
      IF NEW.account_type IS DISTINCT FROM OLD.account_type THEN
        RAISE EXCEPTION 'System/control account type cannot be changed';
      END IF;
      IF NEW.is_control IS DISTINCT FROM OLD.is_control AND OLD.is_control THEN
        RAISE EXCEPTION 'Control account flag cannot be cleared';
      END IF;
      IF NEW.is_postable IS DISTINCT FROM OLD.is_postable AND OLD.is_postable = false THEN
        RAISE EXCEPTION 'Non-postable system account cannot be made postable';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_system_accounts ON public.accounts;
CREATE TRIGGER trg_protect_system_accounts
  BEFORE UPDATE ON public.accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_system_accounts();

-- ---------------------------------------------------------------------------
-- Company CoA settings (industries + detail level)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.company_coa_settings (
  company_id UUID PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  detail_level TEXT NOT NULL DEFAULT 'standard'
    CHECK (detail_level IN ('simple', 'standard', 'detailed')),
  industry_codes TEXT[] NOT NULL DEFAULT '{}',
  catalog_version TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE public.company_coa_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view coa settings" ON public.company_coa_settings;
CREATE POLICY "Members can view coa settings"
  ON public.company_coa_settings FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

DROP POLICY IF EXISTS "Managers can upsert coa settings" ON public.company_coa_settings;
CREATE POLICY "Managers can upsert coa settings"
  ON public.company_coa_settings FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'accounts.manage'))
  WITH CHECK (public.has_company_permission(company_id, 'accounts.manage'));

-- ---------------------------------------------------------------------------
-- Apply audit log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.coa_apply_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  detail_level TEXT NOT NULL,
  industry_codes TEXT[] NOT NULL DEFAULT '{}',
  catalog_version TEXT,
  created_count INT NOT NULL DEFAULT 0,
  skipped_count INT NOT NULL DEFAULT 0,
  conflict_count INT NOT NULL DEFAULT 0,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS coa_apply_events_company_idx
  ON public.coa_apply_events (company_id, created_at DESC);

ALTER TABLE public.coa_apply_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view coa apply events" ON public.coa_apply_events;
CREATE POLICY "Members can view coa apply events"
  ON public.coa_apply_events FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

DROP POLICY IF EXISTS "Managers can insert coa apply events" ON public.coa_apply_events;
CREATE POLICY "Managers can insert coa apply events"
  ON public.coa_apply_events FOR INSERT TO authenticated
  WITH CHECK (public.has_company_permission(company_id, 'accounts.manage'));

-- ---------------------------------------------------------------------------
-- Tracking categories (Fund, Mission, Ministry, …) — dimensions, not extra GL accounts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tracking_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tracking_categories_name_nonempty CHECK (length(trim(name)) > 0),
  UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS public.tracking_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES public.tracking_categories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tracking_options_name_nonempty CHECK (length(trim(name)) > 0),
  UNIQUE (category_id, name)
);

CREATE INDEX IF NOT EXISTS tracking_options_company_idx ON public.tracking_options (company_id);
CREATE INDEX IF NOT EXISTS tracking_categories_company_idx ON public.tracking_categories (company_id);

ALTER TABLE public.tracking_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tracking_options ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view tracking categories" ON public.tracking_categories;
CREATE POLICY "Members can view tracking categories"
  ON public.tracking_categories FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

DROP POLICY IF EXISTS "Managers can manage tracking categories" ON public.tracking_categories;
CREATE POLICY "Managers can manage tracking categories"
  ON public.tracking_categories FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'accounts.manage'))
  WITH CHECK (public.has_company_permission(company_id, 'accounts.manage'));

DROP POLICY IF EXISTS "Members can view tracking options" ON public.tracking_options;
CREATE POLICY "Members can view tracking options"
  ON public.tracking_options FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

DROP POLICY IF EXISTS "Managers can manage tracking options" ON public.tracking_options;
CREATE POLICY "Managers can manage tracking options"
  ON public.tracking_options FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'accounts.manage'))
  WITH CHECK (public.has_company_permission(company_id, 'accounts.manage'));

-- Reference list of industry codes (app catalogue is authoritative for account rows)
CREATE TABLE IF NOT EXISTS public.coa_industries (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  family TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT true
);

ALTER TABLE public.coa_industries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated can read coa industries" ON public.coa_industries;
CREATE POLICY "Authenticated can read coa industries"
  ON public.coa_industries FOR SELECT TO authenticated USING (true);

INSERT INTO public.coa_industries (code, name, family, description) VALUES
  ('general_professional', 'General Professional Services', 'professional_services', 'Consultants and professional firms'),
  ('accounting_bookkeeping', 'Accounting & Bookkeeping', 'professional_services', 'Accounting practices'),
  ('legal_practice', 'Legal Practice', 'professional_services', 'Law firms'),
  ('consulting_advisory', 'Consulting & Management Advisory', 'professional_services', 'Management consulting'),
  ('marketing_agency', 'Marketing & Advertising Agency', 'professional_services', 'Agencies'),
  ('it_managed_services', 'IT Consulting & Managed Services', 'professional_services', 'MSP / IT consulting'),
  ('amazon_fba', 'Amazon FBA / FBM', 'ecommerce', 'Amazon sellers'),
  ('shopify_dtc', 'Shopify / DTC Brand', 'ecommerce', 'DTC / Shopify'),
  ('multi_marketplace', 'Multi-marketplace Seller', 'ecommerce', 'Multi-channel sellers'),
  ('dropshipping', 'Dropshipping', 'ecommerce', 'Dropship sellers'),
  ('residential_rental', 'Long-term Residential Rental', 'rental_property', 'Landlords'),
  ('short_term_rental', 'Short-Term / Vacation Rentals', 'rental_property', 'STR / Airbnb'),
  ('property_management', 'Property Management', 'rental_property', 'Property managers'),
  ('hotel_hospitality', 'Hotels & Accommodation', 'hospitality_food', 'Hotels'),
  ('medical_practice', 'Medical / Specialist Practice', 'healthcare', 'Medical practices'),
  ('dental_practice', 'Dental & Orthodontic Practice', 'healthcare', 'Dental'),
  ('allied_health', 'Allied Health & Therapy', 'healthcare', 'Allied health'),
  ('veterinary', 'Veterinary Practice', 'healthcare', 'Veterinary'),
  ('general_retail', 'General Retail', 'retail_wholesale', 'Retail'),
  ('wholesale_distribution', 'Wholesale & Distribution', 'retail_wholesale', 'Wholesale'),
  ('general_contractor', 'General Contractor / Construction', 'construction', 'Contractors'),
  ('trades', 'Trades (Electrical, Plumbing, HVAC)', 'construction', 'Trades'),
  ('restaurant_cafe', 'Restaurant & Cafe', 'hospitality_food', 'Restaurants'),
  ('catering', 'Catering & Food Trucks', 'hospitality_food', 'Catering'),
  ('saas', 'SaaS / Software', 'technology', 'SaaS'),
  ('web_hosting_cloud', 'Web Hosting & Cloud Services', 'technology', 'Hosting'),
  ('general_manufacturing', 'General Manufacturing', 'manufacturing', 'Manufacturing'),
  ('freight_courier', 'Freight, Courier & Logistics', 'transport_logistics', 'Logistics'),
  ('vehicle_workshop', 'Vehicle Dealership & Repair', 'transport_logistics', 'Automotive'),
  ('tutoring_training', 'Tutoring & Training', 'education', 'Training'),
  ('online_education', 'Online Education', 'education', 'Online learning'),
  ('photography_video', 'Photography & Videography', 'media_creative', 'Creative'),
  ('event_management', 'Event Management', 'media_creative', 'Events'),
  ('salon_spa', 'Hair, Beauty & Spa', 'personal_care', 'Salons'),
  ('gym_fitness', 'Gym & Fitness', 'personal_care', 'Fitness'),
  ('farming', 'Farming & Agriculture', 'agriculture', 'Agriculture'),
  ('church_religious', 'Church & Religious Organisation', 'nonprofit_religious', 'Church / missions'),
  ('charity_nonprofit', 'Charity & Non-profit', 'nonprofit_religious', 'Charities'),
  ('cleaning_facilities', 'Cleaning & Facilities Management', 'other', 'Facilities'),
  ('holding_company', 'Holding / Management Company', 'other', 'Holding companies')
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  family = EXCLUDED.family,
  description = EXCLUDED.description,
  is_active = true;
