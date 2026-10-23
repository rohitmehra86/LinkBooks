-- Wave 2-F: revocable read-only online invoice links.
-- A link is a 64-hex-character random token (two gen_random_uuid() values, ~240 bits). Only the
-- SHA-256 hash is stored, so a database read cannot reveal a live link. Anonymous visitors can
-- call exactly one function, get_shared_invoice(token), which returns ONE invoice (lines, totals,
-- company letterhead and the customer's name / address) and nothing else.
-- There is no payment provider: the shared page shows payment details as text only.
-- Additive and idempotent.

CREATE TABLE IF NOT EXISTS public.document_share_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type = 'sales_invoice'),
  entity_id UUID NOT NULL REFERENCES public.sales_invoices(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  last_viewed_at TIMESTAMPTZ,
  view_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS document_share_links_entity_idx
  ON public.document_share_links (company_id, entity_type, entity_id);

ALTER TABLE public.document_share_links ENABLE ROW LEVEL SECURITY;

-- Members with sales access may see link metadata (never the token: only its hash is stored).
DROP POLICY IF EXISTS document_share_links_select ON public.document_share_links;
CREATE POLICY document_share_links_select ON public.document_share_links FOR SELECT TO authenticated
  USING (public.has_company_permission(company_id, 'sales.view'));

REVOKE ALL ON public.document_share_links FROM anon, authenticated;
GRANT SELECT (id, company_id, entity_type, entity_id, created_by, created_at, expires_at,
              revoked_at, revoked_by, last_viewed_at, view_count)
  ON public.document_share_links TO authenticated;
GRANT ALL ON public.document_share_links TO service_role;

-- ---------------------------------------------------------------------------
-- Create a link. The plain token is returned once and never stored.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_invoice_share_link(
  _company_id UUID,
  _invoice_id UUID,
  _expires_in_days INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _status TEXT;
  _token TEXT;
  _link_id UUID;
  _expires TIMESTAMPTZ;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT public.has_company_permission(_company_id, 'sales.draft') THEN
    RAISE EXCEPTION 'You do not have permission to share invoices';
  END IF;
  IF _expires_in_days IS NOT NULL AND (_expires_in_days < 1 OR _expires_in_days > 3650) THEN
    RAISE EXCEPTION 'Expiry must be between 1 and 3650 days';
  END IF;

  SELECT status::TEXT INTO _status FROM public.sales_invoices
  WHERE id = _invoice_id AND company_id = _company_id;
  IF _status IS NULL THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  IF _status IN ('draft', 'void') THEN
    RAISE EXCEPTION 'Only authorised invoices can be shared online';
  END IF;

  _token := replace(gen_random_uuid()::TEXT, '-', '') || replace(gen_random_uuid()::TEXT, '-', '');
  _expires := CASE WHEN _expires_in_days IS NULL THEN NULL
                   ELSE now() + make_interval(days => _expires_in_days) END;

  INSERT INTO public.document_share_links (
    company_id, entity_type, entity_id, token_hash, created_by, expires_at
  ) VALUES (
    _company_id, 'sales_invoice', _invoice_id,
    encode(sha256(convert_to(_token, 'UTF8')), 'hex'), _uid, _expires
  ) RETURNING id INTO _link_id;

  PERFORM public.record_audit_event(
    _company_id, 'invoice.share_link.create', 'sales_invoice', _invoice_id,
    jsonb_build_object('link_id', _link_id)
  );
  RETURN jsonb_build_object('link_id', _link_id, 'token', _token, 'expires_at', _expires);
END;
$$;

-- ---------------------------------------------------------------------------
-- Revoke every active link of an invoice.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.revoke_invoice_share_links(_company_id UUID, _invoice_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid UUID := auth.uid();
  _n INTEGER;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'You do not have access to that organisation';
  END IF;
  IF NOT public.has_company_permission(_company_id, 'sales.draft') THEN
    RAISE EXCEPTION 'You do not have permission to manage invoice links';
  END IF;
  UPDATE public.document_share_links
  SET revoked_at = now(), revoked_by = _uid
  WHERE company_id = _company_id AND entity_type = 'sales_invoice'
    AND entity_id = _invoice_id AND revoked_at IS NULL;
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n > 0 THEN
    PERFORM public.record_audit_event(
      _company_id, 'invoice.share_link.revoke', 'sales_invoice', _invoice_id,
      jsonb_build_object('revoked', _n)
    );
  END IF;
  RETURN _n;
END;
$$;

-- ---------------------------------------------------------------------------
-- Public read: ONE invoice by token. No auth required. Returns NULL for an unknown, revoked or
-- expired token (the caller cannot tell which). Draft invoices are never returned.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_shared_invoice(_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _link public.document_share_links%ROWTYPE;
  _inv public.sales_invoices%ROWTYPE;
  _co RECORD;
  _br RECORD;
  _ct RECORD;
  _lines JSONB;
BEGIN
  IF _token IS NULL OR _token !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;

  SELECT * INTO _link FROM public.document_share_links
  WHERE token_hash = encode(sha256(convert_to(_token, 'UTF8')), 'hex')
    AND entity_type = 'sales_invoice'
    AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > now());
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT * INTO _inv FROM public.sales_invoices
  WHERE id = _link.entity_id AND company_id = _link.company_id AND status::TEXT <> 'draft';
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT name, legal_name, document_theme_color, invoice_footer, locale, date_format, base_currency
    INTO _co FROM public.companies WHERE id = _inv.company_id;
  SELECT trading_name, letterhead_line, invoice_email, invoice_phone, logo_url, logo_path,
         address_text, tax_number, bank_details, payment_instructions
    INTO _br FROM public.company_branding WHERE company_id = _inv.company_id;
  SELECT name, billing_address_line1, billing_address_line2, billing_city, billing_region,
         billing_postal, billing_country, tax_number
    INTO _ct FROM public.contacts WHERE id = _inv.contact_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'description', l.description,
    'quantity', l.quantity,
    'unit_price_minor', l.unit_price_minor,
    'discount_minor', l.discount_minor,
    'tax_rate_bps', l.tax_rate_bps,
    'net_minor', l.net_minor,
    'tax_minor', l.tax_minor,
    'gross_minor', l.gross_minor
  ) ORDER BY l.line_order), '[]'::JSONB)
  INTO _lines
  FROM public.sales_invoice_lines l WHERE l.invoice_id = _inv.id;

  UPDATE public.document_share_links
  SET last_viewed_at = now(), view_count = view_count + 1
  WHERE id = _link.id;

  RETURN jsonb_build_object(
    'invoice', jsonb_build_object(
      'invoice_number', _inv.invoice_number,
      'invoice_date', _inv.invoice_date,
      'due_date', _inv.due_date,
      'currency_code', _inv.currency_code,
      'status', _inv.status::TEXT,
      'subtotal_minor', _inv.subtotal_minor,
      'tax_minor', _inv.tax_minor,
      'total_minor', _inv.total_minor,
      'amount_paid_minor', _inv.amount_paid_minor,
      'amount_credited_minor', _inv.amount_credited_minor,
      'memo', _inv.memo
    ),
    'lines', _lines,
    'customer', jsonb_build_object(
      'name', _ct.name,
      'billing_address_line1', _ct.billing_address_line1,
      'billing_address_line2', _ct.billing_address_line2,
      'billing_city', _ct.billing_city,
      'billing_region', _ct.billing_region,
      'billing_postal', _ct.billing_postal,
      'billing_country', _ct.billing_country,
      'tax_number', _ct.tax_number
    ),
    'company', jsonb_build_object(
      'name', _co.name,
      'legal_name', _co.legal_name,
      'document_theme_color', _co.document_theme_color,
      'invoice_footer', _co.invoice_footer,
      'locale', _co.locale,
      'date_format', _co.date_format,
      'base_currency', _co.base_currency
    ),
    'branding', jsonb_build_object(
      'trading_name', _br.trading_name,
      'letterhead_line', _br.letterhead_line,
      'invoice_email', _br.invoice_email,
      'invoice_phone', _br.invoice_phone,
      'logo_url', _br.logo_url,
      'logo_path', _br.logo_path,
      'address_text', _br.address_text,
      'tax_number', _br.tax_number,
      'bank_details', _br.bank_details,
      'payment_instructions', _br.payment_instructions
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_invoice_share_link(UUID, UUID, INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.revoke_invoice_share_links(UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_shared_invoice(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_invoice_share_link(UUID, UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_invoice_share_links(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_shared_invoice(TEXT) TO anon, authenticated;
