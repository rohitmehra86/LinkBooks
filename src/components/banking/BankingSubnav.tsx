import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

const items = [
  { to: "/banking", label: "Accounts", exact: true },
  { to: "/banking/transactions", label: "Transactions" },
  { to: "/banking/import", label: "Import CSV" },
  { to: "/banking/transfers", label: "Transfers" },
  { to: "/banking/reconcile", label: "Reconcile" },
  { to: "/banking/rules", label: "Rules" },
] as const;

export function BankingSubnav() {
  return (
    <nav className="mb-6 flex gap-1 overflow-x-auto border-b border-border pb-px">
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          activeOptions={{ exact: "exact" in item ? item.exact : false }}
          className={cn(
            "shrink-0 rounded-t-md px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground",
          )}
          activeProps={{
            className: "border-b-2 border-primary text-foreground",
          }}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
