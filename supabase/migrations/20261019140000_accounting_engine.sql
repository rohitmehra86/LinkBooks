-- LinkBooks accounting engine (Phase 3 foundation)
-- Additive. Does not disable RLS. Does not modify production data by itself.
-- Apply only to development/staging after approval — not production without explicit approval.
-- Money: BIGINT minor units (integer). No floating-point ledger totals.

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE public.account_type AS ENUM (
    'asset', 'liability', 'equity', 'income', 'expense'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.normal_balance AS ENUM ('debit', 'credit');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.period_status AS ENUM ('open', 'locked', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.journal_status AS ENUM ('draft', 'approved', 'posted', 'voided');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.journal_source_type AS ENUM (
    'manual', 'opening_balance', 'sales_invoice', 'sales_credit_note', 'customer_payment',
    'purchase_bill', 'purchase_credit_note', 'supplier_payment', 'expense',
    'bank_transaction', 'bank_transfer', 'tax_adjustment', 'reversal', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.bank_txn_status AS ENUM ('uncategorised', 'matched', 'reconciled', 'excluded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- Currency decimal places (reference)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.currency_decimals (
  code CHAR(3) PRIMARY KEY,
  decimal_places SMALLINT NOT NULL CHECK (decimal_places >= 0 AND decimal_places <= 4)
);

INSERT INTO public.currency_decimals (code, decimal_places) VALUES
  ('USD', 2), ('GBP', 2), ('EUR', 2), ('AUD', 2), ('NZD', 2), ('CAD', 2),
  ('INR', 2), ('SGD', 2), ('ZAR', 2), ('AED', 2), ('JPY', 0), ('KWD', 3)
ON CONFLICT (code) DO NOTHING;

ALTER TABLE public.currency_decimals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Signed-in users can read currency decimals" ON public.currency_decimals;
CREATE POLICY "Signed-in users can read currency decimals"
  ON public.currency_decimals FOR SELECT TO authenticated USING (true);

-- ---------------------------------------------------------------------------
-- Chart of accounts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  account_type public.account_type NOT NULL,
  normal_balance public.normal_balance NOT NULL,
  subtype TEXT,
  is_system BOOLEAN NOT NULL DEFAULT false,
  is_postable BOOLEAN NOT NULL DEFAULT true,
  is_control BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT accounts_code_nonempty CHECK (length(trim(code)) > 0),
  CONSTRAINT accounts_name_nonempty CHECK (length(trim(name)) > 0),
  UNIQUE (company_id, code)
);

CREATE INDEX IF NOT EXISTS accounts_company_idx ON public.accounts (company_id);
CREATE INDEX IF NOT EXISTS accounts_company_type_idx ON public.accounts (company_id, account_type);

ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view accounts" ON public.accounts;
CREATE POLICY "Members can view accounts"
  ON public.accounts FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

DROP POLICY IF EXISTS "Managers can insert accounts" ON public.accounts;
CREATE POLICY "Managers can insert accounts"
  ON public.accounts FOR INSERT TO authenticated
  WITH CHECK (public.has_company_permission(company_id, 'accounts.manage'));

DROP POLICY IF EXISTS "Managers can update accounts" ON public.accounts;
CREATE POLICY "Managers can update accounts"
  ON public.accounts FOR UPDATE TO authenticated
  USING (public.has_company_permission(company_id, 'accounts.manage'))
  WITH CHECK (public.has_company_permission(company_id, 'accounts.manage'));

-- No DELETE policy: archive via is_active / archived_at only.

-- ---------------------------------------------------------------------------
-- Accounting periods
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.accounting_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status public.period_status NOT NULL DEFAULT 'open',
  locked_at TIMESTAMPTZ,
  locked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT accounting_periods_range CHECK (start_date <= end_date)
);

CREATE INDEX IF NOT EXISTS accounting_periods_company_idx
  ON public.accounting_periods (company_id, start_date, end_date);

-- Prevent overlapping periods per company (requires btree_gist)
DO $$ BEGIN
  ALTER TABLE public.accounting_periods
    ADD CONSTRAINT accounting_periods_no_overlap
    EXCLUDE USING gist (
      company_id WITH =,
      daterange(start_date, end_date, '[]') WITH &&
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL; -- extension missing in some envs
END $$;

ALTER TABLE public.accounting_periods ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view periods" ON public.accounting_periods;
CREATE POLICY "Members can view periods"
  ON public.accounting_periods FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

DROP POLICY IF EXISTS "Managers can insert periods" ON public.accounting_periods;
CREATE POLICY "Managers can insert periods"
  ON public.accounting_periods FOR INSERT TO authenticated
  WITH CHECK (public.has_company_permission(company_id, 'accounts.manage'));

DROP POLICY IF EXISTS "Lockers can update periods" ON public.accounting_periods;
CREATE POLICY "Lockers can update periods"
  ON public.accounting_periods FOR UPDATE TO authenticated
  USING (
    public.has_company_permission(company_id, 'periods.lock')
    OR public.has_company_permission(company_id, 'periods.unlock')
    OR public.has_company_permission(company_id, 'accounts.manage')
  )
  WITH CHECK (
    public.has_company_permission(company_id, 'periods.lock')
    OR public.has_company_permission(company_id, 'periods.unlock')
    OR public.has_company_permission(company_id, 'accounts.manage')
  );

-- ---------------------------------------------------------------------------
-- Journals + lines (authoritative ledger)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.journals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  journal_number BIGINT NOT NULL,
  journal_date DATE NOT NULL,
  period_id UUID NOT NULL REFERENCES public.accounting_periods(id) ON DELETE RESTRICT,
  status public.journal_status NOT NULL DEFAULT 'draft',
  source_type public.journal_source_type NOT NULL DEFAULT 'manual',
  source_id UUID,
  idempotency_key TEXT,
  memo TEXT,
  currency_code CHAR(3) NOT NULL,
  fx_rate_to_base NUMERIC(18, 8) NOT NULL DEFAULT 1 CHECK (fx_rate_to_base > 0),
  reverses_journal_id UUID REFERENCES public.journals(id) ON DELETE RESTRICT,
  reversed_by_journal_id UUID REFERENCES public.journals(id) ON DELETE RESTRICT,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  posted_at TIMESTAMPTZ,
  posted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  voided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, journal_number),
  UNIQUE (company_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS journals_company_date_idx ON public.journals (company_id, journal_date);
CREATE INDEX IF NOT EXISTS journals_company_status_idx ON public.journals (company_id, status);
CREATE INDEX IF NOT EXISTS journals_source_idx ON public.journals (company_id, source_type, source_id);

CREATE TABLE IF NOT EXISTS public.journal_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_id UUID NOT NULL REFERENCES public.journals(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  description TEXT,
  debit_minor BIGINT NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),
  credit_minor BIGINT NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT journal_lines_one_side CHECK (
    (debit_minor > 0 AND credit_minor = 0) OR (credit_minor > 0 AND debit_minor = 0)
  ),
  UNIQUE (journal_id, line_no)
);

CREATE INDEX IF NOT EXISTS journal_lines_journal_idx ON public.journal_lines (journal_id);
CREATE INDEX IF NOT EXISTS journal_lines_account_idx ON public.journal_lines (company_id, account_id);
CREATE INDEX IF NOT EXISTS journal_lines_company_idx ON public.journal_lines (company_id);

ALTER TABLE public.journals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.journal_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view journals" ON public.journals;
CREATE POLICY "Members can view journals"
  ON public.journals FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

DROP POLICY IF EXISTS "Posters can insert draft journals" ON public.journals;
CREATE POLICY "Posters can insert draft journals"
  ON public.journals FOR INSERT TO authenticated
  WITH CHECK (
    public.has_company_permission(company_id, 'accounting.post')
    OR public.has_company_permission(company_id, 'journals.manual')
  );

-- Updates/deletes of journals go through SECURITY DEFINER posting RPCs only.
-- Block client UPDATE/DELETE of posted rows via trigger (below) + no broad UPDATE policy for posted.

DROP POLICY IF EXISTS "Members can view journal lines" ON public.journal_lines;
CREATE POLICY "Members can view journal lines"
  ON public.journal_lines FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

DROP POLICY IF EXISTS "Posters can insert journal lines" ON public.journal_lines;
CREATE POLICY "Posters can insert journal lines"
  ON public.journal_lines FOR INSERT TO authenticated
  WITH CHECK (
    public.has_company_permission(company_id, 'accounting.post')
    OR public.has_company_permission(company_id, 'journals.manual')
  );

-- ---------------------------------------------------------------------------
-- Audit events (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_events_company_idx ON public.audit_events (company_id, created_at DESC);

ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members with audit.view can read audit" ON public.audit_events;
CREATE POLICY "Members with audit.view can read audit"
  ON public.audit_events FOR SELECT TO authenticated
  USING (
    public.is_company_member(company_id)
    AND (
      public.has_company_permission(company_id, 'audit.view')
      OR public.has_company_permission(company_id, 'accounting.view')
    )
  );

-- Inserts only via SECURITY DEFINER helpers (no direct INSERT policy for clients).

-- ---------------------------------------------------------------------------
-- Banking + reconciliation links (no duplicate ledger movements)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bank_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  currency_code CHAR(3) NOT NULL,
  gl_account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, gl_account_id)
);

CREATE TABLE IF NOT EXISTS public.bank_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  bank_account_id UUID NOT NULL REFERENCES public.bank_accounts(id) ON DELETE CASCADE,
  txn_date DATE NOT NULL,
  amount_minor BIGINT NOT NULL,
  description TEXT,
  external_id TEXT,
  status public.bank_txn_status NOT NULL DEFAULT 'uncategorised',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, bank_account_id, external_id)
);

CREATE TABLE IF NOT EXISTS public.reconciliation_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  bank_transaction_id UUID NOT NULL REFERENCES public.bank_transactions(id) ON DELETE CASCADE,
  journal_line_id UUID NOT NULL REFERENCES public.journal_lines(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE (bank_transaction_id),
  UNIQUE (journal_line_id)
);

CREATE INDEX IF NOT EXISTS bank_transactions_company_idx ON public.bank_transactions (company_id, txn_date);
CREATE INDEX IF NOT EXISTS reconciliation_links_company_idx ON public.reconciliation_links (company_id);

ALTER TABLE public.bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reconciliation_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can view bank accounts" ON public.bank_accounts;
CREATE POLICY "Members can view bank accounts"
  ON public.bank_accounts FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

DROP POLICY IF EXISTS "Banking manage insert accounts" ON public.bank_accounts;
CREATE POLICY "Banking manage insert accounts"
  ON public.bank_accounts FOR INSERT TO authenticated
  WITH CHECK (public.has_company_permission(company_id, 'banking.feeds.manage')
    OR public.has_company_permission(company_id, 'accounts.manage'));

DROP POLICY IF EXISTS "Members can view bank txns" ON public.bank_transactions;
CREATE POLICY "Members can view bank txns"
  ON public.bank_transactions FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

DROP POLICY IF EXISTS "Banking import insert txns" ON public.bank_transactions;
CREATE POLICY "Banking import insert txns"
  ON public.bank_transactions FOR INSERT TO authenticated
  WITH CHECK (public.has_company_permission(company_id, 'banking.import')
    OR public.has_company_permission(company_id, 'banking.categorise'));

DROP POLICY IF EXISTS "Banking update txns" ON public.bank_transactions;
CREATE POLICY "Banking update txns"
  ON public.bank_transactions FOR UPDATE TO authenticated
  USING (public.has_company_permission(company_id, 'banking.categorise')
    OR public.has_company_permission(company_id, 'banking.reconcile'))
  WITH CHECK (public.has_company_permission(company_id, 'banking.categorise')
    OR public.has_company_permission(company_id, 'banking.reconcile'));

DROP POLICY IF EXISTS "Members can view recon links" ON public.reconciliation_links;
CREATE POLICY "Members can view recon links"
  ON public.reconciliation_links FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

DROP POLICY IF EXISTS "Reconcile insert links" ON public.reconciliation_links;
CREATE POLICY "Reconcile insert links"
  ON public.reconciliation_links FOR INSERT TO authenticated
  WITH CHECK (public.has_company_permission(company_id, 'banking.reconcile')
    OR public.has_company_permission(company_id, 'banking.categorise'));

-- ---------------------------------------------------------------------------
-- Immutability: posted journals cannot be updated/deleted via client paths
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prevent_posted_journal_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'posted' AND current_setting('linkbooks.trusted', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'Posted journals cannot be deleted; create a reversal instead';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'posted' AND current_setting('linkbooks.trusted', true) IS DISTINCT FROM 'on' THEN
    -- Allow only reversed_by_journal_id to be set by trusted reverse RPC
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Posted journals are immutable; create a reversal instead';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS journals_prevent_posted_mutation ON public.journals;
CREATE TRIGGER journals_prevent_posted_mutation
  BEFORE UPDATE OR DELETE ON public.journals
  FOR EACH ROW EXECUTE FUNCTION public.prevent_posted_journal_mutation();

CREATE OR REPLACE FUNCTION public.prevent_posted_line_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  st public.journal_status;
BEGIN
  SELECT status INTO st FROM public.journals WHERE id = COALESCE(NEW.journal_id, OLD.journal_id);
  IF st = 'posted' AND current_setting('linkbooks.trusted', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Posted journal lines are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS journal_lines_prevent_posted_mutation ON public.journal_lines;
CREATE TRIGGER journal_lines_prevent_posted_mutation
  BEFORE UPDATE OR DELETE ON public.journal_lines
  FOR EACH ROW EXECUTE FUNCTION public.prevent_posted_line_mutation();

-- ---------------------------------------------------------------------------
-- Helpers: next journal number, seed CoA + periods
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.next_journal_number(_company_id UUID)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  n BIGINT;
BEGIN
  SELECT COALESCE(MAX(journal_number), 0) + 1 INTO n FROM public.journals WHERE company_id = _company_id;
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION public.seed_default_chart_of_accounts(_company_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Allow during trusted company create (linkbooks.trusted=on) or authenticated membership.
  IF current_setting('linkbooks.trusted', true) IS DISTINCT FROM 'on'
     AND (auth.uid() IS NULL OR NOT public.is_company_member(_company_id)) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.accounts WHERE company_id = _company_id) THEN
    INSERT INTO public.accounts (company_id, code, name, account_type, normal_balance, subtype, is_system, is_postable, is_control) VALUES
      (_company_id, '1000', 'Bank', 'asset', 'debit', 'bank', true, true, false),
      (_company_id, '1100', 'Accounts Receivable', 'asset', 'debit', 'receivable', true, true, true),
      (_company_id, '1200', 'Other Current Assets', 'asset', 'debit', 'current', true, true, false),
      (_company_id, '2000', 'Accounts Payable', 'liability', 'credit', 'payable', true, true, true),
      (_company_id, '2100', 'Tax Payable', 'liability', 'credit', 'tax', true, true, true),
      (_company_id, '2200', 'Other Current Liabilities', 'liability', 'credit', 'current', true, true, false),
      (_company_id, '3000', 'Owner Equity', 'equity', 'credit', 'equity', true, true, false),
      (_company_id, '3100', 'Opening Balance Equity', 'equity', 'credit', 'opening', true, true, false),
      (_company_id, '3200', 'Retained Earnings', 'equity', 'credit', 'retained', true, false, false),
      (_company_id, '4000', 'Sales Revenue', 'income', 'credit', 'revenue', true, true, false),
      (_company_id, '5000', 'Cost of Sales', 'expense', 'debit', 'cogs', true, true, false),
      (_company_id, '6000', 'Operating Expenses', 'expense', 'debit', 'opex', true, true, false),
      (_company_id, '6100', 'Bank Fees', 'expense', 'debit', 'opex', true, true, false),
      (_company_id, '6900', 'Rounding', 'expense', 'debit', 'rounding', true, true, false);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.seed_default_accounting_periods(_company_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  fy_m SMALLINT;
  fy_d SMALLINT;
  start_d DATE;
  end_d DATE;
  y INT := EXTRACT(YEAR FROM CURRENT_DATE)::INT;
BEGIN
  IF current_setting('linkbooks.trusted', true) IS DISTINCT FROM 'on'
     AND (auth.uid() IS NULL OR NOT public.is_company_member(_company_id)) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  SELECT fiscal_year_end_month, fiscal_year_end_day INTO fy_m, fy_d
  FROM public.companies WHERE id = _company_id;

  -- Period covering "current" FY end: from day after previous FY end through this FY end.
  end_d := make_date(y, fy_m, LEAST(fy_d, EXTRACT(DAY FROM (date_trunc('month', make_date(y, fy_m, 1)) + INTERVAL '1 month - 1 day'))::INT));
  IF CURRENT_DATE > end_d THEN
    end_d := make_date(y + 1, fy_m, LEAST(fy_d, EXTRACT(DAY FROM (date_trunc('month', make_date(y + 1, fy_m, 1)) + INTERVAL '1 month - 1 day'))::INT));
  END IF;
  start_d := (end_d - INTERVAL '1 year' + INTERVAL '1 day')::DATE;

  IF NOT EXISTS (SELECT 1 FROM public.accounting_periods WHERE company_id = _company_id) THEN
    INSERT INTO public.accounting_periods (company_id, name, start_date, end_date, status)
    VALUES (_company_id, 'FY ending ' || end_d::TEXT, start_d, end_d, 'open');
  END IF;
END;
$$;

-- Extend company creation to seed ledger masters
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

  PERFORM public.seed_default_chart_of_accounts(_id);
  PERFORM public.seed_default_accounting_periods(_id);

  PERFORM set_config('linkbooks.trusted', 'off', true);
  RETURN _id;
END;
$$;

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
  ELSE
    -- Ensure masters exist for older demo companies
    PERFORM public.seed_default_chart_of_accounts(_id);
    PERFORM public.seed_default_accounting_periods(_id);
  END IF;

  UPDATE public.profiles SET last_company_id = _id WHERE id = _uid;
  PERFORM set_config('linkbooks.trusted', 'off', true);
  RETURN _id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Authoritative posting RPC (atomic)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.post_journal(payload JSONB)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _uid UUID := auth.uid();
  _company_id UUID;
  _journal_date DATE;
  _memo TEXT;
  _currency CHAR(3);
  _fx NUMERIC(18,8);
  _source_type public.journal_source_type;
  _source_id UUID;
  _idem TEXT;
  _reverses UUID;
  _period_id UUID;
  _period_status public.period_status;
  _journal_id UUID;
  _existing UUID;
  _line JSONB;
  _line_no INT := 0;
  _account_id UUID;
  _debit BIGINT;
  _credit BIGINT;
  _sum_debit BIGINT := 0;
  _sum_credit BIGINT := 0;
  _acct RECORD;
  _base_currency CHAR(3);
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;

  _company_id := (payload->>'company_id')::UUID;
  IF _company_id IS NULL THEN RAISE EXCEPTION 'company_id is required'; END IF;

  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT (
    public.has_company_permission(_company_id, 'accounting.post')
    OR public.has_company_permission(_company_id, 'journals.manual')
  ) THEN
    RAISE EXCEPTION 'You do not have permission to post journals';
  END IF;

  _journal_date := (payload->>'journal_date')::DATE;
  IF _journal_date IS NULL THEN RAISE EXCEPTION 'journal_date is required'; END IF;
  _memo := NULLIF(trim(COALESCE(payload->>'memo', '')), '');
  _currency := upper(COALESCE(payload->>'currency_code', ''));
  _fx := COALESCE((payload->>'fx_rate_to_base')::NUMERIC, 1);
  IF _fx <= 0 THEN RAISE EXCEPTION 'fx_rate_to_base must be positive'; END IF;
  _source_type := COALESCE((payload->>'source_type')::public.journal_source_type, 'manual');
  _source_id := NULLIF(payload->>'source_id', '')::UUID;
  _idem := NULLIF(trim(COALESCE(payload->>'idempotency_key', '')), '');
  _reverses := NULLIF(payload->>'reverses_journal_id', '')::UUID;

  SELECT base_currency INTO _base_currency FROM public.companies WHERE id = _company_id;
  IF _currency = '' THEN _currency := _base_currency; END IF;
  IF length(_currency) <> 3 THEN RAISE EXCEPTION 'Invalid currency_code'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.currency_decimals WHERE code = _currency) THEN
    RAISE EXCEPTION 'Unsupported currency %', _currency;
  END IF;

  -- Idempotency: return existing posted journal
  IF _idem IS NOT NULL THEN
    SELECT id INTO _existing FROM public.journals
    WHERE company_id = _company_id AND idempotency_key = _idem;
    IF _existing IS NOT NULL THEN
      RETURN _existing;
    END IF;
  END IF;

  SELECT id, status INTO _period_id, _period_status
  FROM public.accounting_periods
  WHERE company_id = _company_id
    AND start_date <= _journal_date
    AND end_date >= _journal_date
  LIMIT 1;

  IF _period_id IS NULL THEN
    RAISE EXCEPTION 'No accounting period covers posting date %', _journal_date;
  END IF;
  IF _period_status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'Accounting period is %; posting is not allowed', _period_status;
  END IF;

  IF jsonb_typeof(payload->'lines') <> 'array' OR jsonb_array_length(payload->'lines') < 2 THEN
    RAISE EXCEPTION 'Journal requires at least two lines';
  END IF;

  PERFORM set_config('linkbooks.trusted', 'on', true);

  INSERT INTO public.journals (
    company_id, journal_number, journal_date, period_id, status,
    source_type, source_id, idempotency_key, memo, currency_code, fx_rate_to_base,
    reverses_journal_id, created_by, posted_at, posted_by
  ) VALUES (
    _company_id, public.next_journal_number(_company_id), _journal_date, _period_id, 'posted',
    _source_type, _source_id, _idem, _memo, _currency, _fx,
    _reverses, _uid, now(), _uid
  ) RETURNING id INTO _journal_id;

  FOR _line IN SELECT value FROM jsonb_array_elements(payload->'lines')
  LOOP
    _line_no := _line_no + 1;
    _account_id := (_line->>'account_id')::UUID;
    _debit := COALESCE((_line->>'debit_minor')::BIGINT, 0);
    _credit := COALESCE((_line->>'credit_minor')::BIGINT, 0);

    IF _account_id IS NULL THEN
      RAISE EXCEPTION 'Line % missing account_id', _line_no;
    END IF;
    IF (_debit > 0 AND _credit > 0) OR (_debit = 0 AND _credit = 0) THEN
      RAISE EXCEPTION 'Line % must have either debit_minor or credit_minor > 0, not both', _line_no;
    END IF;
    IF _debit < 0 OR _credit < 0 THEN
      RAISE EXCEPTION 'Line % amounts must be non-negative minor units', _line_no;
    END IF;

    SELECT * INTO _acct FROM public.accounts WHERE id = _account_id AND company_id = _company_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Account % not found in organisation', _account_id;
    END IF;
    IF NOT _acct.is_active OR _acct.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'Account % is inactive', _acct.code;
    END IF;
    IF NOT _acct.is_postable THEN
      RAISE EXCEPTION 'Account % is not postable', _acct.code;
    END IF;

    INSERT INTO public.journal_lines (
      journal_id, company_id, line_no, account_id, description, debit_minor, credit_minor
    ) VALUES (
      _journal_id, _company_id, _line_no, _account_id,
      NULLIF(trim(COALESCE(_line->>'description', '')), ''),
      _debit, _credit
    );

    _sum_debit := _sum_debit + _debit;
    _sum_credit := _sum_credit + _credit;
  END LOOP;

  IF _sum_debit <> _sum_credit THEN
    RAISE EXCEPTION 'Journal does not balance: debits % <> credits % (minor units)', _sum_debit, _sum_credit;
  END IF;
  IF _sum_debit = 0 THEN
    RAISE EXCEPTION 'Journal total cannot be zero';
  END IF;

  IF _reverses IS NOT NULL THEN
    UPDATE public.journals
    SET reversed_by_journal_id = _journal_id, updated_at = now()
    WHERE id = _reverses AND company_id = _company_id AND status = 'posted';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Journal to reverse not found or not posted';
    END IF;
  END IF;

  INSERT INTO public.audit_events (company_id, actor_user_id, action, entity_type, entity_id, details)
  VALUES (
    _company_id, _uid, 'journal.posted', 'journal', _journal_id,
    jsonb_build_object(
      'debit_minor', _sum_debit,
      'credit_minor', _sum_credit,
      'source_type', _source_type,
      'idempotency_key', _idem,
      'reverses_journal_id', _reverses
    )
  );

  PERFORM set_config('linkbooks.trusted', 'off', true);
  RETURN _journal_id;

EXCEPTION WHEN unique_violation THEN
  -- Concurrent duplicate idempotency_key: return the winner
  IF _idem IS NOT NULL THEN
    SELECT id INTO _existing FROM public.journals
    WHERE company_id = _company_id AND idempotency_key = _idem;
    IF _existing IS NOT NULL THEN
      PERFORM set_config('linkbooks.trusted', 'off', true);
      RETURN _existing;
    END IF;
  END IF;
  RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION public.reverse_journal(_journal_id UUID, _idempotency_key TEXT DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _uid UUID := auth.uid();
  j RECORD;
  payload JSONB;
  lines JSONB := '[]'::jsonb;
  ln RECORD;
  new_id UUID;
  idem TEXT;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;

  SELECT * INTO j FROM public.journals WHERE id = _journal_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Journal not found'; END IF;
  IF NOT public.is_company_member(j.company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT (
    public.has_company_permission(j.company_id, 'accounting.post')
    OR public.has_company_permission(j.company_id, 'journals.manual')
  ) THEN
    RAISE EXCEPTION 'You do not have permission to reverse journals';
  END IF;
  IF j.status <> 'posted' THEN RAISE EXCEPTION 'Only posted journals can be reversed'; END IF;
  IF j.reversed_by_journal_id IS NOT NULL THEN RAISE EXCEPTION 'Journal already reversed'; END IF;

  FOR ln IN
    SELECT account_id, description, debit_minor, credit_minor
    FROM public.journal_lines WHERE journal_id = j.id ORDER BY line_no
  LOOP
    lines := lines || jsonb_build_array(jsonb_build_object(
      'account_id', ln.account_id,
      'description', COALESCE(ln.description, 'Reversal'),
      'debit_minor', ln.credit_minor,
      'credit_minor', ln.debit_minor
    ));
  END LOOP;

  idem := COALESCE(NULLIF(trim(_idempotency_key), ''), 'reversal:' || j.id::TEXT);

  payload := jsonb_build_object(
    'company_id', j.company_id,
    'journal_date', j.journal_date,
    'memo', 'Reversal of journal #' || j.journal_number,
    'currency_code', j.currency_code,
    'fx_rate_to_base', j.fx_rate_to_base,
    'source_type', 'reversal',
    'source_id', j.id,
    'idempotency_key', idem,
    'reverses_journal_id', j.id,
    'lines', lines
  );

  new_id := public.post_journal(payload);
  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.lock_accounting_period(_period_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  p RECORD;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  SELECT * INTO p FROM public.accounting_periods WHERE id = _period_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Period not found'; END IF;
  IF NOT public.has_company_permission(p.company_id, 'periods.lock') THEN
    RAISE EXCEPTION 'You do not have permission to lock periods';
  END IF;
  UPDATE public.accounting_periods
  SET status = 'locked', locked_at = now(), locked_by = auth.uid()
  WHERE id = _period_id AND status = 'open';
  IF NOT FOUND THEN RAISE EXCEPTION 'Period is not open'; END IF;
  INSERT INTO public.audit_events (company_id, actor_user_id, action, entity_type, entity_id, details)
  VALUES (p.company_id, auth.uid(), 'period.locked', 'accounting_period', _period_id, '{}'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.unlock_accounting_period(_period_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  p RECORD;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  SELECT * INTO p FROM public.accounting_periods WHERE id = _period_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Period not found'; END IF;
  IF NOT public.has_company_permission(p.company_id, 'periods.unlock') THEN
    RAISE EXCEPTION 'You do not have permission to unlock periods';
  END IF;
  UPDATE public.accounting_periods
  SET status = 'open', locked_at = NULL, locked_by = NULL
  WHERE id = _period_id AND status = 'locked';
  IF NOT FOUND THEN RAISE EXCEPTION 'Period is not locked'; END IF;
  INSERT INTO public.audit_events (company_id, actor_user_id, action, entity_type, entity_id, details)
  VALUES (p.company_id, auth.uid(), 'period.unlocked', 'accounting_period', _period_id, '{}'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.post_journal(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reverse_journal(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.lock_accounting_period(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.unlock_accounting_period(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.seed_default_chart_of_accounts(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.seed_default_accounting_periods(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.next_journal_number(UUID) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.post_journal(JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_journal(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.lock_accounting_period(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.unlock_accounting_period(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.seed_default_chart_of_accounts(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.seed_default_accounting_periods(UUID) TO authenticated;

GRANT SELECT ON public.accounts TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.accounts TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.accounting_periods TO authenticated;
GRANT SELECT ON public.journals TO authenticated;
GRANT SELECT ON public.journal_lines TO authenticated;
GRANT SELECT ON public.audit_events TO authenticated;
GRANT SELECT ON public.bank_accounts TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.bank_accounts TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.bank_transactions TO authenticated;
GRANT SELECT, INSERT ON public.reconciliation_links TO authenticated;
