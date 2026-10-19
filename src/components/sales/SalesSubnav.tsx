import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

const items = [
  { to: "/sales", label: "Overview", exact: true },
  { to: "/sales/invoices", label: "Invoices" },
  { to: "/sales/quotes", label: "Quotes" },
  { to: "/sales/receipts", label: "Receipts" },
  { to: "/sales/credit-notes", label: "Credit notes" },
  { to: "/sales/customers", label: "Customers" },
  { to: "/sales/recurring", label: "Recurring" },
  { to: "/sales/statements", label: "Statements" },
  { to: "/sales/settings", label: "Settings" },
] as const;

export function SalesSubnav() {
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
