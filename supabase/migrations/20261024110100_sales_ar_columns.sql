-- Workstream B (Sales / AR): additive columns, soft-reversal of allocations, draft guard.
-- Additive and idempotent. No data is dropped; posted journals are never touched.

-- ---------------------------------------------------------------------------
-- Void metadata (AR-05 / AR-21): who voided, when, why, and on which accounting date.
-- ---------------------------------------------------------------------------
ALTER TABLE public.sales_receipts
  ADD COLUMN IF NOT EXISTS void_reason TEXT,
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS void_date DATE,
  ADD COLUMN IF NOT EXISTS fx_rate_to_base NUMERIC(18, 8) NOT NULL DEFAULT 1;

ALTER TABLE public.sales_credit_notes
  ADD COLUMN IF NOT EXISTS void_reason TEXT,
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS void_date DATE,
  ADD COLUMN IF NOT EXISTS fx_rate_to_base NUMERIC(18, 8) NOT NULL DEFAULT 1;

ALTER TABLE public.sales_invoices
  ADD COLUMN IF NOT EXISTS void_reason TEXT,
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS void_date DATE,
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fx_rate_to_base NUMERIC(18, 8) NOT NULL DEFAULT 1;

-- Quote pipeline dates (AR-17) + FX (AR-10)
ALTER TABLE public.sales_quotes
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS declined_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fx_rate_to_base NUMERIC(18, 8) NOT NULL DEFAULT 1;

-- ---------------------------------------------------------------------------
-- Tax code on every sales line (AR-19). Invoice lines already have tax_code_id.
-- ---------------------------------------------------------------------------
ALTER TABLE public.sales_invoice_lines
  ADD COLUMN IF NOT EXISTS tax_code_id UUID REFERENCES public.tax_codes(id) ON DELETE SET NULL;
ALTER TABLE public.sales_credit_note_lines
  ADD COLUMN IF NOT EXISTS tax_code_id UUID REFERENCES public.tax_codes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS product_id UUID;
ALTER TABLE public.sales_quote_lines
  ADD COLUMN IF NOT EXISTS tax_code_id UUID REFERENCES public.tax_codes(id) ON DELETE SET NULL;
ALTER TABLE public.sales_recurring_invoice_lines
  ADD COLUMN IF NOT EXISTS tax_code_id UUID REFERENCES public.tax_codes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS product_id UUID;

-- ---------------------------------------------------------------------------
-- Recurring invoices (AR-28 / AR-29): end date, occurrence count, own terms.
-- ---------------------------------------------------------------------------
ALTER TABLE public.sales_recurring_invoices
  ADD COLUMN IF NOT EXISTS end_date DATE,
  ADD COLUMN IF NOT EXISTS max_occurrences INT CHECK (max_occurrences IS NULL OR max_occurrences > 0),
  ADD COLUMN IF NOT EXISTS occurrences_generated INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payment_terms_days INT CHECK (payment_terms_days IS NULL OR payment_terms_days >= 0);

-- ---------------------------------------------------------------------------
-- Allocations become reversible without losing history (AR-05):
--   * allocated_on  : effective date of the allocation (as-at ageing, AR-08)
--   * reversed_on   : set when the allocation is removed / its receipt is voided
-- Active allocation = reversed_on IS NULL. Invoice paid/credited amounts equal the
-- sum of ACTIVE allocations. The old UNIQUE(receipt_id|credit_note_id, invoice_id)
-- constraints are replaced by partial unique indexes over active rows only.
-- ---------------------------------------------------------------------------
ALTER TABLE public.sales_receipt_allocations
  ADD COLUMN IF NOT EXISTS allocated_on DATE,
  ADD COLUMN IF NOT EXISTS reversed_on DATE,
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversed_by UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS reverse_reason TEXT;

ALTER TABLE public.sales_credit_allocations
  ADD COLUMN IF NOT EXISTS allocated_on DATE,
  ADD COLUMN IF NOT EXISTS reversed_on DATE,
  ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversed_by UUID REFERENCES auth.users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS reverse_reason TEXT;

UPDATE public.sales_receipt_allocations a
SET allocated_on = r.receipt_date
FROM public.sales_receipts r
WHERE a.receipt_id = r.id AND a.allocated_on IS NULL;

UPDATE public.sales_receipt_allocations
SET allocated_on = created_at::date
WHERE allocated_on IS NULL;

UPDATE public.sales_credit_allocations
SET allocated_on = created_at::date
WHERE allocated_on IS NULL;

ALTER TABLE public.sales_receipt_allocations ALTER COLUMN allocated_on SET DEFAULT CURRENT_DATE;
ALTER TABLE public.sales_credit_allocations ALTER COLUMN allocated_on SET DEFAULT CURRENT_DATE;

DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT conrelid::regclass::text AS tbl, conname
    FROM pg_constraint
    WHERE contype = 'u'
      AND conrelid IN (
        'public.sales_receipt_allocations'::regclass,
        'public.sales_credit_allocations'::regclass
      )
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', c.tbl, c.conname);
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS sales_receipt_allocations_active_uq
  ON public.sales_receipt_allocations (receipt_id, invoice_id) WHERE reversed_on IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sales_credit_allocations_active_uq
  ON public.sales_credit_allocations (credit_note_id, invoice_id) WHERE reversed_on IS NULL;
CREATE INDEX IF NOT EXISTS sales_receipt_allocations_invoice_idx
  ON public.sales_receipt_allocations (invoice_id);
CREATE INDEX IF NOT EXISTS sales_credit_allocations_invoice_idx
  ON public.sales_credit_allocations (invoice_id);

-- Search / list performance (AR-27)
CREATE INDEX IF NOT EXISTS sales_invoices_company_date_idx
  ON public.sales_invoices (company_id, invoice_date DESC);
CREATE INDEX IF NOT EXISTS sales_invoices_company_contact_idx
  ON public.sales_invoices (company_id, contact_id, status);

-- ---------------------------------------------------------------------------
-- AR-31: a draft invoice cannot carry paid / credited amounts.
-- Added NOT VALID so existing (demo) drift does not block the migration; it is only
-- VALIDATEd below when the data is already clean. New writes are checked immediately.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sales_invoices_draft_has_no_payments'
      AND conrelid = 'public.sales_invoices'::regclass
  ) THEN
    ALTER TABLE public.sales_invoices
      ADD CONSTRAINT sales_invoices_draft_has_no_payments
      CHECK (status <> 'draft' OR (amount_paid_minor = 0 AND amount_credited_minor = 0))
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.sales_invoices
    WHERE status = 'draft' AND (amount_paid_minor <> 0 OR amount_credited_minor <> 0)
  ) THEN
    ALTER TABLE public.sales_invoices VALIDATE CONSTRAINT sales_invoices_draft_has_no_payments;
  ELSE
    RAISE NOTICE 'sales_invoices_draft_has_no_payments left NOT VALID: draft invoices with paid/credited amounts exist. Clean them, then run ALTER TABLE public.sales_invoices VALIDATE CONSTRAINT sales_invoices_draft_has_no_payments;';
  END IF;
END $$;
