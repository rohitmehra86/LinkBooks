import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveCompany } from "@/hooks/use-active-company";
import { getSalesOverview, listInvoices } from "@/lib/sales/sales.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { StatCard } from "@/components/common/stat-card";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/sales/")({
  head: () => ({
    meta: [
      { title: "Sales — LinkBooks" },
      { name: "description", content: "Customer invoices, receipts and credit notes." },
    ],
  }),
  component: SalesOverview,
});

function SalesOverview() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const fetchOverview = useServerFn(getSalesOverview);
  const fetchInvoices = useServerFn(listInvoices);

  const overviewQ = useQuery({
    queryKey: ["sales-overview", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchOverview({ data: { companyId: companyId! } }),
  });
  const invoicesQ = useQuery({
    queryKey: ["sales-invoices-recent", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchInvoices({ data: { companyId: companyId!, page: 0 } }),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  return (
    <>
      <PageHeader
        title="Sales"
        description="Quotes, invoices, receipts and credit notes post through the shared ledger."
        actions={
          <>
            <Button variant="outline" size="sm" asChild>
              <Link to="/sales/receipts/new">Record receipt</Link>
            </Button>
            <Button size="sm" asChild>
              <Link to="/sales/invoices/new">New invoice</Link>
            </Button>
          </>
        }
      />

      {overviewQ.isPending ? (
        <LoadingState />
      ) : overviewQ.isError ? (
        <ErrorState
          title="Could not load overview"
          description={friendlyAuthError(overviewQ.error)}
          onRetry={() => overviewQ.refetch()}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard label="Draft" value={String(overviewQ.data.draftCount)} hint="Draft invoices" />
          <StatCard
            label="Awaiting payment"
            value={fromMinorUnits(BigInt(overviewQ.data.awaitingMinor), currency)}
            hint={currency}
          />
          <StatCard
            label="Overdue"
            value={fromMinorUnits(BigInt(overviewQ.data.overdueMinor), currency)}
            hint={currency}
          />
        </div>
      )}

      <h2 className="mt-8 mb-3 text-sm font-medium text-muted-foreground">Recent invoices</h2>
      {invoicesQ.isPending ? (
        <LoadingState />
      ) : invoicesQ.isError ? (
        <ErrorState title="Could not load invoices" description={friendlyAuthError(invoicesQ.error)} />
      ) : (invoicesQ.data?.rows ?? []).length === 0 ? (
        <EmptyState
          title="No invoices yet"
          description="Create a customer invoice to start posting receivables."
          actionLabel="New invoice"
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(invoicesQ.data!.rows as Array<{
              id: string;
              invoice_date: string;
              status: string;
              total_minor: number;
              contacts: { name: string } | null;
            }>).slice(0, 10).map((inv) => (
              <TableRow key={inv.id}>
                <TableCell>
                  <Link to="/sales/invoices/$invoiceId" params={{ invoiceId: inv.id }} className="underline-offset-2 hover:underline">
                    {inv.invoice_date}
                  </Link>
                </TableCell>
                <TableCell>{inv.contacts?.name ?? "—"}</TableCell>
                <TableCell>
                  <Badge variant="secondary">{inv.status}</Badge>
                </TableCell>
                <TableCell className="text-right">
                  {fromMinorUnits(BigInt(inv.total_minor), currency)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
