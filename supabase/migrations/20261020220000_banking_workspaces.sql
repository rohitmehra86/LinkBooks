-- Banking workspaces: exclude audit fields, rule conditions, coding history for suggestions.
-- Additive. Does not wipe bank transactions or journals.

ALTER TABLE public.bank_transactions
  ADD COLUMN IF NOT EXISTS exclude_reason TEXT,
  ADD COLUMN IF NOT EXISTS excluded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS excluded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payee_normalized TEXT;

CREATE INDEX IF NOT EXISTS bank_transactions_company_status_idx
  ON public.bank_transactions (company_id, status, txn_date DESC);

-- Compound rule conditions (optional). Existing single match_* fields remain authoritative when conditions is null/empty.
ALTER TABLE public.bank_rules
  ADD COLUMN IF NOT EXISTS conditions JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS condition_logic TEXT NOT NULL DEFAULT 'and'
    CHECK (condition_logic IN ('and', 'or')),
  ADD COLUMN IF NOT EXISTS apply_mode TEXT NOT NULL DEFAULT 'suggest'
    CHECK (apply_mode IN ('suggest', 'auto')),
  ADD COLUMN IF NOT EXISTS description TEXT;

-- Organisation-specific accepted coding history (tenant-isolated suggestions)
CREATE TABLE IF NOT EXISTS public.bank_coding_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  payee_normalized TEXT NOT NULL,
  description_sample TEXT,
  offset_account_id UUID NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  times_used INT NOT NULL DEFAULT 1,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, payee_normalized, offset_account_id, direction)
);

CREATE INDEX IF NOT EXISTS bank_coding_history_company_payee_idx
  ON public.bank_coding_history (company_id, payee_normalized);

ALTER TABLE public.bank_coding_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members view coding history" ON public.bank_coding_history;
CREATE POLICY "Members view coding history"
  ON public.bank_coding_history FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

DROP POLICY IF EXISTS "Banking upsert coding history" ON public.bank_coding_history;
CREATE POLICY "Banking upsert coding history"
  ON public.bank_coding_history FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'banking.categorise'))
  WITH CHECK (public.has_company_permission(company_id, 'banking.categorise'));
