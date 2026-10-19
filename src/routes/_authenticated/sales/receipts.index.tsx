import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listReceipts } from "@/lib/sales/sales.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/sales/receipts/")({
  head: () => ({ meta: [{ title: "Receipts — LinkBooks" }] }),
  component: ReceiptsList,
});

function ReceiptsList() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const fetch = useServerFn(listReceipts);
  const query = useQuery({
    queryKey: ["sales-receipts", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetch({ data: { companyId: companyId! } }),
  });
  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  return (
    <>
      <PageHeader title="Receipts" description="Customer payments allocated to invoices. Overpayments stay unallocated."
        actions={<Button size="sm" asChild><Link to="/sales/receipts/new">Record receipt</Link></Button>} />
      {query.isPending ? <LoadingState /> : query.isError ? (
        <ErrorState title="Could not load receipts" description={friendlyAuthError(query.error)} />
      ) : (query.data ?? []).length === 0 ? (
        <EmptyState title="No receipts" description="Record a customer payment." />
      ) : (
        <Table>
          <TableHeader><TableRow>
            <TableHead>Date</TableHead><TableHead>Customer</TableHead><TableHead>Status</TableHead>
            <TableHead className="text-right">Amount</TableHead><TableHead className="text-right">Unallocated</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {(query.data as Array<{ id: string; receipt_date: string; amount_minor: number; unallocated_minor: number; status: string; contacts: { name: string } | null }>).map((r) => (
              <TableRow key={r.id}>
                <TableCell>{r.receipt_date}</TableCell>
                <TableCell>{r.contacts?.name ?? "—"}</TableCell>
                <TableCell><Badge variant="secondary">{r.status}</Badge></TableCell>
                <TableCell className="text-right">{fromMinorUnits(r.amount_minor, currency)}</TableCell>
                <TableCell className="text-right">{fromMinorUnits(r.unallocated_minor, currency)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
