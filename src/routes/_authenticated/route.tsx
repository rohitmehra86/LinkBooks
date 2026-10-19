import { useEffect } from "react";
import { createFileRoute, Outlet, redirect, useNavigate, useRouterState } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { AppShell } from "@/components/layout/AppShell";
import { useActiveCompany } from "@/hooks/use-active-company";
import { ErrorState } from "@/components/common/states";
import { friendlyAuthError } from "@/lib/auth-helpers";

/**
 * Every LinkBooks application page lives under this gate. The session lives in
 * browser storage, so this subtree opts out of server rendering and checks the
 * session on the client before any child route renders.
 *
 * This gate is the user-experience layer only — data access is enforced
 * server-side by `requireSupabaseAuth` and database row-level security.
 */
export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async ({ location }) => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      throw redirect({
        to: "/auth",
        search: { redirect: location.href },
      });
    }
    return { user: data.user };
  },
  pendingComponent: () => (
    <div className="grid min-h-screen place-items-center bg-background">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
      <span className="sr-only">Loading LinkBooks</span>
    </div>
  ),
  component: AuthenticatedLayout,
});

function AuthenticatedLayout() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data, isPending, isError, error, refetch } = useActiveCompany();
  const onOnboarding = pathname.startsWith("/onboarding");

  useEffect(() => {
    if (isPending || isError) return;
    const count = data?.companies.length ?? 0;
    if (count === 0 && !onOnboarding) {
      void navigate({ to: "/onboarding", replace: true });
    }
  }, [data?.companies.length, isError, isPending, navigate, onOnboarding]);

  if (isPending) {
    return (
      <div className="grid min-h-screen place-items-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading organisations</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="mx-auto flex min-h-screen max-w-lg items-center px-4">
        <ErrorState
          title="Could not load your organisations"
          description={friendlyAuthError(error)}
          onRetry={() => refetch()}
        />
      </div>
    );
  }

  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}
