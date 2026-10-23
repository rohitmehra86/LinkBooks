-- Enterprise chart fields. Does not replace account_type (asset|liability|equity|income|expense).
-- Existing codes, subtypes, and balances stay. New columns are nullable or defaulted.

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS account_kind TEXT,
  ADD COLUMN IF NOT EXISTS detail_type TEXT,
  ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES public.accounts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS is_header BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS default_tax_code_id UUID REFERENCES public.tax_codes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS currency_code CHAR(3),
  ADD COLUMN IF NOT EXISTS is_payment_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS show_on_dashboard_watchlist BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS show_in_expense_claims BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS bank_name TEXT,
  ADD COLUMN IF NOT EXISTS account_number_masked TEXT,
  ADD COLUMN IF NOT EXISTS statutory_mapping JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS system_key TEXT,
  ADD COLUMN IF NOT EXISTS is_locked BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS archived_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_kind_known;
ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_kind_known CHECK (
    account_kind IS NULL OR account_kind IN (
      'bank', 'accounts_receivable', 'current_asset', 'inventory', 'prepayment',
      'fixed_asset', 'non_current_asset', 'accounts_payable', 'credit_card',
      'current_liability', 'non_current_liability', 'equity', 'retained_earnings',
      'revenue', 'other_income', 'contra_revenue', 'cost_of_sales', 'expense',
      'overhead', 'depreciation', 'other_expense'
    )
  );

ALTER TABLE public.accounts DROP CONSTRAINT IF EXISTS accounts_code_max_10;
ALTER TABLE public.accounts
  ADD CONSTRAINT accounts_code_max_10 CHECK (char_length(code) <= 10);

CREATE UNIQUE INDEX IF NOT EXISTS accounts_company_name_lower_uidx
  ON public.accounts (company_id, lower(name));

CREATE INDEX IF NOT EXISTS accounts_parent_idx ON public.accounts (parent_id);

UPDATE public.accounts
SET account_kind = CASE
  WHEN subtype = 'bank' THEN 'bank'
  WHEN subtype = 'receivable' THEN 'accounts_receivable'
  WHEN subtype = 'inventory' THEN 'inventory'
  WHEN subtype = 'prepayment' THEN 'prepayment'
  WHEN account_type = 'asset' AND subtype IN ('fixed', 'non_current', 'non_current_asset', 'depreciation') THEN 'fixed_asset'
  WHEN account_type = 'asset' THEN 'current_asset'
  WHEN subtype = 'payable' THEN 'accounts_payable'
  WHEN subtype = 'credit_card' THEN 'credit_card'
  WHEN account_type = 'liability' AND (subtype LIKE '%loan%' OR subtype LIKE '%non_current%') THEN 'non_current_liability'
  WHEN account_type = 'liability' THEN 'current_liability'
  WHEN subtype = 'retained' THEN 'retained_earnings'
  WHEN account_type = 'equity' THEN 'equity'
  WHEN subtype = 'contra_revenue' THEN 'contra_revenue'
  WHEN account_type = 'income' AND subtype IN ('other', 'other_income') THEN 'other_income'
  WHEN account_type = 'income' THEN 'revenue'
  WHEN subtype IN ('cogs', 'cost_of_sales') THEN 'cost_of_sales'
  WHEN account_type = 'expense' AND subtype = 'depreciation' THEN 'depreciation'
  WHEN account_type = 'expense' AND subtype IN ('other_expense', 'other') THEN 'other_expense'
  ELSE 'expense'
END
WHERE account_kind IS NULL;

UPDATE public.accounts
SET system_key = CASE code
  WHEN '1000' THEN 'bank'
  WHEN '1100' THEN 'ar'
  WHEN '2000' THEN 'ap'
  WHEN '2100' THEN 'tax'
  WHEN '3100' THEN 'opening_balance'
  WHEN '3200' THEN 'retained_earnings'
  ELSE system_key
END
WHERE is_system AND system_key IS NULL AND code IN ('1000', '1100', '2000', '2100', '3100', '3200');

UPDATE public.accounts SET is_locked = true WHERE (is_system OR is_control) AND is_locked = false;

CREATE TABLE IF NOT EXISTS public.coa_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  account_id UUID REFERENCES public.accounts(id) ON DELETE SET NULL,
  actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  old_values JSONB,
  new_values JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.coa_audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS coa_audit_select ON public.coa_audit_log;
CREATE POLICY coa_audit_select ON public.coa_audit_log FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
GRANT SELECT ON public.coa_audit_log TO authenticated;

CREATE OR REPLACE FUNCTION public.accounts_apply_kind()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  mapped_type public.account_type;
  mapped_sub TEXT;
  mapped_fs TEXT;
  mapped_nb public.normal_balance;
  walk UUID;
  guard INT := 0;
  parent_type public.account_type;
  parent_company UUID;
  debit_sum BIGINT;
  credit_sum BIGINT;
BEGIN
  IF NEW.is_system AND TG_OP = 'INSERT'
     AND current_setting('linkbooks.trusted', true) IS DISTINCT FROM 'on'
     AND auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION 'A user account cannot be created as a system account';
  END IF;

  IF NEW.account_kind IS NULL THEN
    NEW.account_kind := CASE NEW.account_type
      WHEN 'asset' THEN 'current_asset'
      WHEN 'liability' THEN 'current_liability'
      WHEN 'equity' THEN 'equity'
      WHEN 'income' THEN 'revenue'
      ELSE 'expense'
    END;
  END IF;

  mapped_type := CASE NEW.account_kind
    WHEN 'bank' THEN 'asset'
    WHEN 'accounts_receivable' THEN 'asset'
    WHEN 'current_asset' THEN 'asset'
    WHEN 'inventory' THEN 'asset'
    WHEN 'prepayment' THEN 'asset'
    WHEN 'fixed_asset' THEN 'asset'
    WHEN 'non_current_asset' THEN 'asset'
    WHEN 'accounts_payable' THEN 'liability'
    WHEN 'credit_card' THEN 'liability'
    WHEN 'current_liability' THEN 'liability'
    WHEN 'non_current_liability' THEN 'liability'
    WHEN 'equity' THEN 'equity'
    WHEN 'retained_earnings' THEN 'equity'
    WHEN 'revenue' THEN 'income'
    WHEN 'other_income' THEN 'income'
    WHEN 'contra_revenue' THEN 'income'
    ELSE 'expense'
  END;
  mapped_sub := CASE NEW.account_kind
    WHEN 'bank' THEN 'bank'
    WHEN 'accounts_receivable' THEN 'receivable'
    WHEN 'inventory' THEN 'inventory'
    WHEN 'prepayment' THEN 'prepayment'
    WHEN 'fixed_asset' THEN 'fixed'
    WHEN 'non_current_asset' THEN 'non_current_asset'
    WHEN 'accounts_payable' THEN 'payable'
    WHEN 'credit_card' THEN 'credit_card'
    WHEN 'current_liability' THEN 'current_liability'
    WHEN 'non_current_liability' THEN 'non_current_liability'
    WHEN 'retained_earnings' THEN 'retained'
    WHEN 'equity' THEN 'equity'
    WHEN 'other_income' THEN 'other'
    WHEN 'contra_revenue' THEN 'contra_revenue'
    WHEN 'cost_of_sales' THEN 'cogs'
    WHEN 'depreciation' THEN 'depreciation'
    WHEN 'other_expense' THEN 'other_expense'
    WHEN 'overhead' THEN 'operating_expense'
    WHEN 'expense' THEN 'operating_expense'
    WHEN 'revenue' THEN 'income'
    ELSE 'current_asset'
  END;
  mapped_fs := CASE NEW.account_kind
    WHEN 'bank' THEN 'current_assets'
    WHEN 'accounts_receivable' THEN 'current_assets'
    WHEN 'current_asset' THEN 'current_assets'
    WHEN 'inventory' THEN 'current_assets'
    WHEN 'prepayment' THEN 'current_assets'
    WHEN 'fixed_asset' THEN 'non_current_assets'
    WHEN 'non_current_asset' THEN 'non_current_assets'
    WHEN 'accounts_payable' THEN 'current_liabilities'
    WHEN 'credit_card' THEN 'current_liabilities'
    WHEN 'current_liability' THEN 'current_liabilities'
    WHEN 'non_current_liability' THEN 'non_current_liabilities'
    WHEN 'equity' THEN 'equity'
    WHEN 'retained_earnings' THEN 'equity'
    WHEN 'revenue' THEN 'revenue'
    WHEN 'other_income' THEN 'other_income'
    WHEN 'contra_revenue' THEN 'contra_revenue'
    WHEN 'cost_of_sales' THEN 'cost_of_sales'
    WHEN 'overhead' THEN 'operating_expense'
    WHEN 'expense' THEN 'operating_expense'
    WHEN 'depreciation' THEN 'depreciation'
    ELSE 'other_expense'
  END;
  mapped_nb := CASE WHEN NEW.account_kind = 'contra_revenue' THEN 'debit'
    WHEN mapped_type IN ('asset', 'expense') THEN 'debit'
    ELSE 'credit' END;

  NEW.account_type := mapped_type;
  NEW.normal_balance := mapped_nb;
  IF NEW.subtype IS NULL OR btrim(NEW.subtype) = '' THEN
    NEW.subtype := mapped_sub;
  END IF;
  IF NEW.fs_line IS NULL OR btrim(NEW.fs_line) = '' THEN
    NEW.fs_line := mapped_fs;
  END IF;
  IF NEW.is_header THEN
    NEW.is_postable := false;
  END IF;
  IF NEW.account_kind NOT IN ('bank', 'credit_card') THEN
    NEW.is_payment_enabled := false;
    NEW.bank_name := NULL;
    NEW.account_number_masked := NULL;
  END IF;
  IF mapped_type <> 'expense' THEN
    NEW.show_in_expense_claims := false;
  END IF;

  IF NEW.parent_id IS NOT NULL THEN
    IF NEW.parent_id = NEW.id THEN
      RAISE EXCEPTION 'An account cannot be its own parent';
    END IF;
    SELECT account_type, company_id, parent_id INTO parent_type, parent_company, walk
    FROM public.accounts WHERE id = NEW.parent_id;
    IF parent_company IS NULL THEN
      RAISE EXCEPTION 'Parent account was not found';
    END IF;
    IF parent_company IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION 'Parent account must belong to the same organisation';
    END IF;
    IF parent_type IS DISTINCT FROM NEW.account_type THEN
      RAISE EXCEPTION 'A sub-account must use the same class as its parent';
    END IF;
    WHILE walk IS NOT NULL AND guard < 30 LOOP
      IF walk = NEW.id THEN
        RAISE EXCEPTION 'Account parent cycle is not allowed';
      END IF;
      SELECT parent_id INTO walk FROM public.accounts WHERE id = walk;
      guard := guard + 1;
    END LOOP;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF (OLD.is_system OR OLD.is_control OR OLD.is_locked) AND (
      NEW.account_kind IS DISTINCT FROM OLD.account_kind
      OR NEW.system_key IS DISTINCT FROM OLD.system_key
      OR NEW.is_system IS DISTINCT FROM OLD.is_system
      OR (OLD.is_active AND NOT NEW.is_active)
    ) THEN
      RAISE EXCEPTION 'System accounts cannot be re-typed or archived';
    END IF;
    IF NEW.account_type IS DISTINCT FROM OLD.account_type OR NEW.account_kind IS DISTINCT FROM OLD.account_kind THEN
      IF EXISTS (
        SELECT 1 FROM public.journal_lines jl
        JOIN public.journals j ON j.id = jl.journal_id
        WHERE jl.account_id = OLD.id AND j.status = 'posted'
      ) THEN
        RAISE EXCEPTION 'Type locked: this account has posted transactions. Merge it into another account instead.';
      END IF;
    END IF;
    IF OLD.is_active AND NOT NEW.is_active THEN
      IF EXISTS (SELECT 1 FROM public.accounts c WHERE c.parent_id = OLD.id AND c.is_active) THEN
        RAISE EXCEPTION 'Archive blocked: this account has active sub-accounts';
      END IF;
      SELECT COALESCE(SUM(jl.debit_minor), 0), COALESCE(SUM(jl.credit_minor), 0)
        INTO debit_sum, credit_sum
      FROM public.journal_lines jl
      JOIN public.journals j ON j.id = jl.journal_id AND j.status = 'posted'
      WHERE jl.account_id = OLD.id;
      IF debit_sum <> credit_sum THEN
        RAISE EXCEPTION 'Archive blocked: the account balance is not zero';
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.sales_recurring_invoice_lines l
        JOIN public.sales_recurring_invoices r ON r.id = l.recurring_id
        WHERE l.account_id = OLD.id AND r.is_active
      ) THEN
        RAISE EXCEPTION 'Archive blocked: used on an active recurring invoice';
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.bank_rules br
        WHERE br.offset_account_id = OLD.id AND br.is_active
      ) THEN
        RAISE EXCEPTION 'Archive blocked: used on an active bank rule';
      END IF;
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_accounts_apply_kind ON public.accounts;
CREATE TRIGGER trg_accounts_apply_kind
  BEFORE INSERT OR UPDATE ON public.accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.accounts_apply_kind();

CREATE OR REPLACE FUNCTION public.accounts_write_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.coa_audit_log (company_id, account_id, actor_id, action, old_values, new_values)
  VALUES (
    COALESCE(NEW.company_id, OLD.company_id),
    COALESCE(NEW.id, OLD.id),
    auth.uid(),
    TG_OP,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE jsonb_build_object('code', OLD.code, 'name', OLD.name, 'kind', OLD.account_kind, 'active', OLD.is_active) END,
    jsonb_build_object('code', NEW.code, 'name', NEW.name, 'kind', NEW.account_kind, 'active', NEW.is_active)
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_accounts_audit ON public.accounts;
CREATE TRIGGER trg_accounts_audit
  AFTER INSERT OR UPDATE ON public.accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.accounts_write_audit();
