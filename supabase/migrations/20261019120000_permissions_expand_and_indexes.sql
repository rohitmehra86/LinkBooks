-- Additive foundation hardening (non-destructive).
-- Does NOT disable RLS. Does NOT drop tables or rewrite financial history.
-- Apply only to development/staging after review. Do not apply to production
-- without explicit approval.

-- ---------------------------------------------------------------------------
-- 1) Expand role_permissions catalogue (idempotent)
-- ---------------------------------------------------------------------------
INSERT INTO public.role_permissions (role, permission) VALUES
  -- owner already has core keys; add expanded catalogue
  ('owner','audit.view'),
  ('owner','demo.reset'),
  ('owner','sales.view'),('owner','sales.draft'),('owner','sales.authorise'),('owner','sales.void'),('owner','sales.payment'),
  ('owner','purchases.view'),('owner','purchases.draft'),('owner','purchases.authorise'),('owner','purchases.payment'),
  ('owner','expenses.submit'),('owner','expenses.approve'),
  ('owner','banking.view'),('owner','banking.import'),('owner','banking.categorise'),('owner','banking.reconcile'),('owner','banking.feeds.manage'),
  ('owner','journals.manual'),('owner','accounts.manage'),('owner','periods.lock'),('owner','periods.unlock'),
  ('owner','reports.view'),('owner','reports.export'),
  ('owner','tax.settings'),('owner','contacts.manage'),('owner','products.manage'),
  ('owner','ai.use'),('owner','ai.apply_suggestion'),

  ('admin','audit.view'),('admin','demo.reset'),
  ('admin','sales.view'),('admin','sales.draft'),('admin','sales.authorise'),('admin','sales.void'),('admin','sales.payment'),
  ('admin','purchases.view'),('admin','purchases.draft'),('admin','purchases.authorise'),('admin','purchases.payment'),
  ('admin','expenses.submit'),('admin','expenses.approve'),
  ('admin','banking.view'),('admin','banking.import'),('admin','banking.categorise'),('admin','banking.reconcile'),('admin','banking.feeds.manage'),
  ('admin','journals.manual'),('admin','accounts.manage'),('admin','periods.lock'),('admin','periods.unlock'),
  ('admin','reports.view'),('admin','reports.export'),
  ('admin','tax.settings'),('admin','contacts.manage'),('admin','products.manage'),
  ('admin','ai.use'),('admin','ai.apply_suggestion'),

  ('accountant','audit.view'),
  ('accountant','sales.view'),('accountant','sales.draft'),('accountant','sales.authorise'),('accountant','sales.void'),('accountant','sales.payment'),
  ('accountant','purchases.view'),('accountant','purchases.draft'),('accountant','purchases.authorise'),('accountant','purchases.payment'),
  ('accountant','expenses.submit'),('accountant','expenses.approve'),
  ('accountant','banking.view'),('accountant','banking.import'),('accountant','banking.categorise'),('accountant','banking.reconcile'),
  ('accountant','journals.manual'),('accountant','accounts.manage'),('accountant','periods.lock'),
  ('accountant','reports.view'),('accountant','reports.export'),
  ('accountant','tax.settings'),('accountant','contacts.manage'),('accountant','products.manage'),
  ('accountant','ai.use'),('accountant','ai.apply_suggestion'),

  ('bookkeeper','audit.view'),
  ('bookkeeper','sales.view'),('bookkeeper','sales.draft'),('bookkeeper','sales.authorise'),('bookkeeper','sales.void'),('bookkeeper','sales.payment'),
  ('bookkeeper','purchases.view'),('bookkeeper','purchases.draft'),('bookkeeper','purchases.authorise'),('bookkeeper','purchases.payment'),
  ('bookkeeper','expenses.submit'),
  ('bookkeeper','banking.view'),('bookkeeper','banking.import'),('bookkeeper','banking.categorise'),('bookkeeper','banking.reconcile'),
  ('bookkeeper','journals.manual'),
  ('bookkeeper','reports.view'),('bookkeeper','reports.export'),
  ('bookkeeper','contacts.manage'),('bookkeeper','products.manage'),
  ('bookkeeper','ai.use'),('bookkeeper','ai.apply_suggestion'),

  ('staff','sales.view'),('staff','sales.draft'),
  ('staff','purchases.view'),('staff','purchases.draft'),
  ('staff','expenses.submit'),
  ('staff','banking.view'),('staff','banking.categorise'),
  ('staff','reports.view'),
  ('staff','contacts.manage'),
  ('staff','ai.use'),

  ('read_only','sales.view'),
  ('read_only','purchases.view'),
  ('read_only','banking.view'),
  ('read_only','reports.view'),('read_only','reports.export'),
  ('read_only','audit.view'),
  ('read_only','ai.use')
ON CONFLICT (role, permission) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2) Supporting indexes (IF NOT EXISTS — safe to re-run)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS company_members_company_idx
  ON public.company_members (company_id);

CREATE INDEX IF NOT EXISTS company_members_company_status_idx
  ON public.company_members (company_id, status);

CREATE INDEX IF NOT EXISTS companies_created_by_idx
  ON public.companies (created_by);

CREATE INDEX IF NOT EXISTS company_invitations_company_idx
  ON public.company_invitations (company_id);

CREATE INDEX IF NOT EXISTS company_invitations_email_idx
  ON public.company_invitations (lower(email));

CREATE INDEX IF NOT EXISTS profiles_last_company_idx
  ON public.profiles (last_company_id)
  WHERE last_company_id IS NOT NULL;
