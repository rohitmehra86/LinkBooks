import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useActiveCompany } from "@/hooks/use-active-company";
import { listCreditNotes } from "@/lib/sales/sales.functions";
import { fromMinorUnits } from "@/lib/accounting/money";
import { friendlyAuthError } from "@/lib/auth-helpers";
import { PageHeader, LoadingState, ErrorState, EmptyState } from "@/components/common/states";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/sales/credit-notes/")({
  head: () => ({ meta: [{ title: "Credit notes — LinkBooks" }] }),
  component: CreditNotesList,
});

function CreditNotesList() {
  const { company } = useActiveCompany();
  const companyId = company?.id;
  const currency = company?.base_currency ?? "GBP";
  const fetch = useServerFn(listCreditNotes);
  const query = useQuery({
    queryKey: ["sales-credits", companyId],
    enabled: Boolean(companyId),
    queryFn: () => fetch({ data: { companyId: companyId! } }),
  });
  if (!companyId) return <EmptyState title="No organisation" description="Select a company." />;
  return (
    <>
      <PageHeader title="Credit notes" description="Authorising posts a reversing AR journal. Allocate to invoices without a second posting."
        actions={<Button size="sm" asChild><Link to="/sales/credit-notes/new">New credit note</Link></Button>} />
      {query.isPending ? <LoadingState /> : query.isError ? (
        <ErrorState title="Could not load credit notes" description={friendlyAuthError(query.error)} />
      ) : (query.data ?? []).length === 0 ? (
        <EmptyState title="No credit notes" description="Create a customer credit note." />
      ) : (
        <Table>
          <TableHeader><TableRow>
            <TableHead>Date</TableHead><TableHead>Customer</TableHead><TableHead>Status</TableHead>
            <TableHead className="text-right">Total</TableHead><TableHead className="text-right">Allocated</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {(query.data as Array<{ id: string; credit_date: string; status: string; total_minor: number; amount_allocated_minor: number; contacts: { name: string } | null }>).map((c) => (
              <TableRow key={c.id}>
                <TableCell>{c.credit_date}</TableCell>
                <TableCell>{c.contacts?.name ?? "—"}</TableCell>
                <TableCell><Badge variant="secondary">{c.status}</Badge></TableCell>
                <TableCell className="text-right">{fromMinorUnits(c.total_minor, currency)}</TableCell>
                <TableCell className="text-right">{fromMinorUnits(c.amount_allocated_minor, currency)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
