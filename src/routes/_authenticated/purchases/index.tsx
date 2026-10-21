import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listBills, listExpenses, listPayments } from "@/lib/purchases/purchases.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { PageHeader, LoadingState, EmptyState } from "@/components/common/states";
import { StatCard } from "@/components/common/stat-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/_authenticated/purchases/")({
  head: () => ({ meta: [{ title: "Purchases — LinkBooks" }] }),
  component: PurchasesOverview,
});

function PurchasesOverview() {
  const { company, isPending } = useActiveCompany();
  const fetchBills = useServerFn(listBills);
  const fetchExpenses = useServerFn(listExpenses);
  const fetchPayments = useServerFn(listPayments);

  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";

  const billsQ = useQuery({
    queryKey: ["bills", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchBills({ data: { companyId: companyId!, limit: 100 } }),
  });
  const expensesQ = useQuery({
    queryKey: ["expenses", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchExpenses({ data: { companyId: companyId! } }),
  });
  const paymentsQ = useQuery({
    queryKey: ["payments", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchPayments({ data: { companyId: companyId! } }),
  });

  if (isPending) return <LoadingState />;
  if (!companyId) {
    return <EmptyState title="No organisation" description="Create an organisation first." />;
  }

  const billsPayload = billsQ.data as { rows?: unknown[] } | unknown[] | undefined;
  const bills = (
    Array.isArray(billsPayload) ? billsPayload : (billsPayload?.rows ?? [])
  ) as Array<{
    status: string;
    total_minor: number;
    amount_paid_minor: number;
    amount_credited_minor: number;
  }>;
  const toPay = bills
    .filter((b) => ["authorised", "partly_paid"].includes(b.status))
    .reduce((s, b) => s + (b.total_minor - b.amount_paid_minor - b.amount_credited_minor), 0);

  return (
    <>
      <PageHeader
        title="Purchases"
        description="Supplier bills, direct expenses, payments, credits, orders and recurring purchases — posted through the shared ledger."
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link to="/purchases/expenses/new">New expense</Link>
            </Button>
            <Button size="sm" asChild>
              <Link to="/purchases/bills/new">New bill</Link>
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Bills to pay"
          value={fromMinorUnits(BigInt(toPay), currency)}
          hint={`${bills.filter((b) => ["authorised", "partly_paid"].includes(b.status)).length} open`}
        />
        <StatCard
          label="Payments recorded"
          value={String((paymentsQ.data ?? []).length)}
          hint="Supplier payments"
        />
        <StatCard
          label="Direct expenses"
          value={String((expensesQ.data ?? []).length)}
          hint="Paid immediately (not AP bills)"
        />
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {[
          { title: "Bills", to: "/purchases/bills", desc: "Supplier invoices → AP on authorise" },
          { title: "Expenses", to: "/purchases/expenses", desc: "Paid now from bank/cash" },
          { title: "Payments", to: "/purchases/payments", desc: "Allocate cash to bills" },
          { title: "Credit notes", to: "/purchases/credit-notes", desc: "Reduce AP / expenses" },
          { title: "Purchase orders", to: "/purchases/orders", desc: "No ledger until billed" },
          { title: "Recurring", to: "/purchases/recurring", desc: "Generate draft bills" },
          {
            title: "Employee expenses",
            to: "/purchases/employee-expenses",
            desc: "Submit → approve → reimburse",
          },
          { title: "Statements", to: "/purchases/statements", desc: "Supplier balances" },
        ].map((c) => (
          <Card key={c.to}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                <Link to={c.to} className="hover:underline">
                  {c.title}
                </Link>
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">{c.desc}</CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
