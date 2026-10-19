import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listBills } from "@/lib/purchases/purchases.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

export const Route = createFileRoute("/_authenticated/purchases/bills/")({
  head: () => ({ meta: [{ title: "Bills — LinkBooks" }] }),
  component: BillsList,
});

function BillsList() {
  const { company } = useActiveCompany();
  const fetchBills = useServerFn(listBills);
  const [status, setStatus] = useState<string>("all");
  const [q, setQ] = useState("");
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";

  const query = useQuery({
    queryKey: ["bills", companyId, status, q],
    enabled: Boolean(companyId),
    queryFn: () =>
      fetchBills({
        data: {
          companyId: companyId!,
          ...(status !== "all" ? { status } : {}),
          ...(q ? { q } : {}),
        },
      }),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  return (
    <>
      <PageHeader
        title="Bills"
        description="Supplier bills. Authorising posts Accounts Payable through the shared ledger."
        actions={
          <Button size="sm" asChild>
            <Link to="/purchases/bills/new">New bill</Link>
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap gap-3">
        <Input
          placeholder="Search…"
          className="max-w-xs"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <Select value={status} onValueChange={setStatus}>
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
          title="Could not load bills"
          description={friendlyAuthError(query.error)}
          onRetry={() => query.refetch()}
        />
      ) : (query.data ?? []).length === 0 ? (
        <EmptyState
          title="No bills"
          description="Create a supplier bill, then authorise it to post AP."
          actionLabel="New bill"
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Supplier</TableHead>
              <TableHead>Invoice #</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Outstanding</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(
              query.data as Array<{
                id: string;
                bill_date: string;
                supplier_invoice_number: string | null;
                status: string;
                total_minor: number;
                amount_paid_minor: number;
                amount_credited_minor: number;
                contacts: { name: string } | null;
              }>
            ).map((b) => {
              const outstanding = b.total_minor - b.amount_paid_minor - b.amount_credited_minor;
              return (
                <TableRow key={b.id}>
                  <TableCell>
                    <Link className="font-medium hover:underline" to="/purchases/bills/$billId" params={{ billId: b.id }}>
                      {b.bill_date}
                    </Link>
                  </TableCell>
                  <TableCell>{b.contacts?.name ?? "—"}</TableCell>
                  <TableCell>{b.supplier_invoice_number ?? "—"}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">
                      {b.status.replace("_", " ")}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {fromMinorUnits(BigInt(b.total_minor), currency)}
                  </TableCell>
                  <TableCell className="text-right">
                    {fromMinorUnits(BigInt(outstanding), currency)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </>
  );
}
