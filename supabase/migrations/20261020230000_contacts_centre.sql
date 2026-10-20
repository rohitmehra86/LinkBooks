-- Contact Management Centre: extended fields, people, addresses, groups, tags.
-- Additive. Preserves existing contact IDs and FKs from sales/purchases.

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS account_number TEXT,
  ADD COLUMN IF NOT EXISTS legal_name TEXT,
  ADD COLUMN IF NOT EXISTS website TEXT,
  ADD COLUMN IF NOT EXISTS default_currency CHAR(3),
  ADD COLUMN IF NOT EXISTS credit_limit_minor BIGINT,
  ADD COLUMN IF NOT EXISTS billing_address_line1 TEXT,
  ADD COLUMN IF NOT EXISTS billing_address_line2 TEXT,
  ADD COLUMN IF NOT EXISTS billing_city TEXT,
  ADD COLUMN IF NOT EXISTS billing_region TEXT,
  ADD COLUMN IF NOT EXISTS billing_postal TEXT,
  ADD COLUMN IF NOT EXISTS billing_country TEXT,
  ADD COLUMN IF NOT EXISTS delivery_address_line1 TEXT,
  ADD COLUMN IF NOT EXISTS delivery_city TEXT,
  ADD COLUMN IF NOT EXISTS delivery_region TEXT,
  ADD COLUMN IF NOT EXISTS delivery_postal TEXT,
  ADD COLUMN IF NOT EXISTS delivery_country TEXT,
  ADD COLUMN IF NOT EXISTS default_sales_account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS default_purchase_account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sales_tax_inclusive BOOLEAN,
  ADD COLUMN IF NOT EXISTS purchase_tax_inclusive BOOLEAN,
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS contacts_company_account_number_uidx
  ON public.contacts (company_id, account_number)
  WHERE account_number IS NOT NULL AND length(trim(account_number)) > 0;

-- Additional people on a contact
CREATE TABLE IF NOT EXISTS public.contact_people (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  email TEXT,
  phone TEXT,
  job_title TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  role_label TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT contact_people_name_check CHECK (length(trim(first_name || last_name || coalesce(email, ''))) > 0)
);

CREATE INDEX IF NOT EXISTS contact_people_contact_idx ON public.contact_people (contact_id);

-- Extra labeled addresses
CREATE TABLE IF NOT EXISTS public.contact_addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT 'Other',
  line1 TEXT,
  line2 TEXT,
  city TEXT,
  region TEXT,
  postal_code TEXT,
  country TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contact_addresses_contact_idx ON public.contact_addresses (contact_id);

-- Groups
CREATE TABLE IF NOT EXISTS public.contact_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  color TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT contact_groups_name_nonempty CHECK (length(trim(name)) > 0),
  UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS public.contact_group_members (
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES public.contact_groups(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, contact_id)
);

CREATE INDEX IF NOT EXISTS contact_group_members_contact_idx ON public.contact_group_members (contact_id);

-- Tags
CREATE TABLE IF NOT EXISTS public.contact_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT contact_tags_name_nonempty CHECK (length(trim(name)) > 0),
  UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS public.contact_tag_assignments (
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES public.contact_tags(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tag_id, contact_id)
);

CREATE INDEX IF NOT EXISTS contact_tag_assignments_contact_idx ON public.contact_tag_assignments (contact_id);

-- Org contact settings (numbering etc.)
CREATE TABLE IF NOT EXISTS public.company_contact_settings (
  company_id UUID PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  default_kind TEXT NOT NULL DEFAULT 'customer',
  account_number_prefix TEXT NOT NULL DEFAULT 'C',
  next_account_number INT NOT NULL DEFAULT 1001,
  default_payment_terms_days INT NOT NULL DEFAULT 30,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE public.contact_people ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_addresses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_tag_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_contact_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members view contact people" ON public.contact_people;
CREATE POLICY "Members view contact people" ON public.contact_people FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
DROP POLICY IF EXISTS "Managers manage contact people" ON public.contact_people;
CREATE POLICY "Managers manage contact people" ON public.contact_people FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'contacts.manage'))
  WITH CHECK (public.has_company_permission(company_id, 'contacts.manage'));

DROP POLICY IF EXISTS "Members view contact addresses" ON public.contact_addresses;
CREATE POLICY "Members view contact addresses" ON public.contact_addresses FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
DROP POLICY IF EXISTS "Managers manage contact addresses" ON public.contact_addresses;
CREATE POLICY "Managers manage contact addresses" ON public.contact_addresses FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'contacts.manage'))
  WITH CHECK (public.has_company_permission(company_id, 'contacts.manage'));

DROP POLICY IF EXISTS "Members view contact groups" ON public.contact_groups;
CREATE POLICY "Members view contact groups" ON public.contact_groups FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
DROP POLICY IF EXISTS "Managers manage contact groups" ON public.contact_groups;
CREATE POLICY "Managers manage contact groups" ON public.contact_groups FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'contacts.manage'))
  WITH CHECK (public.has_company_permission(company_id, 'contacts.manage'));

DROP POLICY IF EXISTS "Members view group members" ON public.contact_group_members;
CREATE POLICY "Members view group members" ON public.contact_group_members FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
DROP POLICY IF EXISTS "Managers manage group members" ON public.contact_group_members;
CREATE POLICY "Managers manage group members" ON public.contact_group_members FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'contacts.manage'))
  WITH CHECK (public.has_company_permission(company_id, 'contacts.manage'));

DROP POLICY IF EXISTS "Members view contact tags" ON public.contact_tags;
CREATE POLICY "Members view contact tags" ON public.contact_tags FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
DROP POLICY IF EXISTS "Managers manage contact tags" ON public.contact_tags;
CREATE POLICY "Managers manage contact tags" ON public.contact_tags FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'contacts.manage'))
  WITH CHECK (public.has_company_permission(company_id, 'contacts.manage'));

DROP POLICY IF EXISTS "Members view tag assignments" ON public.contact_tag_assignments;
CREATE POLICY "Members view tag assignments" ON public.contact_tag_assignments FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
DROP POLICY IF EXISTS "Managers manage tag assignments" ON public.contact_tag_assignments;
CREATE POLICY "Managers manage tag assignments" ON public.contact_tag_assignments FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'contacts.manage'))
  WITH CHECK (public.has_company_permission(company_id, 'contacts.manage'));

DROP POLICY IF EXISTS "Members view contact settings" ON public.company_contact_settings;
CREATE POLICY "Members view contact settings" ON public.company_contact_settings FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
DROP POLICY IF EXISTS "Managers manage contact settings" ON public.company_contact_settings;
CREATE POLICY "Managers manage contact settings" ON public.company_contact_settings FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'contacts.manage'))
  WITH CHECK (public.has_company_permission(company_id, 'contacts.manage'));
