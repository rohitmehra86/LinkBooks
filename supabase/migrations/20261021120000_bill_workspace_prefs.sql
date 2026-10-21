-- Per-user / per-organisation UI preferences for New Bill workspace + duplicate policy.

CREATE TABLE IF NOT EXISTS public.user_ui_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  preference_key TEXT NOT NULL,
  preference_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT user_ui_preferences_key_nonempty CHECK (length(trim(preference_key)) > 0),
  UNIQUE (company_id, user_id, preference_key)
);

CREATE INDEX IF NOT EXISTS user_ui_preferences_lookup_idx
  ON public.user_ui_preferences (company_id, user_id, preference_key);

ALTER TABLE public.user_ui_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own ui prefs" ON public.user_ui_preferences;
CREATE POLICY "Users manage own ui prefs" ON public.user_ui_preferences
  FOR ALL TO authenticated
  USING (user_id = auth.uid() AND public.is_company_member(company_id))
  WITH CHECK (user_id = auth.uid() AND public.is_company_member(company_id));

-- Organisation duplicate-bill policy (settings-driven)
ALTER TABLE public.company_workflow_settings
  ADD COLUMN IF NOT EXISTS purchases_duplicate_policy TEXT NOT NULL DEFAULT 'warn',
  ADD COLUMN IF NOT EXISTS purchases_bill_view_mode TEXT NOT NULL DEFAULT 'professional';

ALTER TABLE public.company_workflow_settings
  DROP CONSTRAINT IF EXISTS company_workflow_settings_dup_policy_check;
ALTER TABLE public.company_workflow_settings
  ADD CONSTRAINT company_workflow_settings_dup_policy_check
  CHECK (purchases_duplicate_policy IN ('warn', 'confirm', 'require_reason', 'block'));

ALTER TABLE public.company_workflow_settings
  DROP CONSTRAINT IF EXISTS company_workflow_settings_bill_view_check;
ALTER TABLE public.company_workflow_settings
  ADD CONSTRAINT company_workflow_settings_bill_view_check
  CHECK (purchases_bill_view_mode IN ('basic', 'professional', 'custom'));

-- Optional override reason on bills when policy requires it
ALTER TABLE public.purchase_bills
  ADD COLUMN IF NOT EXISTS duplicate_override_reason TEXT;
