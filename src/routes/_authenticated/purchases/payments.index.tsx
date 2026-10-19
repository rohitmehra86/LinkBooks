import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listPayments } from "@/lib/purchases/purchases.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/purchases/payments/")({
  head: () => ({ meta: [{ title: "Supplier payments — LinkBooks" }] }),
  component: PaymentsList,
});

function PaymentsList() {
  const { company } = useActiveCompany();
  const fetchPayments = useServerFn(listPayments);
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const query = useQuery({
    queryKey: ["payments", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetchPayments({ data: { companyId: companyId! } }),
  });

  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;

  return (
    <>
      <PageHeader
        title="Supplier payments"
        description="Full or partial payments allocated to authorised bills. Overpayments remain unallocated on the payment."
        actions={
          <Button size="sm" asChild>
            <Link to="/purchases/payments/new">New payment</Link>
          </Button>
        }
      />
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState title="Could not load payments" description={friendlyAuthError(query.error)} />
      ) : (query.data ?? []).length === 0 ? (
        <EmptyState title="No payments" description="Record a payment against open bills." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Supplier</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className="text-right">Unallocated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(
              query.data as Array<{
                id: string;
                payment_date: string;
                status: string;
                amount_minor: number;
                unallocated_minor: number;
                contacts: { name: string } | null;
              }>
            ).map((p) => (
              <TableRow key={p.id}>
                <TableCell>{p.payment_date}</TableCell>
                <TableCell>{p.contacts?.name ?? "—"}</TableCell>
                <TableCell>
                  <Badge variant="outline" className="capitalize">
                    {p.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  {fromMinorUnits(BigInt(p.amount_minor), currency)}
                </TableCell>
                <TableCell className="text-right">
                  {fromMinorUnits(BigInt(p.unallocated_minor), currency)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
