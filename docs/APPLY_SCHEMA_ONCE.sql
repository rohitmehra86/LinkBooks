-- Combined migrations for empty project ipxflpzfcqwtenodbxwc
-- Run once in: Dashboard → SQL Editor → New query → Run


-- ===== 20260930110603_f115456e-7584-4af4-8557-c781066d5890.sql =====
CREATE TABLE public.profiles (
  id UUID NOT NULL PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  job_title TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own profile"
  ON public.profiles FOR SELECT TO authenticated
  USING (auth.uid() = id);

CREATE POLICY "Users can insert their own profile"
  ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = id);

CREATE POLICY "Users can update their own profile"
  ON public.profiles FOR UPDATE TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER profiles_set_updated_at
BEFORE UPDATE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, email)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data ->> 'full_name', ''),
    COALESCE(NEW.email, '')
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ===== 20260930110624_7906220f-ddec-4cf7-88c9-f18c583740bc.sql =====
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- ===== 20261003014249_deb63ade-3025-4945-88ed-b76da31f1a84.sql =====
CREATE TYPE public.company_role AS ENUM ('owner','admin','accountant','bookkeeper','staff','read_only');
CREATE TYPE public.membership_status AS ENUM ('active','invited','suspended');

-- Companies
CREATE TABLE public.companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 2 AND 160),
  legal_name TEXT,
  country_code TEXT NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  base_currency TEXT NOT NULL CHECK (base_currency ~ '^[A-Z]{3}$'),
  fiscal_year_end_month SMALLINT NOT NULL CHECK (fiscal_year_end_month BETWEEN 1 AND 12),
  fiscal_year_end_day SMALLINT NOT NULL CHECK (fiscal_year_end_day BETWEEN 1 AND 31),
  timezone TEXT NOT NULL,
  is_demo BOOLEAN NOT NULL DEFAULT false,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX companies_one_demo_per_user ON public.companies (created_by) WHERE is_demo;
GRANT SELECT, UPDATE ON public.companies TO authenticated;
GRANT ALL ON public.companies TO service_role;
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;

-- Memberships
CREATE TABLE public.company_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.company_role NOT NULL,
  status public.membership_status NOT NULL DEFAULT 'active',
  invited_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, user_id)
);
CREATE INDEX company_members_user_idx ON public.company_members (user_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.company_members TO authenticated;
GRANT ALL ON public.company_members TO service_role;
ALTER TABLE public.company_members ENABLE ROW LEVEL SECURITY;

-- Tax foundation
CREATE TABLE public.company_tax_settings (
  company_id UUID PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  tax_regime TEXT NOT NULL DEFAULT 'none' CHECK (tax_regime IN ('none','vat','gst','sales_tax','other')),
  registration_number TEXT,
  prices_include_tax BOOLEAN NOT NULL DEFAULT false,
  filing_frequency TEXT CHECK (filing_frequency IN ('monthly','quarterly','half_yearly','annually')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, UPDATE ON public.company_tax_settings TO authenticated;
GRANT ALL ON public.company_tax_settings TO service_role;
ALTER TABLE public.company_tax_settings ENABLE ROW LEVEL SECURITY;

-- Invitations (prepared only)
CREATE TABLE public.company_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role public.company_role NOT NULL CHECK (role <> 'owner'),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  invited_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, DELETE ON public.company_invitations TO authenticated;
GRANT ALL ON public.company_invitations TO service_role;
ALTER TABLE public.company_invitations ENABLE ROW LEVEL SECURITY;

-- Role -> permission catalogue
CREATE TABLE public.role_permissions (
  role public.company_role NOT NULL,
  permission TEXT NOT NULL,
  PRIMARY KEY (role, permission)
);
GRANT SELECT ON public.role_permissions TO authenticated;
GRANT ALL ON public.role_permissions TO service_role;
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Signed-in users can read the permission catalogue"
  ON public.role_permissions FOR SELECT TO authenticated USING (true);

INSERT INTO public.role_permissions (role, permission) VALUES
  ('owner','company.view'),('owner','company.settings.edit'),('owner','members.view'),('owner','members.manage'),('owner','members.grant_owner'),('owner','billing.manage'),('owner','accounting.view'),('owner','accounting.post'),
  ('admin','company.view'),('admin','company.settings.edit'),('admin','members.view'),('admin','members.manage'),('admin','accounting.view'),('admin','accounting.post'),
  ('accountant','company.view'),('accountant','members.view'),('accountant','accounting.view'),('accountant','accounting.post'),
  ('bookkeeper','company.view'),('bookkeeper','members.view'),('bookkeeper','accounting.view'),('bookkeeper','accounting.post'),
  ('staff','company.view'),('staff','accounting.view'),
  ('read_only','company.view'),('read_only','accounting.view');

-- Remember the selected company
ALTER TABLE public.profiles
  ADD COLUMN last_company_id UUID REFERENCES public.companies(id) ON DELETE SET NULL;

-- Security helpers (definer to avoid recursive RLS)
CREATE OR REPLACE FUNCTION public.is_company_member(_company_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.company_members
    WHERE company_id = _company_id AND user_id = auth.uid() AND status = 'active'
  )
$$;

CREATE OR REPLACE FUNCTION public.has_company_role(_company_id UUID, _roles public.company_role[])
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.company_members
    WHERE company_id = _company_id AND user_id = auth.uid() AND status = 'active' AND role = ANY(_roles)
  )
$$;

CREATE OR REPLACE FUNCTION public.has_company_permission(_company_id UUID, _permission TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.company_members m
    JOIN public.role_permissions rp ON rp.role = m.role
    WHERE m.company_id = _company_id AND m.user_id = auth.uid() AND m.status = 'active'
      AND rp.permission = _permission
  )
$$;

REVOKE ALL ON FUNCTION public.is_company_member(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.has_company_role(UUID, public.company_role[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.has_company_permission(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_company_member(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_company_role(UUID, public.company_role[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_company_permission(UUID, TEXT) TO authenticated;

-- Policies: companies
CREATE POLICY "Members can view their companies" ON public.companies
  FOR SELECT TO authenticated USING (public.is_company_member(id));
CREATE POLICY "Owners and admins can edit their company" ON public.companies
  FOR UPDATE TO authenticated
  USING (public.has_company_role(id, ARRAY['owner','admin']::public.company_role[]))
  WITH CHECK (public.has_company_role(id, ARRAY['owner','admin']::public.company_role[]));

-- Policies: members
CREATE POLICY "Members can view fellow members" ON public.company_members
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));
CREATE POLICY "Owners and admins can add members" ON public.company_members
  FOR INSERT TO authenticated
  WITH CHECK (public.has_company_role(company_id, ARRAY['owner','admin']::public.company_role[]));
CREATE POLICY "Owners and admins can change members" ON public.company_members
  FOR UPDATE TO authenticated
  USING (public.has_company_role(company_id, ARRAY['owner','admin']::public.company_role[]))
  WITH CHECK (public.has_company_role(company_id, ARRAY['owner','admin']::public.company_role[]));
CREATE POLICY "Owners and admins can remove members" ON public.company_members
  FOR DELETE TO authenticated
  USING (public.has_company_role(company_id, ARRAY['owner','admin']::public.company_role[]));

-- Policies: tax settings
CREATE POLICY "Members can view tax settings" ON public.company_tax_settings
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));
CREATE POLICY "Owners and admins can edit tax settings" ON public.company_tax_settings
  FOR UPDATE TO authenticated
  USING (public.has_company_role(company_id, ARRAY['owner','admin']::public.company_role[]))
  WITH CHECK (public.has_company_role(company_id, ARRAY['owner','admin']::public.company_role[]));

-- Policies: invitations
CREATE POLICY "Owners and admins can view invitations" ON public.company_invitations
  FOR SELECT TO authenticated
  USING (public.has_company_role(company_id, ARRAY['owner','admin']::public.company_role[]));
CREATE POLICY "Owners and admins can create invitations" ON public.company_invitations
  FOR INSERT TO authenticated
  WITH CHECK (public.has_company_role(company_id, ARRAY['owner','admin']::public.company_role[]));
CREATE POLICY "Owners and admins can cancel invitations" ON public.company_invitations
  FOR DELETE TO authenticated
  USING (public.has_company_role(company_id, ARRAY['owner','admin']::public.company_role[]));

-- Guard: immutable company fields
CREATE OR REPLACE FUNCTION public.companies_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.is_demo IS DISTINCT FROM OLD.is_demo THEN
    RAISE EXCEPTION 'The demo flag of a company cannot be changed';
  END IF;
  IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'The company creator cannot be changed';
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER companies_guard BEFORE UPDATE ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.companies_guard();

-- Guard: owner rules on memberships
CREATE OR REPLACE FUNCTION public.company_members_guard()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _company UUID := COALESCE(NEW.company_id, OLD.company_id);
  _remaining INT;
BEGIN
  -- Only an owner may grant (or alter) the owner role. Skipped for the
  -- trusted create_company / create_demo_company functions (no auth role).
  IF current_setting('linkbooks.trusted', true) IS DISTINCT FROM 'on' THEN
    IF TG_OP IN ('INSERT','UPDATE') AND NEW.role = 'owner'
       AND NOT public.has_company_role(_company, ARRAY['owner']::public.company_role[]) THEN
      RAISE EXCEPTION 'Only an owner can grant the owner role';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.role = 'owner'
       AND NOT public.has_company_role(_company, ARRAY['owner']::public.company_role[]) THEN
      RAISE EXCEPTION 'Only an owner can change another owner';
    END IF;
    IF TG_OP = 'DELETE' AND OLD.role = 'owner'
       AND NOT public.has_company_role(_company, ARRAY['owner']::public.company_role[]) THEN
      RAISE EXCEPTION 'Only an owner can remove an owner';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    NEW.updated_at = now();
  END IF;

  -- Never leave a company without an active owner
  IF (TG_OP = 'DELETE' AND OLD.role = 'owner')
     OR (TG_OP = 'UPDATE' AND OLD.role = 'owner' AND (NEW.role <> 'owner' OR NEW.status <> 'active')) THEN
    SELECT count(*) INTO _remaining FROM public.company_members
      WHERE company_id = _company AND role = 'owner' AND status = 'active' AND id <> OLD.id;
    IF _remaining = 0 AND EXISTS (SELECT 1 FROM public.companies WHERE id = _company) THEN
      RAISE EXCEPTION 'A company must keep at least one active owner';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.company_members_guard() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER company_members_guard BEFORE INSERT OR UPDATE OR DELETE ON public.company_members
  FOR EACH ROW EXECUTE FUNCTION public.company_members_guard();

CREATE TRIGGER company_tax_settings_set_updated_at BEFORE UPDATE ON public.company_tax_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Clear a stale "last company" if access is removed
CREATE OR REPLACE FUNCTION public.clear_last_company_on_leave()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.profiles SET last_company_id = NULL
    WHERE id = OLD.user_id AND last_company_id = OLD.company_id;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.clear_last_company_on_leave() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER company_members_clear_last AFTER DELETE ON public.company_members
  FOR EACH ROW EXECUTE FUNCTION public.clear_last_company_on_leave();

-- Profiles may only point at companies the user belongs to
CREATE OR REPLACE FUNCTION public.profiles_last_company_guard()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.last_company_id IS NOT NULL
     AND NEW.last_company_id IS DISTINCT FROM OLD.last_company_id
     AND current_setting('linkbooks.trusted', true) IS DISTINCT FROM 'on'
     AND NOT public.is_company_member(NEW.last_company_id) THEN
    RAISE EXCEPTION 'You do not have access to that company';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER profiles_last_company_guard BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_last_company_guard();

-- Trusted creation: company + tax settings + owner membership in one step
CREATE OR REPLACE FUNCTION public.create_company(
  _name TEXT, _country_code TEXT, _base_currency TEXT,
  _fy_end_month SMALLINT, _fy_end_day SMALLINT, _timezone TEXT,
  _legal_name TEXT DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _uid UUID := auth.uid();
  _id UUID;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  PERFORM set_config('linkbooks.trusted', 'on', true);

  INSERT INTO public.companies (name, legal_name, country_code, base_currency,
    fiscal_year_end_month, fiscal_year_end_day, timezone, is_demo, created_by)
  VALUES (trim(_name), NULLIF(trim(COALESCE(_legal_name, '')), ''), upper(_country_code), upper(_base_currency),
    _fy_end_month, _fy_end_day, _timezone, false, _uid)
  RETURNING id INTO _id;

  INSERT INTO public.company_tax_settings (company_id) VALUES (_id);
  INSERT INTO public.company_members (company_id, user_id, role, status) VALUES (_id, _uid, 'owner', 'active');
  UPDATE public.profiles SET last_company_id = _id WHERE id = _uid;

  PERFORM set_config('linkbooks.trusted', 'off', true);
  RETURN _id;
END;
$$;

-- Demo Company: a normal company with is_demo = true, one per user
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
  END IF;

  UPDATE public.profiles SET last_company_id = _id WHERE id = _uid;
  PERFORM set_config('linkbooks.trusted', 'off', true);
  RETURN _id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_company(TEXT, TEXT, TEXT, SMALLINT, SMALLINT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_demo_company() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_company(TEXT, TEXT, TEXT, SMALLINT, SMALLINT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_demo_company() TO authenticated;

-- ===== 20261003014326_67ade68a-94c9-41f8-8478-04165b345960.sql =====
CREATE OR REPLACE FUNCTION public.shares_company_with(_other UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.company_members me
    JOIN public.company_members them ON them.company_id = me.company_id
    WHERE me.user_id = auth.uid() AND me.status = 'active' AND them.user_id = _other
  )
$$;
REVOKE ALL ON FUNCTION public.shares_company_with(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.shares_company_with(UUID) TO authenticated;

CREATE POLICY "Members can view profiles of fellow company members"
  ON public.profiles FOR SELECT TO authenticated
  USING (public.shares_company_with(id));
