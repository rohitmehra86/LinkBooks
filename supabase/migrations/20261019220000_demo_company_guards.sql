-- Demo Company guards: cannot flip is_demo off after create; seed helpers stay demo-only.

CREATE OR REPLACE FUNCTION public.prevent_is_demo_downgrade()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.is_demo IS TRUE AND NEW.is_demo IS FALSE THEN
    RAISE EXCEPTION 'Demo Company flag cannot be cleared; create a separate live organisation instead';
  END IF;
  IF OLD.is_demo IS FALSE AND NEW.is_demo IS TRUE THEN
    RAISE EXCEPTION 'Live organisations cannot be converted into Demo Company';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS companies_is_demo_guard ON public.companies;
CREATE TRIGGER companies_is_demo_guard
  BEFORE UPDATE ON public.companies
  FOR EACH ROW EXECUTE FUNCTION public.prevent_is_demo_downgrade();

COMMENT ON FUNCTION public.reset_demo_company(UUID) IS
  'Deletes transactional data for is_demo companies only, then reseeds masters. Never touches non-demo companies.';
