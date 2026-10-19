import { useState } from "react";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Building2, Check, ChevronDown, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { companyContextKey, useActiveCompany } from "@/hooks/use-active-company";
import { openDemoCompany, setActiveCompany } from "@/lib/company.functions";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function CompanySwitcher() {
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
      <Button variant="outline" size="sm" className="hidden sm:inline-flex" disabled>
        <Loader2 className="size-4 animate-spin" />
        Loading…
      </Button>
    );
  }

  if (isError) {
    return (
      <Button variant="outline" size="sm" className="hidden sm:inline-flex" onClick={() => refetch()}>
        Retry organisations
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
        <Button
          variant="outline"
          size="sm"
          className={
            activeIsDemo
              ? "hidden max-w-[260px] border-warning/50 bg-warning/10 sm:inline-flex"
              : "hidden max-w-[220px] sm:inline-flex"
          }
        >
          <Building2 className="size-4 shrink-0" />
          <span className="truncate">
            {activeIsDemo ? "Demo · " : ""}
            {label}
          </span>
          <ChevronDown className="size-4 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
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
            {demoMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : <Building2 className="size-4" />}
            Open Demo Company
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
