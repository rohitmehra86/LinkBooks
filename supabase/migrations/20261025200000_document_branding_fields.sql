-- Wave 2-F: document branding fields (address, tax number, bank / payment details, notes, logo path).
-- Additive and idempotent. Existing RLS on company_branding already limits writes to
-- company.settings.edit and reads to company members. The accent colour and footer text stay on
-- public.companies (document_theme_color, invoice_footer).

ALTER TABLE public.company_branding
  ADD COLUMN IF NOT EXISTS address_text TEXT,
  ADD COLUMN IF NOT EXISTS tax_number TEXT,
  ADD COLUMN IF NOT EXISTS bank_details TEXT,
  ADD COLUMN IF NOT EXISTS payment_instructions TEXT,
  ADD COLUMN IF NOT EXISTS default_notes TEXT,
  -- Object path inside the private org-logos bucket: {company_id}/logo-{timestamp}.{ext}
  ADD COLUMN IF NOT EXISTS logo_path TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'company_branding_text_lengths'
      AND conrelid = 'public.company_branding'::regclass
  ) THEN
    ALTER TABLE public.company_branding
      ADD CONSTRAINT company_branding_text_lengths CHECK (
        (address_text IS NULL OR char_length(address_text) <= 500)
        AND (tax_number IS NULL OR char_length(tax_number) <= 60)
        AND (bank_details IS NULL OR char_length(bank_details) <= 800)
        AND (payment_instructions IS NULL OR char_length(payment_instructions) <= 800)
        AND (default_notes IS NULL OR char_length(default_notes) <= 1000)
        AND (logo_path IS NULL OR char_length(logo_path) <= 300)
      );
  END IF;
END $$;

-- A logo path must live inside the company's own folder.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'company_branding_logo_path_scope'
      AND conrelid = 'public.company_branding'::regclass
  ) THEN
    ALTER TABLE public.company_branding
      ADD CONSTRAINT company_branding_logo_path_scope CHECK (
        logo_path IS NULL OR logo_path LIKE company_id::text || '/%'
      );
  END IF;
END $$;
