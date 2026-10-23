-- Workstream C (Banking) — schema foundation for real matching, tick-based reconciliation,
-- richer statement imports and bank-account maintenance.
-- Additive and idempotent. Never edits or deletes posted journals.

-- ---------------------------------------------------------------------------
-- 1. bank_transactions: store what the bank sent (reference / payee) + coding contact
-- ---------------------------------------------------------------------------
ALTER TABLE public.bank_transactions
  ADD COLUMN IF NOT EXISTS reference TEXT,
  ADD COLUMN IF NOT EXISTS payee TEXT,
  ADD COLUMN IF NOT EXISTS contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS import_id UUID REFERENCES public.bank_statement_imports(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS bank_transactions_account_date_idx
  ON public.bank_transactions (bank_account_id, txn_date DESC);
CREATE INDEX IF NOT EXISTS bank_transactions_import_idx
  ON public.bank_transactions (import_id) WHERE import_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. reconciliation_links: allow many-to-one and one-to-many matches.
--    The old UNIQUE(bank_transaction_id) and UNIQUE(journal_line_id) made both impossible.
--    Over-matching is prevented by the match_* RPCs (they only link complete, exactly-summing groups).
-- ---------------------------------------------------------------------------
ALTER TABLE public.reconciliation_links
  DROP CONSTRAINT IF EXISTS reconciliation_links_bank_transaction_id_key;
ALTER TABLE public.reconciliation_links
  DROP CONSTRAINT IF EXISTS reconciliation_links_journal_line_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS reconciliation_links_pair_uidx
  ON public.reconciliation_links (bank_transaction_id, journal_line_id);
CREATE INDEX IF NOT EXISTS reconciliation_links_txn_idx
  ON public.reconciliation_links (bank_transaction_id);
CREATE INDEX IF NOT EXISTS reconciliation_links_line_idx
  ON public.reconciliation_links (journal_line_id);

-- ---------------------------------------------------------------------------
-- 3. reconciliation_sessions: opening balance + void bookkeeping
-- ---------------------------------------------------------------------------
ALTER TABLE public.reconciliation_sessions
  ADD COLUMN IF NOT EXISTS opening_balance_minor BIGINT,
  ADD COLUMN IF NOT EXISTS cleared_total_minor BIGINT,
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS void_reason TEXT;

CREATE INDEX IF NOT EXISTS reconciliation_sessions_account_idx
  ON public.reconciliation_sessions (bank_account_id, status, statement_date DESC);

-- ---------------------------------------------------------------------------
-- 4. reconciliation_session_lines: the exact items ticked in a completed session
--    One row per cleared journal line. bank_transaction_id is NULL for ledger items that were
--    cleared without an imported statement line. Written only by complete_reconciliation_session.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reconciliation_session_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES public.reconciliation_sessions(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  bank_transaction_id UUID REFERENCES public.bank_transactions(id) ON DELETE CASCADE,
  journal_line_id UUID REFERENCES public.journal_lines(id) ON DELETE RESTRICT,
  amount_minor BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT reconciliation_session_lines_target CHECK (
    bank_transaction_id IS NOT NULL OR journal_line_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS reconciliation_session_lines_session_idx
  ON public.reconciliation_session_lines (session_id);
CREATE INDEX IF NOT EXISTS reconciliation_session_lines_txn_idx
  ON public.reconciliation_session_lines (bank_transaction_id) WHERE bank_transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS reconciliation_session_lines_jl_idx
  ON public.reconciliation_session_lines (journal_line_id) WHERE journal_line_id IS NOT NULL;

ALTER TABLE public.reconciliation_session_lines ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members view reconciliation session lines" ON public.reconciliation_session_lines;
CREATE POLICY "Members view reconciliation session lines"
  ON public.reconciliation_session_lines FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));
-- No INSERT/UPDATE/DELETE policies: only SECURITY DEFINER RPCs write here.

-- ---------------------------------------------------------------------------
-- 5. Bank account maintenance (rename / archive). Previously no UPDATE policy existed.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Banking manage update accounts" ON public.bank_accounts;
CREATE POLICY "Banking manage update accounts"
  ON public.bank_accounts FOR UPDATE TO authenticated
  USING (public.has_company_permission(company_id, 'banking.feeds.manage')
    OR public.has_company_permission(company_id, 'accounts.manage'))
  WITH CHECK (public.has_company_permission(company_id, 'banking.feeds.manage')
    OR public.has_company_permission(company_id, 'accounts.manage'));

-- ---------------------------------------------------------------------------
-- 6. Saved CSV column mapping per bank account
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.bank_import_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  bank_account_id UUID NOT NULL REFERENCES public.bank_accounts(id) ON DELETE CASCADE,
  mapping JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, bank_account_id)
);

ALTER TABLE public.bank_import_mappings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members view bank import mappings" ON public.bank_import_mappings;
CREATE POLICY "Members view bank import mappings"
  ON public.bank_import_mappings FOR SELECT TO authenticated
  USING (public.is_company_member(company_id));

DROP POLICY IF EXISTS "Banking import manage mappings" ON public.bank_import_mappings;
CREATE POLICY "Banking import manage mappings"
  ON public.bank_import_mappings FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'banking.import'))
  WITH CHECK (public.has_company_permission(company_id, 'banking.import'));

-- ---------------------------------------------------------------------------
-- 7. Bank rules: direction, amount range, bank-account scope, suggested tax code / contact
-- ---------------------------------------------------------------------------
ALTER TABLE public.bank_rules
  ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'any',
  ADD COLUMN IF NOT EXISTS min_amount_minor BIGINT,
  ADD COLUMN IF NOT EXISTS max_amount_minor BIGINT,
  ADD COLUMN IF NOT EXISTS bank_account_id UUID REFERENCES public.bank_accounts(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS tax_code_id UUID REFERENCES public.tax_codes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL;

ALTER TABLE public.bank_rules DROP CONSTRAINT IF EXISTS bank_rules_direction_check;
ALTER TABLE public.bank_rules
  ADD CONSTRAINT bank_rules_direction_check CHECK (direction IN ('any', 'in', 'out'));

-- ---------------------------------------------------------------------------
-- 8. Statement imports: the import record is written first and finalised afterwards (needs UPDATE)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Banking import update imports" ON public.bank_statement_imports;
CREATE POLICY "Banking import update imports"
  ON public.bank_statement_imports FOR UPDATE TO authenticated
  USING (public.has_company_permission(company_id, 'banking.import'))
  WITH CHECK (public.has_company_permission(company_id, 'banking.import'));
