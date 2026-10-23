-- Scratch stubs mirroring only what the Workstream C migrations touch.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.uid', true), '')::uuid $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE public.companies (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, is_demo boolean DEFAULT false);
CREATE TABLE public.contacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid, name text);
CREATE TABLE public.tax_codes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid);
CREATE TABLE public.accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid, code text, name text);
CREATE TABLE public.company_members (company_id uuid, user_id uuid, status text DEFAULT 'active', role text);
CREATE TABLE public.role_permissions (role text, permission text);

CREATE OR REPLACE FUNCTION public.is_company_member(_company_id uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (SELECT 1 FROM public.company_members WHERE company_id=_company_id AND user_id=auth.uid() AND status='active') $$;
CREATE OR REPLACE FUNCTION public.has_company_permission(_company_id uuid, _permission text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (SELECT 1 FROM public.company_members m JOIN public.role_permissions rp ON rp.role=m.role
    WHERE m.company_id=_company_id AND m.user_id=auth.uid() AND m.status='active' AND rp.permission=_permission) $$;

CREATE TYPE public.journal_status AS ENUM ('draft','posted','void');
CREATE TYPE public.journal_source_type AS ENUM ('manual','bank_transaction','bank_transfer');
CREATE TYPE public.bank_txn_status AS ENUM ('uncategorised','matched','reconciled','excluded');

CREATE TABLE public.journals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, journal_number text,
  journal_date date NOT NULL, status public.journal_status NOT NULL DEFAULT 'posted',
  source_type public.journal_source_type NOT NULL DEFAULT 'manual', source_id uuid, idempotency_key text, memo text,
  currency_code char(3) NOT NULL DEFAULT 'GBP',
  reverses_journal_id uuid, reversed_by_journal_id uuid, created_by uuid, created_at timestamptz DEFAULT now(),
  UNIQUE (company_id, idempotency_key));
CREATE TABLE public.journal_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), journal_id uuid NOT NULL REFERENCES public.journals(id) ON DELETE CASCADE,
  company_id uuid NOT NULL, line_no int NOT NULL, account_id uuid NOT NULL, description text,
  debit_minor bigint NOT NULL DEFAULT 0 CHECK (debit_minor >= 0), credit_minor bigint NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  CONSTRAINT one_side CHECK ((debit_minor>0 AND credit_minor=0) OR (credit_minor>0 AND debit_minor=0)));

CREATE TABLE public.audit_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid, action text, entity_type text, entity_id uuid, details jsonb);
CREATE OR REPLACE FUNCTION public.record_audit_event(_company_id uuid,_action text,_entity_type text,_entity_id uuid DEFAULT NULL,_details jsonb DEFAULT '{}') RETURNS uuid LANGUAGE sql AS $$
  INSERT INTO public.audit_events(company_id,action,entity_type,entity_id,details) VALUES (_company_id,_action,_entity_type,_entity_id,_details) RETURNING id $$;

-- Simplified post_journal / reverse_journal with the real idempotency + reversal semantics
CREATE OR REPLACE FUNCTION public.post_journal(payload jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE _id uuid; _co uuid := (payload->>'company_id')::uuid; _k text := payload->>'idempotency_key'; l jsonb; n int := 0;
BEGIN
  IF _k IS NOT NULL THEN SELECT id INTO _id FROM public.journals WHERE company_id=_co AND idempotency_key=_k; IF _id IS NOT NULL THEN RETURN _id; END IF; END IF;
  INSERT INTO public.journals(company_id,journal_date,memo,currency_code,source_type,source_id,idempotency_key,created_by)
  VALUES (_co,(payload->>'journal_date')::date,payload->>'memo',payload->>'currency_code',COALESCE(payload->>'source_type','manual')::public.journal_source_type,
          (payload->>'source_id')::uuid,_k,auth.uid()) RETURNING id INTO _id;
  FOR l IN SELECT * FROM jsonb_array_elements(payload->'lines') LOOP
    n := n+1;
    INSERT INTO public.journal_lines(journal_id,company_id,line_no,account_id,description,debit_minor,credit_minor)
    VALUES (_id,_co,n,(l->>'account_id')::uuid,l->>'description',(l->>'debit_minor')::bigint,(l->>'credit_minor')::bigint);
  END LOOP;
  RETURN _id;
END $$;
CREATE OR REPLACE FUNCTION public.reverse_journal(_journal_id uuid,_idempotency_key text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE j record; _new uuid; ln record; n int := 0;
BEGIN
  SELECT * INTO j FROM public.journals WHERE id=_journal_id;
  INSERT INTO public.journals(company_id,journal_date,memo,currency_code,source_type,source_id,idempotency_key,reverses_journal_id,created_by)
  VALUES (j.company_id,j.journal_date,'Reversal',j.currency_code,j.source_type,j.source_id,_idempotency_key,j.id,auth.uid()) RETURNING id INTO _new;
  FOR ln IN SELECT * FROM public.journal_lines WHERE journal_id=j.id LOOP
    n := n+1;
    INSERT INTO public.journal_lines(journal_id,company_id,line_no,account_id,description,debit_minor,credit_minor)
    VALUES (_new,j.company_id,n,ln.account_id,ln.description,ln.credit_minor,ln.debit_minor);
  END LOOP;
  UPDATE public.journals SET reversed_by_journal_id=_new WHERE id=j.id;
  RETURN _new;
END $$;

-- Tables as created by the earlier real migrations
CREATE TABLE public.bank_accounts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL, currency_code char(3) NOT NULL, gl_account_id uuid NOT NULL REFERENCES public.accounts(id), is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(), UNIQUE (company_id, gl_account_id));
CREATE TABLE public.bank_statement_imports (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, bank_account_id uuid NOT NULL, filename text, status text DEFAULT 'completed');
CREATE TABLE public.bank_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  bank_account_id uuid NOT NULL REFERENCES public.bank_accounts(id) ON DELETE CASCADE, txn_date date NOT NULL, amount_minor bigint NOT NULL, description text,
  external_id text, status public.bank_txn_status NOT NULL DEFAULT 'uncategorised', created_at timestamptz DEFAULT now(), UNIQUE (company_id, bank_account_id, external_id));
CREATE TABLE public.reconciliation_links (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, bank_transaction_id uuid NOT NULL REFERENCES public.bank_transactions(id) ON DELETE CASCADE,
  journal_line_id uuid NOT NULL REFERENCES public.journal_lines(id) ON DELETE RESTRICT, created_at timestamptz DEFAULT now(), created_by uuid,
  UNIQUE (bank_transaction_id), UNIQUE (journal_line_id));
ALTER TABLE public.bank_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reconciliation_links ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.bank_rules (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, name text, match_pattern text, offset_account_id uuid);
CREATE TABLE public.bank_transfers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, from_bank_account_id uuid NOT NULL REFERENCES public.bank_accounts(id),
  to_bank_account_id uuid NOT NULL REFERENCES public.bank_accounts(id), transfer_date date NOT NULL, amount_minor bigint NOT NULL CHECK (amount_minor>0), currency_code char(3) NOT NULL,
  memo text, posted_journal_id uuid REFERENCES public.journals(id), void_journal_id uuid, status text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  created_by uuid, created_at timestamptz DEFAULT now(), CONSTRAINT distinct_acc CHECK (from_bank_account_id <> to_bank_account_id));
CREATE TABLE public.bank_coding_history (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, payee_normalized text NOT NULL, description_sample text,
  offset_account_id uuid NOT NULL REFERENCES public.accounts(id), direction text NOT NULL CHECK (direction IN ('in','out')), times_used int NOT NULL DEFAULT 1,
  last_used_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz DEFAULT now(), UNIQUE (company_id, payee_normalized, offset_account_id, direction));
CREATE TABLE public.reconciliation_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL, bank_account_id uuid NOT NULL REFERENCES public.bank_accounts(id) ON DELETE CASCADE,
  statement_date date NOT NULL, statement_balance_minor bigint NOT NULL, reconciled_balance_minor bigint, status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','void')),
  completed_at timestamptz, completed_by uuid, notes text, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
