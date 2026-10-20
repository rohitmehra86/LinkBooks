import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listCreditNotes } from "@/lib/purchases/purchases.functions";
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

export const Route = createFileRoute("/_authenticated/purchases/credit-notes/")({
  component: CreditNotesList,
});

function CreditNotesList() {
  const { company } = useActiveCompany();
  const fetch = useServerFn(listCreditNotes);
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const query = useQuery({
    queryKey: ["credits", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetch({ data: { companyId: companyId! } }),
  });
  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  return (
    <>
      <PageHeader
        title="Supplier credit notes"
        description="Authorising posts DR AP / CR expense+tax. Allocate to open bills to reduce outstanding."
        actions={
          <Button size="sm" asChild>
            <Link to="/purchases/credit-notes/new">New credit note</Link>
          </Button>
        }
      />
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState title="Could not load credit notes" description={friendlyAuthError(query.error)} />
      ) : (query.data ?? []).length === 0 ? (
        <EmptyState title="No credit notes" description="Create a supplier credit note." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Supplier</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Allocated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(
              query.data as Array<{
                id: string;
                credit_date: string;
                status: string;
                total_minor: number;
                amount_allocated_minor: number;
                contacts: { name: string } | null;
              }>
            ).map((c) => (
              <TableRow key={c.id}>
                <TableCell>
                  <Link
                    className="underline-offset-2 hover:underline"
                    to="/purchases/credit-notes/$creditNoteId"
                    params={{ creditNoteId: c.id }}
                  >
                    {c.credit_date}
                  </Link>
                </TableCell>
                <TableCell>{c.contacts?.name ?? "—"}</TableCell>
                <TableCell>
                  <Badge variant="outline" className="capitalize">
                    {c.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-right">
                  {fromMinorUnits(BigInt(c.total_minor), currency)}
                </TableCell>
                <TableCell className="text-right">
                  {fromMinorUnits(BigInt(c.amount_allocated_minor), currency)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
