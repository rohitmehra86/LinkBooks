import { useState } from "react";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Building2, Check, ChevronsUpDown, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { companyContextKey, useActiveCompany } from "@/hooks/use-active-company";
import { openDemoCompany, setActiveCompany } from "@/lib/company.functions";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { initialsFrom } from "@/lib/auth-helpers";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** Square initials avatar for an organisation (brand-tinted, never a fake logo). */
export function CompanyAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-md bg-sidebar-primary/20 text-xs font-semibold text-sidebar-primary",
        className,
      )}
    >
      {initialsFrom(name)}
    </span>
  );
}

/**
 * Organisation switcher. Lives at the top of the sidebar (and mobile drawer): initials avatar,
 * organisation name, a "Demo" badge for the Demo Company, and the list of organisations.
 * `collapsed` shows the avatar only.
 */
export function CompanySwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const { data, company, isPending, isError, refetch } = useActiveCompany();
  const switchCompany = useServerFn(setActiveCompany);
  const openDemo = useServerFn(openDemoCompany);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);

  const switchMutation = useMutation({
    mutationFn: async (companyId: string) => {
      setBusyId(companyId);
      await switchCompany({ data: { companyId } });
    },
    onSuccess: async () => {
      await queryClient.cancelQueries();
      queryClient.clear();
      await queryClient.invalidateQueries({ queryKey: companyContextKey });
      await router.invalidate();
      toast.success("Organisation switched");
    },
    onError: (error) => toast.error(friendlyAuthError(error)),
    onSettled: () => setBusyId(null),
  });

  const demoMutation = useMutation({
    mutationFn: async () => openDemo(),
    onSuccess: async (result) => {
      await switchCompany({ data: { companyId: result.id } });
      await queryClient.cancelQueries();
      queryClient.clear();
      await queryClient.invalidateQueries({ queryKey: companyContextKey });
      await router.invalidate();
      navigate({ to: "/", replace: true });
      toast.success("Demo Company ready");
    },
    onError: (error) => toast.error(friendlyAuthError(error)),
  });

  if (isPending) {
    return (
      <div
        className="mx-3 mb-3 flex h-11 items-center gap-2 rounded-md bg-sidebar-accent/60 px-2"
        role="status"
      >
        <Loader2 className="size-4 animate-spin text-sidebar-foreground" />
        {collapsed ? null : (
          <span className="text-xs text-sidebar-foreground">Loading organisations…</span>
        )}
      </div>
    );
  }

  if (isError) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="mx-3 mb-3 border-sidebar-border bg-transparent text-sidebar-foreground hover:bg-sidebar-accent"
        onClick={() => refetch()}
      >
        {collapsed ? "Retry" : "Retry organisations"}
      </Button>
    );
  }

  const companies = data?.companies ?? [];
  const label = company?.name ?? "Select organisation";
  const hasDemo = companies.some((c) => c.is_demo);
  const activeIsDemo = Boolean(company?.is_demo);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Organisation: ${label}. Switch organisation`}
          title={collapsed ? label : undefined}
          className={cn(
            "mx-3 mb-3 flex min-h-11 items-center gap-2.5 rounded-md border border-sidebar-border bg-sidebar-accent/40 p-1.5 text-left text-sidebar-accent-foreground outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring",
            collapsed && "mx-auto w-11 justify-center",
          )}
        >
          <CompanyAvatar name={label} />
          {collapsed ? null : (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium leading-tight">{label}</span>
                <span className="block text-[11px] leading-tight text-sidebar-foreground/70">
                  {activeIsDemo
                    ? "Demo Company · sample data"
                    : (company?.base_currency ?? "Organisation")}
                </span>
              </span>
              {activeIsDemo ? (
                <span className="rounded bg-warning px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-warning-foreground">
                  Demo
                </span>
              ) : null}
              <ChevronsUpDown className="size-4 shrink-0 text-sidebar-foreground/60" aria-hidden />
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Organisations</DropdownMenuLabel>
        {companies.length === 0 ? (
          <DropdownMenuItem disabled>No organisations yet</DropdownMenuItem>
        ) : (
          companies.map((c) => (
            <DropdownMenuItem
              key={c.id}
              disabled={switchMutation.isPending}
              onSelect={(e) => {
                e.preventDefault();
                if (c.id === company?.id) return;
                switchMutation.mutate(c.id);
              }}
            >
              <span className="min-w-0 flex-1 truncate">
                {c.name}
                {c.is_demo ? " (Demo)" : ""}
              </span>
              {busyId === c.id ? (
                <Loader2 className="size-4 animate-spin" />
              ) : c.id === company?.id ? (
                <Check className="size-4" />
              ) : null}
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/onboarding">
            <Plus className="size-4" />
            Create organisation
          </Link>
        </DropdownMenuItem>
        {!hasDemo ? (
          <DropdownMenuItem
            disabled={demoMutation.isPending}
            onSelect={(e) => {
              e.preventDefault();
              demoMutation.mutate();
            }}
          >
            {demoMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Building2 className="size-4" />
            )}
            Open Demo Company
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
