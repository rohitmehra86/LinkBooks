-- Bills workspace: awaiting_approval status for approval queue tab.

DO $$ BEGIN
  ALTER TYPE public.purchase_doc_status ADD VALUE IF NOT EXISTS 'awaiting_approval';
EXCEPTION
  WHEN duplicate_object THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

-- Postgres < 15 may not support IF NOT EXISTS on enum; fallback
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON e.enumtypid = t.oid
    WHERE t.typname = 'purchase_doc_status' AND e.enumlabel = 'awaiting_approval'
  ) THEN
    ALTER TYPE public.purchase_doc_status ADD VALUE 'awaiting_approval';
  END IF;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

ALTER TABLE public.purchase_bills
  ADD COLUMN IF NOT EXISTS submitted_for_approval_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submitted_for_approval_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approval_comment TEXT,
  ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS rejected_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

CREATE INDEX IF NOT EXISTS purchase_bills_company_status_due_idx
  ON public.purchase_bills (company_id, status, due_date);
