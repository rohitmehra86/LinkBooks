import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

const items = [
  { to: "/purchases", label: "Overview", exact: true },
  { to: "/purchases/bills", label: "Bills" },
  { to: "/purchases/expenses", label: "Expenses" },
  { to: "/purchases/suppliers", label: "Suppliers" },
  { to: "/purchases/payments", label: "Payments" },
  { to: "/purchases/credit-notes", label: "Credit notes" },
  { to: "/purchases/orders", label: "Purchase orders" },
  { to: "/purchases/recurring", label: "Recurring" },
  { to: "/purchases/employee-expenses", label: "Employee expenses" },
  { to: "/purchases/statements", label: "Statements" },
] as const;

export function PurchasesSubnav() {
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
