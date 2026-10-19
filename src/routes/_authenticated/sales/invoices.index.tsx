import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listInvoices } from "@/lib/sales/sales.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/sales/invoices/")({
  head: () => ({ meta: [{ title: "Invoices — LinkBooks" }] }),
  component: InvoicesList,
});

function InvoicesList() {
  const { company } = useActiveCompany();
  const fetchInvoices = useServerFn(listInvoices);
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(0);
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";

  const query = useQuery({
    queryKey: ["sales-invoices", companyId, status, page],
    enabled: Boolean(companyId),
    queryFn: () =>
      fetchInvoices({
        data: {
          companyId: companyId!,
          page,
          ...(status !== "all" ? { status } : {}),
        },
      }),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  const rows = (query.data?.rows ?? []) as Array<{
    id: string;
    invoice_number: string | null;
    invoice_date: string;
    due_date: string;
    status: string;
    total_minor: number;
    amount_paid_minor: number;
    amount_credited_minor: number;
    contacts: { name: string } | null;
  }>;

  return (
    <>
      <PageHeader
        title="Invoices"
        description="Customer invoices. Authorising posts Accounts Receivable via the shared ledger."
        actions={
          <Button size="sm" asChild>
            <Link to="/sales/invoices/new">New invoice</Link>
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap gap-3">
        <Select value={status} onValueChange={(v) => { setStatus(v); setPage(0); }}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="authorised">Authorised</SelectItem>
            <SelectItem value="partly_paid">Partly paid</SelectItem>
            <SelectItem value="paid">Paid</SelectItem>
            <SelectItem value="void">Void</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState
          title="Could not load invoices"
          description={friendlyAuthError(query.error)}
          onRetry={() => query.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No invoices"
          description="Create a customer invoice to start."
          actionLabel="New invoice"
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Due</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Outstanding</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((inv) => {
                const out =
                  inv.total_minor - inv.amount_paid_minor - inv.amount_credited_minor;
                return (
                  <TableRow key={inv.id}>
                    <TableCell>
                      <Link
                        to="/sales/invoices/$invoiceId"
                        params={{ invoiceId: inv.id }}
                        className="underline-offset-2 hover:underline"
                      >
                        {inv.invoice_number ?? inv.id.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell>{inv.invoice_date}</TableCell>
                    <TableCell>{inv.due_date}</TableCell>
                    <TableCell>{inv.contacts?.name ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{inv.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {fromMinorUnits(BigInt(Math.max(0, out)), currency)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <div className="mt-4 flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={rows.length < (query.data?.pageSize ?? 50)}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </>
      )}
    </>
  );
}
