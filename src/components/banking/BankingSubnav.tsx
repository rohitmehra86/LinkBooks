import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveCompany } from "@/hooks/use-active-company";
import { getBankingWorkspaceCounts } from "@/lib/banking/banking.functions";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

const items = [
  { to: "/banking", label: "Accounts", exact: true as const },
  { to: "/banking/transactions", label: "For review", search: { status: "uncategorised" }, countKey: "uncategorised" as const },
  { to: "/banking/cash-coding", label: "Cash coding", countKey: "uncategorised" as const },
  { to: "/banking/transactions", label: "All transactions", search: { status: "all" } },
  { to: "/banking/transactions", label: "Posted", search: { statusGroup: "posted" }, countKey: "posted" as const },
  { to: "/banking/transactions", label: "Reconciled", search: { status: "reconciled" }, countKey: "reconciled" as const },
  { to: "/banking/transactions", label: "Unreconciled", search: { statusGroup: "unreconciled" }, countKey: "unreconciled" as const },
  { to: "/banking/transactions", label: "Excluded", search: { status: "excluded" }, countKey: "excluded" as const },
  { to: "/banking/transfers", label: "Transfers" },
  { to: "/banking/reconcile", label: "Reconcile" },
  { to: "/banking/rules", label: "Rules" },
  { to: "/banking/import", label: "Import CSV" },
  { to: "/banking/feeds", label: "Feeds" },
] as const;

export function BankingSubnav() {
  const { company } = useActiveCompany();
  const fetchCounts = useServerFn(getBankingWorkspaceCounts);
  const countsQ = useQuery({
    queryKey: ["banking-counts", company?.id],
    enabled: Boolean(company?.id),
    queryFn: () => fetchCounts({ data: { companyId: company!.id } }),
    staleTime: 15_000,
  });
  const counts = countsQ.data;

  return (
    <nav className="mb-6 flex gap-1 overflow-x-auto border-b border-border pb-px">
      {items.map((item) => {
        const countKey = "countKey" in item ? item.countKey : undefined;
        const count = countKey && counts ? counts[countKey] : undefined;
        const search = "search" in item ? item.search : undefined;
        return (
          <Link
            key={`${item.to}-${item.label}`}
            to={item.to as never}
            search={search as never}
            activeOptions={{ exact: "exact" in item ? item.exact : false }}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-t-md px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground",
            )}
            activeProps={{
              className: "border-b-2 border-primary text-foreground",
            }}
          >
            {item.label}
            {typeof count === "number" ? (
              <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                {count}
              </Badge>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
