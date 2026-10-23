-- Wave 2-F: e-mail send history and invoice reminder settings.
-- email_outbox records ONLY real send attempts made through a configured provider
-- (status 'sent' with the provider message id, or 'failed' with the provider error).
-- Nothing is written when no provider is configured. Clients cannot write the table directly:
-- rows are created through record_email_outbox (SECURITY DEFINER, permission checked).
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS public.email_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  template TEXT NOT NULL,
  to_addresses TEXT[] NOT NULL,
  subject TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_message_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  error TEXT,
  sent_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT email_outbox_recipients CHECK (cardinality(to_addresses) BETWEEN 1 AND 10)
);

CREATE INDEX IF NOT EXISTS email_outbox_entity_idx
  ON public.email_outbox (company_id, entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS email_outbox_company_idx
  ON public.email_outbox (company_id, created_at DESC);

ALTER TABLE public.email_outbox ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS email_outbox_select ON public.email_outbox;
CREATE POLICY email_outbox_select ON public.email_outbox FOR SELECT TO authenticated
  USING (
    public.has_company_permission(company_id, 'sales.view')
    OR public.has_company_permission(company_id, 'purchases.view')
  );

REVOKE ALL ON public.email_outbox FROM anon, authenticated;
GRANT SELECT ON public.email_outbox TO authenticated;
GRANT ALL ON public.email_outbox TO service_role;

CREATE OR REPLACE FUNCTION public.record_email_outbox(payload JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _company_id UUID := NULLIF(payload->>'company_id', '')::UUID;
  _entity_type TEXT := payload->>'entity_type';
  _entity_id UUID := NULLIF(payload->>'entity_id', '')::UUID;
  _status TEXT := payload->>'status';
  _to TEXT[];
  _id UUID;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF _company_id IS NULL OR _entity_type IS NULL THEN
    RAISE EXCEPTION 'company_id and entity_type are required';
  END IF;
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  -- Statements are sent for a contact; other documents use their own entity type.
  IF NOT (
    public.can_access_attachment(_company_id, _entity_type, 'manage')
    OR (
      _entity_type = 'contact'
      AND (
        public.has_company_permission(_company_id, 'sales.draft')
        OR public.has_company_permission(_company_id, 'purchases.draft')
      )
    )
  ) THEN
    RAISE EXCEPTION 'You do not have permission to send this document';
  END IF;
  IF _status NOT IN ('sent', 'failed') THEN
    RAISE EXCEPTION 'status must be sent or failed';
  END IF;
  SELECT ARRAY(SELECT jsonb_array_elements_text(payload->'to')) INTO _to;
  IF _to IS NULL OR cardinality(_to) NOT BETWEEN 1 AND 10 THEN
    RAISE EXCEPTION 'Between 1 and 10 recipients are required';
  END IF;

  INSERT INTO public.email_outbox (
    company_id, entity_type, entity_id, template, to_addresses, subject,
    provider, provider_message_id, status, error, sent_by
  ) VALUES (
    _company_id, _entity_type, _entity_id,
    left(COALESCE(payload->>'template', 'custom'), 40),
    _to,
    left(COALESCE(payload->>'subject', ''), 300),
    left(COALESCE(payload->>'provider', 'unknown'), 40),
    left(NULLIF(payload->>'provider_message_id', ''), 200),
    _status,
    left(NULLIF(payload->>'error', ''), 500),
    _uid
  ) RETURNING id INTO _id;
  RETURN _id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_email_outbox(JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_email_outbox(JSONB) TO authenticated;

-- ---------------------------------------------------------------------------
-- Reminder settings (one row per company). Reminders are sent manually from the invoice page
-- or in a batch from the Reminders screen; there is no background sender.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.company_reminder_settings (
  company_id UUID PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  first_after_days INTEGER NOT NULL DEFAULT 7 CHECK (first_after_days BETWEEN 0 AND 365),
  repeat_every_days INTEGER NOT NULL DEFAULT 14 CHECK (repeat_every_days BETWEEN 1 AND 365),
  max_reminders INTEGER NOT NULL DEFAULT 3 CHECK (max_reminders BETWEEN 1 AND 12),
  include_bank_details BOOLEAN NOT NULL DEFAULT true,
  updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.company_reminder_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS company_reminder_settings_select ON public.company_reminder_settings;
CREATE POLICY company_reminder_settings_select ON public.company_reminder_settings
  FOR SELECT TO authenticated USING (public.is_company_member(company_id));

DROP POLICY IF EXISTS company_reminder_settings_write ON public.company_reminder_settings;
CREATE POLICY company_reminder_settings_write ON public.company_reminder_settings
  FOR ALL TO authenticated
  USING (public.has_company_permission(company_id, 'company.settings.edit'))
  WITH CHECK (public.has_company_permission(company_id, 'company.settings.edit'));

REVOKE ALL ON public.company_reminder_settings FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.company_reminder_settings TO authenticated;
