-- AI Accounting Assistant: suggestions store + usage/rate-limit log.
-- Apply when approved. Keys stay in server env, not this migration.

CREATE TABLE IF NOT EXISTS public.ai_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  intent TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'validated', 'rejected', 'applied', 'invalid')),
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  validation_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  applied_journal_id UUID REFERENCES public.journals(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_suggestions_company_idx
  ON public.ai_suggestions (company_id, created_at DESC);

ALTER TABLE public.ai_suggestions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members with ai.use can read suggestions" ON public.ai_suggestions;
CREATE POLICY "Members with ai.use can read suggestions"
  ON public.ai_suggestions FOR SELECT TO authenticated
  USING (
    public.is_company_member(company_id)
    AND public.has_company_permission(company_id, 'ai.use')
  );

DROP POLICY IF EXISTS "Members with ai.use can insert suggestions" ON public.ai_suggestions;
CREATE POLICY "Members with ai.use can insert suggestions"
  ON public.ai_suggestions FOR INSERT TO authenticated
  WITH CHECK (
    public.has_company_permission(company_id, 'ai.use')
    AND created_by = auth.uid()
  );

DROP POLICY IF EXISTS "Applicants can update own pending suggestions" ON public.ai_suggestions;
CREATE POLICY "Applicants can update own pending suggestions"
  ON public.ai_suggestions FOR UPDATE TO authenticated
  USING (
    public.has_company_permission(company_id, 'ai.apply_suggestion')
    OR (created_by = auth.uid() AND public.has_company_permission(company_id, 'ai.use'))
  )
  WITH CHECK (public.is_company_member(company_id));

GRANT SELECT, INSERT, UPDATE ON public.ai_suggestions TO authenticated;

CREATE TABLE IF NOT EXISTS public.ai_usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  intent TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  prompt_chars INTEGER NOT NULL DEFAULT 0,
  estimated_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_usage_company_user_idx
  ON public.ai_usage_events (company_id, user_id, created_at DESC);

ALTER TABLE public.ai_usage_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own ai usage" ON public.ai_usage_events;
CREATE POLICY "Users read own ai usage"
  ON public.ai_usage_events FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    AND public.is_company_member(company_id)
  );

-- Inserts via SECURITY DEFINER helper only (no direct client insert of spoofed usage).
CREATE OR REPLACE FUNCTION public.record_ai_usage(
  _company_id UUID,
  _intent TEXT,
  _status TEXT,
  _provider TEXT DEFAULT NULL,
  _model TEXT DEFAULT NULL,
  _prompt_chars INTEGER DEFAULT 0,
  _estimated_tokens INTEGER DEFAULT 0,
  _latency_ms INTEGER DEFAULT NULL,
  _error_code TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _id UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Not signed in'; END IF;
  IF NOT public.is_company_member(_company_id) THEN
    RAISE EXCEPTION 'Not a member of this company';
  END IF;
  INSERT INTO public.ai_usage_events (
    company_id, user_id, intent, status, provider, model,
    prompt_chars, estimated_tokens, latency_ms, error_code
  ) VALUES (
    _company_id, auth.uid(), _intent, _status, _provider, _model,
    COALESCE(_prompt_chars, 0), COALESCE(_estimated_tokens, 0), _latency_ms, _error_code
  ) RETURNING id INTO _id;
  RETURN _id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_ai_usage(
  UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, INTEGER, TEXT
) TO authenticated;

CREATE OR REPLACE FUNCTION public.count_ai_usage_last_hour(_company_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _n INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN RETURN 0; END IF;
  SELECT COUNT(*)::INTEGER INTO _n
  FROM public.ai_usage_events
  WHERE company_id = _company_id
    AND user_id = auth.uid()
    AND created_at > now() - interval '1 hour'
    AND status IN ('ok', 'provider_error', 'rate_limited', 'validation_error');
  RETURN COALESCE(_n, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION public.count_ai_usage_last_hour(UUID) TO authenticated;
